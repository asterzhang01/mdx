/**
 * Core data model types for MarkdownX
 * Fully compatible with TEE (tiny-essay-editor) schema
 */
import type { AutomergeUrl } from "@automerge/automerge-repo";

/** A single comment within a thread */
export type Comment = {
  id: string;
  content: string;
  /** Link to commenter's contact document */
  contactUrl?: AutomergeUrl;
  timestamp: number;
};

/** A comment thread anchored to a text range via Automerge Cursors */
export type CommentThread = {
  id: string;
  comments: Comment[];
  resolved: boolean;
  /** Automerge Cursor — text edits cause it to follow automatically */
  fromCursor: string;
  /** Automerge Cursor — text edits cause it to follow automatically */
  toCursor: string;
};

/** AI metadata stored alongside the document (Phase 1: definition only) */
export type AIMetadata = {
  embeddingModel?: string;
  /** ISO 8601 timestamp of last indexing */
  lastIndexedAt?: string;
  tags?: string[];
  summary?: string;
  /** Relative path to vector index within .mdx directory */
  vectorIndexPath?: string;
};

/** The primary Markdown document — character-level CRDT */
export type MarkdownDoc = {
  /** Markdown body, character-level CRDT via Automerge.splice */
  content: string;
  /** Comment threads keyed by thread ID */
  commentThreads: Record<string, CommentThread>;
  /** URL of the associated AssetsDoc (independent Automerge document) */
  assetsDocUrl: AutomergeUrl;
  /** AI metadata (Phase 1: structure only, no logic) */
  aiMetadata?: AIMetadata;
};

/** A single file entry inside an AssetsDoc */
export type FileEntry = {
  contentType: string;
  contents: string | Uint8Array;
};

/** Independent Automerge document holding binary assets */
export type AssetsDoc = {
  files: Record<string, FileEntry>;
};

/** A link to a document inside a folder */
export type DocLink = {
  name: string;
  type: string;
  url: AutomergeUrl;
};

/** A folder document containing ordered document links */
export type FolderDoc = {
  title: string;
  docs: DocLink[];
};

/**
 * CommentThread enriched with resolved integer positions for UI rendering.
 * Produced by resolveCommentThreadPositions().
 */
export type CommentThreadForUI = CommentThread & {
  from: number;
  to: number;
  active: boolean;
};

/**
 * Chunk file metadata persisted inside .mdx/ directory.
 * Each device writes exactly one chunk file at a time.
 */
export type ChunkFileMetadata = {
  deviceId: string;
  timestamp: number;
  sequenceNumber: number;
  /** Serialised Automerge incremental changes */
  changes: Uint8Array[];
};

/**
 * Snapshot file metadata persisted inside .mdx/ directory.
 * Contains a full Automerge.save() binary plus a watermark.
 */
export type SnapshotFileMetadata = {
  deviceId: string;
  timestamp: number;
  /** The seqNo of the last change included in this snapshot */
  watermark: number;
  /** Full Automerge binary (result of Automerge.save()) */
  binary: Uint8Array;
};

// ---------------------------------------------------------------------------
// Document Type Types
// ---------------------------------------------------------------------------

/**
 * Document type - determines sync capability.
 * - legacy: Simple editing without multi-device sync (no .mdx/ directory)
 * - modern: Full features with multi-device sync support (.mdx/ with .initialized)
 */
export type DocumentType = 'legacy' | 'modern';

/**
 * Document type information.
 * Provides metadata about a document's type and capabilities.
 */
export type DocumentTypeInfo = {
  /** The document type */
  type: DocumentType;
  /** Whether this document can be converted to modern type */
  canConvertToModern: boolean;
  /** Whether this document supports multi-device sync */
  hasSyncCapability: boolean;
};

// ---------------------------------------------------------------------------
// Vault Configuration Types
// ---------------------------------------------------------------------------

/**
 * Vault settings - user preferences for a vault.
 * Stored in .markdownx/vault-config/ with CRDT sync support.
 */
export type VaultSettings = {
  /** Whether to show line numbers in the editor */
  showLineNumbers: boolean;
};

/**
 * Vault configuration document - CRDT document type.
 * Supports multi-device sync via Automerge.
 */
export type VaultConfigDoc = {
  settings: VaultSettings;
};
