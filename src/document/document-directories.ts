/**
 * .mdx document utilities
 *
 * High-level helpers for detecting, creating, and validating
 * MarkdownX document directories.
 *
 * Document Types:
 * - Legacy: index.md + assets/ (no sync capability)
 * - Modern: index.md + assets/ + .mdx/.initialized (with sync capability)
 */
import type { FileSystemAdapter } from "../fs/fs-adapter.js";
import { MdDocumentStorage } from "../storage/md-document-storage.js";
import type { DocumentType, DocumentTypeInfo } from "./schema.js";
import { getGlobalTraceManager, TraceLevel, TraceType } from "../utils/trace.js";

// ---------------------------------------------------------------------------
// Document Type Detection
// ---------------------------------------------------------------------------

/**
 * Detect the type of a document directory.
 *
 * - Returns 'modern' if .mdx/.initialized exists, even when index.md is absent
 * - Returns 'legacy' if index.md exists but no .mdx/.initialized
 * - Returns null if not a valid document
 */
export async function detectDocumentType(
  path: string,
  fsAdapter: FileSystemAdapter
): Promise<DocumentType | null> {
  const trace = getGlobalTraceManager();

  try {
    const hasInitialized = await fsAdapter.exists(`${path}/.mdx/.initialized`);
    if (hasInitialized) {
      trace.log(TraceLevel.DEBUG, TraceType.FILE, "detectDocumentType", "result", {
        path,
        hasInitialized,
        hasIndexMd: await fsAdapter.exists(`${path}/index.md`),
        type: "modern"
      });
      return "modern";
    }

    const hasIndexMd = await fsAdapter.exists(`${path}/index.md`);
    if (!hasIndexMd) {
      trace.log(TraceLevel.DEBUG, TraceType.FILE, "detectDocumentType", "noIndexMd", { path });
      return null;
    }
    const type: DocumentType = hasInitialized ? 'modern' : 'legacy';

    trace.log(TraceLevel.DEBUG, TraceType.FILE, "detectDocumentType", "result", {
      path,
      hasInitialized,
      type
    });

    return type;
  } catch (error) {
    trace.log(TraceLevel.DEBUG, TraceType.FILE, "detectDocumentType", "error", {
      path,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Get detailed information about a document's type and capabilities.
 */
export async function getDocumentTypeInfo(
  path: string,
  fsAdapter: FileSystemAdapter
): Promise<DocumentTypeInfo | null> {
  const type = await detectDocumentType(path, fsAdapter);
  if (type === null) {
    return null;
  }

  return {
    type,
    canConvertToModern: type === 'legacy',
    hasSyncCapability: type === 'modern',
  };
}

// ---------------------------------------------------------------------------
// Document Validation
// ---------------------------------------------------------------------------

/**
 * Check whether a given path is a valid MarkdownX document directory.
 *
 * A directory is considered a valid .mdx document if it contains
 * an `index.md` file. Both legacy (index.md only) and modern 
 * (index.md + .mdx/) documents are considered valid.
 * 
 * [TRACE] Added detailed trace logging for debugging document detection
 */
export async function isMarkdownXDocument(
  path: string,
  fsAdapter: FileSystemAdapter
): Promise<boolean> {
  const trace = getGlobalTraceManager();
  
  try {
    trace.log(TraceLevel.DEBUG, TraceType.FILE, "isMarkdownXDocument", "start", { path });
    
    const hasIndexMd = await fsAdapter.exists(`${path}/index.md`);
    trace.log(TraceLevel.DEBUG, TraceType.FILE, "isMarkdownXDocument", "checkIndexMd", { 
      path, 
      hasIndexMd 
    });
    
    // BUG FIX: Legacy documents only need index.md to be valid
    // Modern documents have .mdx/ directory in addition
    const result = hasIndexMd;
    
    trace.log(TraceLevel.INFO, TraceType.FILE, "isMarkdownXDocument", "result", { 
      path, 
      hasIndexMd,
      result 
    });
    
    return result;
  } catch (error) {
    trace.log(TraceLevel.ERROR, TraceType.FILE, "isMarkdownXDocument", "error", { 
      path, 
      error: String(error) 
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Document Creation
// ---------------------------------------------------------------------------

/**
 * Create a new legacy document directory.
 *
 * Creates:
 *   path/
 *   ├── index.md          ← default content
 *   └── assets/            ← empty directory for resources
 *
 * No .mdx/ directory - no sync capability.
 *
 * @returns The basePath of the created document (same as input path).
 */
export async function createLegacyDocument(
  path: string,
  fsAdapter: FileSystemAdapter,
  initialContent = "# Untitled\n\n"
): Promise<string> {
  const trace = getGlobalTraceManager();

  await fsAdapter.mkdir(path);
  await fsAdapter.mkdir(`${path}/assets`);
  await fsAdapter.writeTextFile(`${path}/index.md`, initialContent);

  trace.log(TraceLevel.DEBUG, TraceType.FILE, "createLegacyDocument", "created", {
    path,
    hasMdxDir: false
  });

  return path;
}

/**
 * Create a new modern document directory with sync capability.
 *
 * Creates:
 *   path/
 *   ├── index.md          ← default content
 *   ├── assets/            ← empty directory for resources
 *   └── .mdx/
 *       └── .initialized   ← marker file for modern type
 *
 * @returns The basePath of the created document (same as input path).
 */
export async function createModernDocument(
  path: string,
  fsAdapter: FileSystemAdapter,
  initialContent = "# Untitled\n\n"
): Promise<string> {
  const trace = getGlobalTraceManager();

  await fsAdapter.mkdir(path);
  await fsAdapter.mkdir(`${path}/.mdx`);
  await fsAdapter.mkdir(`${path}/assets`);
  await fsAdapter.writeTextFile(`${path}/index.md`, initialContent);

  // Write a marker file so the .mdx directory is detectable even on
  // flat-namespace file systems (e.g. MemoryFileSystemAdapter).
  const markerPath = `${path}/.mdx/.initialized`;
  if (!(await fsAdapter.exists(markerPath))) {
    await fsAdapter.writeTextFile(markerPath, new Date().toISOString());
  }

  trace.log(TraceLevel.DEBUG, TraceType.FILE, "createModernDocument", "created", {
    path,
    hasMdxDir: true,
    hasInitialized: true
  });

  return path;
}

/**
 * Create a new MarkdownX document directory with default structure.
 * Alias for createModernDocument for backward compatibility.
 *
 * @deprecated Use createModernDocument instead
 */
export async function createMarkdownXDocument(
  path: string,
  fsAdapter: FileSystemAdapter,
  initialContent = "# Untitled\n\n"
): Promise<string> {
  return createModernDocument(path, fsAdapter, initialContent);
}

// ---------------------------------------------------------------------------
// Legacy document access
// ---------------------------------------------------------------------------

export async function loadLegacyDocumentContent(
  path: string,
  fsAdapter: FileSystemAdapter,
): Promise<string> {
  const adapter = new MdDocumentStorage(path, fsAdapter);
  return adapter.loadContent();
}

export async function saveLegacyDocumentContent(
  path: string,
  fsAdapter: FileSystemAdapter,
  content: string,
): Promise<void> {
  const adapter = new MdDocumentStorage(path, fsAdapter);
  await adapter.saveContent(content);
}

export function getLegacyDocumentAssetsDir(path: string): string {
  return `${path}/assets`;
}

// ---------------------------------------------------------------------------
// Document Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a legacy document to modern type.
 *
 * Creates the .mdx/ directory with .initialized marker file.
 * This is a one-way conversion - modern documents cannot be converted back.
 *
 * @throws Error if document is already modern type
 * @throws Error if document does not exist
 */
export async function convertLegacyToModern(
  path: string,
  fsAdapter: FileSystemAdapter,
  deviceId: string
): Promise<void> {
  const trace = getGlobalTraceManager();

  // Check if document exists
  const hasIndexMd = await fsAdapter.exists(`${path}/index.md`);
  if (!hasIndexMd) {
    throw new Error(`Document not found: ${path}`);
  }

  // Check if already modern
  const hasInitialized = await fsAdapter.exists(`${path}/.mdx/.initialized`);
  if (hasInitialized) {
    throw new Error("Document is already modern type");
  }

  // Create .mdx directory structure
  await fsAdapter.mkdir(`${path}/.mdx`);

  // Write initialized marker
  const markerPath = `${path}/.mdx/.initialized`;
  await fsAdapter.writeTextFile(markerPath, new Date().toISOString());

  trace.log(TraceLevel.DEBUG, TraceType.SYNC, "convertLegacyToModern", "converted", {
    path,
    deviceId,
    success: true
  });
}
