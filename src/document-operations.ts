/**
 * DocumentOperations
 *
 * Stateless functions that apply typed operations to Automerge document handles.
 * Each function maps an operation to the correct Automerge primitives:
 *   • splice for character-level text edits
 *   • getCursor / getCursorPosition for comment anchoring
 *   • direct property mutation for assets, folders, metadata
 *
 * These functions are the *only* sanctioned way to mutate documents.
 * Direct Automerge.change() calls elsewhere are forbidden.
 */
import { next as Automerge } from "@automerge/automerge";
import type {
  MarkdownDoc,
  AssetsDoc,
  FolderDoc,
  CommentThreadForUI,
} from "./schema.js";
import type {
  TextSpliceOperation,
  AssetUploadOperation,
  AssetDeleteOperation,
  AddCommentThreadOperation,
  ReplyToCommentOperation,
  ResolveCommentOperation,
  FolderRenameOperation,
  FolderAddDocOperation,
  FolderRemoveDocOperation,
} from "./operations.js";

// ---------------------------------------------------------------------------
// Text operations
// ---------------------------------------------------------------------------

/**
 * Character-level text edit via Automerge.splice.
 * Never use `doc.content = newString` — that destroys CRDT history.
 */
export function splice(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: TextSpliceOperation
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (d) => {
    Automerge.splice(d, ["content"], operation.index, operation.deleteCount, operation.insert);
  });
}

// ---------------------------------------------------------------------------
// Asset operations
// ---------------------------------------------------------------------------

/**
 * Upload a binary asset into AssetsDoc.files.
 * Optionally inserts a Markdown image reference into the body.
 */
export function uploadAsset(
  assetsDoc: Automerge.Doc<AssetsDoc>,
  markdownDoc: Automerge.Doc<MarkdownDoc> | null,
  operation: AssetUploadOperation
): { assetsDoc: Automerge.Doc<AssetsDoc>; markdownDoc: Automerge.Doc<MarkdownDoc> | null } {
  const newAssetsDoc = Automerge.change(assetsDoc, (d) => {
    d.files[operation.filename] = {
      contentType: operation.contentType,
      contents: operation.data,
    };
  });

  let newMarkdownDoc = markdownDoc;
  if (markdownDoc && operation.insertAtIndex !== undefined) {
    const imageRef = `![](assets/${operation.filename})`;
    newMarkdownDoc = Automerge.change(markdownDoc, (d) => {
      Automerge.splice(d, ["content"], operation.insertAtIndex!, 0, imageRef);
    });
  }

  return { assetsDoc: newAssetsDoc, markdownDoc: newMarkdownDoc };
}

/**
 * Delete an asset from AssetsDoc.files.
 */
export function deleteAsset(
  assetsDoc: Automerge.Doc<AssetsDoc>,
  operation: AssetDeleteOperation
): Automerge.Doc<AssetsDoc> {
  return Automerge.change(assetsDoc, (d) => {
    delete d.files[operation.filename];
  });
}

// ---------------------------------------------------------------------------
// Comment / collaboration operations
// ---------------------------------------------------------------------------

/**
 * Create a new comment thread anchored to a text range.
 * Uses Automerge Cursors so the anchor follows text edits automatically.
 */
export function addCommentThread(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: AddCommentThreadOperation
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (d) => {
    const fromCursor = Automerge.getCursor(d, ["content"], operation.from);
    const toCursor = Automerge.getCursor(d, ["content"], operation.to);

    const comment: Record<string, unknown> = {
      id: `${operation.threadId}-0`,
      content: operation.initialComment,
      timestamp: Date.now(),
    };
    if (operation.contactUrl !== undefined) {
      comment.contactUrl = operation.contactUrl;
    }

    d.commentThreads[operation.threadId] = {
      id: operation.threadId,
      comments: [comment as any],
      resolved: false,
      fromCursor,
      toCursor,
    };
  });
}

/**
 * Append a reply to an existing comment thread.
 * Silently ignores replies to non-existent threads.
 */
export function replyToCommentThread(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: ReplyToCommentOperation
): Automerge.Doc<MarkdownDoc> {
  if (!doc.commentThreads[operation.threadId]) {
    return doc;
  }

  return Automerge.change(doc, (d) => {
    const thread = d.commentThreads[operation.threadId];
    if (!thread) return;
    const reply: Record<string, unknown> = {
      id: operation.commentId,
      content: operation.content,
      timestamp: Date.now(),
    };
    if (operation.contactUrl !== undefined) {
      reply.contactUrl = operation.contactUrl;
    }
    thread.comments.push(reply as any);
  });
}

/**
 * Mark a comment thread as resolved. Does not delete history.
 */
export function resolveCommentThread(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: ResolveCommentOperation
): Automerge.Doc<MarkdownDoc> {
  if (!doc.commentThreads[operation.threadId]) {
    return doc;
  }

  return Automerge.change(doc, (d) => {
    const thread = d.commentThreads[operation.threadId];
    if (!thread) return;
    thread.resolved = true;
  });
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

export function folderRename(
  doc: Automerge.Doc<FolderDoc>,
  operation: FolderRenameOperation
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    d.title = operation.title;
  });
}

export function folderAddDoc(
  doc: Automerge.Doc<FolderDoc>,
  operation: FolderAddDocOperation
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    d.docs.push({
      name: operation.name,
      type: operation.docType,
      url: operation.url,
    });
  });
}

export function folderRemoveDoc(
  doc: Automerge.Doc<FolderDoc>,
  operation: FolderRemoveDocOperation
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    const index = d.docs.findIndex((link) => link.url === operation.url);
    if (index !== -1) {
      d.docs.splice(index, 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Document initialisation (aligned with TEE EssayDatatype.init)
// ---------------------------------------------------------------------------

/**
 * Initialise a new MarkdownDoc with default content.
 * Mirrors TEE's `init` function for full compatibility.
 */
export function initDocument(
  doc: Automerge.Doc<MarkdownDoc>,
  assetsDocUrl: string
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (d) => {
    d.content = "# Untitled\n\n";
    d.commentThreads = {};
    d.assetsDocUrl = assetsDocUrl as any;
  });
}

/**
 * Initialise a new AssetsDoc.
 */
export function initAssetsDoc(
  doc: Automerge.Doc<AssetsDoc>
): Automerge.Doc<AssetsDoc> {
  return Automerge.change(doc, (d) => {
    d.files = {};
  });
}

/**
 * Initialise a new FolderDoc.
 */
export function initFolderDoc(
  doc: Automerge.Doc<FolderDoc>,
  title = "Untitled Folder"
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    d.title = title;
    d.docs = [];
  });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Extract a title from document content.
 * Looks for YAML frontmatter `title:` first, then falls back to first H1.
 * Aligned with TEE's getTitle().
 */
export function extractTitle(content: string): string {
  // Try YAML frontmatter
  const frontmatterMatch = content.match(/---\n([\s\S]+?)\n---/);
  if (frontmatterMatch) {
    const titleMatch = frontmatterMatch[1].match(/title:\s"(.+?)"/);
    if (titleMatch) {
      return titleMatch[1];
    }
  }

  // Fall back to first Markdown H1
  const headingMatch = content.match(/(^|\n)#\s(.+)/);
  if (headingMatch) {
    return headingMatch[2];
  }

  return "Untitled";
}

/**
 * Resolve comment thread Automerge Cursors to integer positions.
 * Filters out resolved threads and threads pointing to deleted text.
 * Aligned with TEE's getThreadsForUI().
 */
export function resolveCommentThreadPositions(
  doc: Automerge.Doc<MarkdownDoc>,
  activeThreadId: string | null
): CommentThreadForUI[] {
  const threads = doc.commentThreads ?? {};

  return Object.values(threads)
    .filter((thread) => !thread.resolved)
    .flatMap((thread) => {
      let from = 0;
      let to = 0;
      try {
        from = Automerge.getCursorPosition(doc, ["content"], thread.fromCursor);
        to = Automerge.getCursorPosition(doc, ["content"], thread.toCursor);
      } catch (error) {
        if (error instanceof RangeError) {
          // Cursor not found — content string was entirely replaced
          return [];
        }
        throw error;
      }

      // Hide threads pointing to deleted text
      if (to <= from) return [];

      return [
        {
          ...thread,
          from,
          to,
          active: thread.id === activeThreadId,
        },
      ];
    });
}
