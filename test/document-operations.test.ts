/**
 * Tests for DocumentOperations
 *
 * Covers:
 *   • splice correctly inserts, deletes, replaces text
 *   • addCommentThread creates thread with cursor that follows edits
 *   • replyToCommentThread appends reply; ignores non-existent thread
 *   • resolveCommentThread marks resolved; resolved threads excluded from positions
 *   • uploadAsset writes to AssetsDoc; deleteAsset removes
 *   • extractTitle parses frontmatter and H1
 *   • initDocument / initAssetsDoc / initFolderDoc
 */
import { describe, it, expect } from "vitest";
import { next as Automerge } from "@automerge/automerge";
import {
  splice,
  uploadAsset,
  deleteAsset,
  addCommentThread,
  replyToCommentThread,
  resolveCommentThread,
  folderRename,
  folderAddDoc,
  folderRemoveDoc,
  initDocument,
  initAssetsDoc,
  initFolderDoc,
  extractTitle,
  resolveCommentThreadPositions,
} from "../src/document-operations.js";
import type { MarkdownDoc, AssetsDoc, FolderDoc } from "../src/schema.js";

function createEmptyMarkdownDoc(): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(Automerge.init<MarkdownDoc>(), (d) => {
    d.content = "";
    d.commentThreads = {};
    d.assetsDocUrl = "automerge:test-assets" as any;
  });
}

function createMarkdownDocWithContent(content: string): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(Automerge.init<MarkdownDoc>(), (d) => {
    d.content = content;
    d.commentThreads = {};
    d.assetsDocUrl = "automerge:test-assets" as any;
  });
}

function createEmptyAssetsDoc(): Automerge.Doc<AssetsDoc> {
  return Automerge.change(Automerge.init<AssetsDoc>(), (d) => {
    d.files = {};
  });
}

function createEmptyFolderDoc(): Automerge.Doc<FolderDoc> {
  return Automerge.change(Automerge.init<FolderDoc>(), (d) => {
    d.title = "";
    d.docs = [];
  });
}

// ---------------------------------------------------------------------------
// Text operations
// ---------------------------------------------------------------------------

describe("splice", () => {
  it("inserts text at the beginning", () => {
    const doc = createMarkdownDocWithContent("World");
    const result = splice(doc, { type: "textSplice", index: 0, deleteCount: 0, insert: "Hello " });
    expect(result.content).toBe("Hello World");
  });

  it("deletes text", () => {
    const doc = createMarkdownDocWithContent("Hello World");
    const result = splice(doc, { type: "textSplice", index: 5, deleteCount: 6, insert: "" });
    expect(result.content).toBe("Hello");
  });

  it("replaces text", () => {
    const doc = createMarkdownDocWithContent("Hello World");
    const result = splice(doc, { type: "textSplice", index: 6, deleteCount: 5, insert: "Automerge" });
    expect(result.content).toBe("Hello Automerge");
  });

  it("appends text at the end", () => {
    const doc = createMarkdownDocWithContent("Hello");
    const result = splice(doc, { type: "textSplice", index: 5, deleteCount: 0, insert: " World" });
    expect(result.content).toBe("Hello World");
  });
});

// ---------------------------------------------------------------------------
// Asset operations
// ---------------------------------------------------------------------------

describe("uploadAsset", () => {
  it("writes file entry to AssetsDoc", () => {
    const assetsDoc = createEmptyAssetsDoc();
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const { assetsDoc: updated } = uploadAsset(assetsDoc, null, {
      type: "assetUpload",
      filename: "test.png",
      contentType: "image/png",
      data,
    });

    expect(updated.files["test.png"]).toBeDefined();
    expect(updated.files["test.png"].contentType).toBe("image/png");
  });

  it("inserts markdown reference when insertAtIndex is provided", () => {
    const assetsDoc = createEmptyAssetsDoc();
    const markdownDoc = createMarkdownDocWithContent("# Hello\n\n");
    const data = new Uint8Array([0x89, 0x50]);

    const { markdownDoc: updated } = uploadAsset(assetsDoc, markdownDoc, {
      type: "assetUpload",
      filename: "img.png",
      contentType: "image/png",
      data,
      insertAtIndex: 9,
    });

    expect(updated!.content).toContain("![](assets/img.png)");
  });
});

describe("deleteAsset", () => {
  it("removes file from AssetsDoc", () => {
    let assetsDoc = createEmptyAssetsDoc();
    assetsDoc = Automerge.change(assetsDoc, (d) => {
      d.files["test.png"] = { contentType: "image/png", contents: new Uint8Array([1]) };
    });

    const result = deleteAsset(assetsDoc, { type: "assetDelete", filename: "test.png" });
    expect(result.files["test.png"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Comment operations
// ---------------------------------------------------------------------------

describe("addCommentThread", () => {
  it("creates a thread with cursor anchors", () => {
    const doc = createMarkdownDocWithContent("Hello World, this is a test.");
    const result = addCommentThread(doc, {
      type: "addCommentThread",
      threadId: "thread-1",
      from: 6,
      to: 11,
      initialComment: "Nice word!",
    });

    expect(result.commentThreads["thread-1"]).toBeDefined();
    expect(result.commentThreads["thread-1"].comments.length).toBe(1);
    expect(result.commentThreads["thread-1"].comments[0].content).toBe("Nice word!");
    expect(result.commentThreads["thread-1"].resolved).toBe(false);
    expect(result.commentThreads["thread-1"].fromCursor).toBeDefined();
    expect(result.commentThreads["thread-1"].toCursor).toBeDefined();
  });

  it("cursor follows text edits", () => {
    let doc = createMarkdownDocWithContent("Hello World");
    doc = addCommentThread(doc, {
      type: "addCommentThread",
      threadId: "thread-1",
      from: 6,
      to: 10,
      initialComment: "Commenting on 'Worl'",
    });

    // Insert text before the comment range
    doc = splice(doc, { type: "textSplice", index: 0, deleteCount: 0, insert: ">>> " });

    // Resolve positions — they should have shifted by 4
    const threads = resolveCommentThreadPositions(doc, null);
    expect(threads.length).toBe(1);
    expect(threads[0].from).toBe(10); // 6 + 4
    expect(threads[0].to).toBe(14);   // 10 + 4
  });
});

describe("replyToCommentThread", () => {
  it("appends a reply to existing thread", () => {
    let doc = createMarkdownDocWithContent("Hello World");
    doc = addCommentThread(doc, {
      type: "addCommentThread",
      threadId: "thread-1",
      from: 0,
      to: 4,
      initialComment: "First comment",
    });

    doc = replyToCommentThread(doc, {
      type: "replyToComment",
      threadId: "thread-1",
      commentId: "reply-1",
      content: "Reply content",
    });

    expect(doc.commentThreads["thread-1"].comments.length).toBe(2);
    expect(doc.commentThreads["thread-1"].comments[1].content).toBe("Reply content");
  });

  it("silently ignores reply to non-existent thread", () => {
    const doc = createMarkdownDocWithContent("Hello");
    const result = replyToCommentThread(doc, {
      type: "replyToComment",
      threadId: "non-existent",
      commentId: "reply-1",
      content: "This should be ignored",
    });

    // Should return the same doc unchanged
    expect(result).toBe(doc);
  });
});

describe("resolveCommentThread", () => {
  it("marks thread as resolved", () => {
    let doc = createMarkdownDocWithContent("Hello World");
    doc = addCommentThread(doc, {
      type: "addCommentThread",
      threadId: "thread-1",
      from: 0,
      to: 4,
      initialComment: "Comment",
    });

    doc = resolveCommentThread(doc, {
      type: "resolveCommentThread",
      threadId: "thread-1",
    });

    expect(doc.commentThreads["thread-1"].resolved).toBe(true);
  });

  it("resolved threads are excluded from resolveCommentThreadPositions", () => {
    let doc = createMarkdownDocWithContent("Hello World");
    doc = addCommentThread(doc, {
      type: "addCommentThread",
      threadId: "thread-1",
      from: 0,
      to: 4,
      initialComment: "Comment",
    });

    doc = resolveCommentThread(doc, {
      type: "resolveCommentThread",
      threadId: "thread-1",
    });

    const threads = resolveCommentThreadPositions(doc, null);
    expect(threads.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

describe("folder operations", () => {
  it("folderRename updates title", () => {
    const doc = createEmptyFolderDoc();
    const result = folderRename(
      initFolderDoc(doc, "Old Title"),
      { type: "folderRename", title: "New Title" }
    );
    expect(result.title).toBe("New Title");
  });

  it("folderAddDoc adds a document link", () => {
    let doc = initFolderDoc(createEmptyFolderDoc(), "My Folder");
    doc = folderAddDoc(doc, {
      type: "folderAddDoc",
      name: "My Essay",
      docType: "essay",
      url: "automerge:doc-123" as any,
    });

    expect(doc.docs.length).toBe(1);
    expect(doc.docs[0].name).toBe("My Essay");
    expect(doc.docs[0].type).toBe("essay");
  });

  it("folderRemoveDoc removes a document link", () => {
    let doc = initFolderDoc(createEmptyFolderDoc(), "My Folder");
    const url = "automerge:doc-123" as any;
    doc = folderAddDoc(doc, {
      type: "folderAddDoc",
      name: "My Essay",
      docType: "essay",
      url,
    });

    doc = folderRemoveDoc(doc, { type: "folderRemoveDoc", url });
    expect(doc.docs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Document initialisation
// ---------------------------------------------------------------------------

describe("initDocument", () => {
  it("initialises with default content aligned with TEE", () => {
    const doc = Automerge.init<MarkdownDoc>();
    const result = initDocument(doc, "automerge:assets-url");

    expect(result.content).toBe("# Untitled\n\n");
    expect(result.commentThreads).toEqual({});
    expect(result.assetsDocUrl).toBe("automerge:assets-url");
  });
});

describe("initAssetsDoc", () => {
  it("initialises with empty files", () => {
    const doc = Automerge.init<AssetsDoc>();
    const result = initAssetsDoc(doc);
    expect(result.files).toEqual({});
  });
});

describe("initFolderDoc", () => {
  it("initialises with title and empty docs", () => {
    const doc = Automerge.init<FolderDoc>();
    const result = initFolderDoc(doc, "My Folder");
    expect(result.title).toBe("My Folder");
    expect(result.docs).toEqual([]);
  });

  it("uses default title when none provided", () => {
    const doc = Automerge.init<FolderDoc>();
    const result = initFolderDoc(doc);
    expect(result.title).toBe("Untitled Folder");
  });
});

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe("extractTitle", () => {
  it("extracts title from YAML frontmatter", () => {
    const content = '---\ntitle: "My Essay"\nsubtitle: "A Subtitle"\n---\n\n# Heading\n';
    expect(extractTitle(content)).toBe("My Essay");
  });

  it("falls back to first H1 when no frontmatter", () => {
    const content = "# My Heading\n\nSome content.";
    expect(extractTitle(content)).toBe("My Heading");
  });

  it("returns Untitled when no title found", () => {
    const content = "Just some text without headings.";
    expect(extractTitle(content)).toBe("Untitled");
  });
});
