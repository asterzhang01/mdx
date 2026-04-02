/**
 * Document operation types for MarkdownX
 *
 * Every operation maps to an atomic Automerge change.
 * Operations are pure data objects — serialisable, replayable, idempotent
 * (idempotency guaranteed by Automerge actor + clock de-duplication).
 */
import type { AutomergeUrl } from "@automerge/automerge-repo";

// ---------------------------------------------------------------------------
// Text operations
// ---------------------------------------------------------------------------

/**
 * Character-level insert / delete / replace.
 * Maps directly to Automerge.splice(doc, ["content"], index, deleteCount, insert).
 * Whole-string replacement of `content` is forbidden — it destroys CRDT history.
 */
export type TextSpliceOperation = {
  type: "textSplice";
  /** Starting character index */
  index: number;
  /** Number of characters to delete (0 = pure insert) */
  deleteCount: number;
  /** Text to insert ("" = pure delete) */
  insert: string;
};

// ---------------------------------------------------------------------------
// Asset operations
// ---------------------------------------------------------------------------

/**
 * Upload a binary asset into AssetsDoc.files.
 * Optionally inserts a Markdown image reference into the body.
 */
export type AssetUploadOperation = {
  type: "assetUpload";
  /** SHA-256 hash-based filename, e.g. "a3f5c8d2.png" */
  filename: string;
  contentType: string;
  data: Uint8Array;
  /** If provided, insert ![](assets/<filename>) at this character index */
  insertAtIndex?: number;
};

/** Remove an asset from AssetsDoc.files. */
export type AssetDeleteOperation = {
  type: "assetDelete";
  filename: string;
};

// ---------------------------------------------------------------------------
// Comment / collaboration operations
// ---------------------------------------------------------------------------

/** Create a new comment thread anchored to a text range. */
export type AddCommentThreadOperation = {
  type: "addCommentThread";
  threadId: string;
  /** Start character index (will be converted to Automerge Cursor) */
  from: number;
  /** End character index (will be converted to Automerge Cursor) */
  to: number;
  initialComment: string;
  contactUrl?: AutomergeUrl;
};

/** Append a reply to an existing comment thread. */
export type ReplyToCommentOperation = {
  type: "replyToComment";
  threadId: string;
  commentId: string;
  content: string;
  contactUrl?: AutomergeUrl;
};

/** Mark a comment thread as resolved (does not delete history). */
export type ResolveCommentOperation = {
  type: "resolveCommentThread";
  threadId: string;
};

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

export type FolderRenameOperation = {
  type: "folderRename";
  title: string;
};

export type FolderAddDocOperation = {
  type: "folderAddDoc";
  name: string;
  docType: string;
  url: AutomergeUrl;
};

export type FolderRemoveDocOperation = {
  type: "folderRemoveDoc";
  url: AutomergeUrl;
};

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type DocumentOperation =
  | TextSpliceOperation
  | AssetUploadOperation
  | AssetDeleteOperation
  | AddCommentThreadOperation
  | ReplyToCommentOperation
  | ResolveCommentOperation
  | FolderRenameOperation
  | FolderAddDocOperation
  | FolderRemoveDocOperation;
