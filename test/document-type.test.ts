/**
 * Tests for Document Type Extension (Legacy/Modern)
 *
 * Covers:
 *   UT-001: detectDocumentType - modern document
 *   UT-002: detectDocumentType - legacy document
 *   UT-003: detectDocumentType - invalid path
 *   UT-004: detectDocumentType - empty .mdx directory
 *   UT-005: createLegacyDocument - create structure
 *   UT-006: createModernDocument - create structure
 *   UT-007: convertLegacyToModern - conversion
 *   UT-008: convertLegacyToModern - modern document throws error
 *   UT-009: getDocumentTypeInfo - legacy
 *   UT-010: getDocumentTypeInfo - modern
 *   UT-011: MdDocumentStorage - loadContent
 *   UT-012: MdDocumentStorage - saveContent
 *   UT-013: isMarkdownXDocument - legacy document (BUG FIX)
 *   UT-014: isMarkdownXDocument - modern document
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFileSystemAdapter } from "../src/fs/memory-fs-adapter.js";
import {
  detectDocumentType,
  getDocumentTypeInfo,
  createLegacyDocument,
  createModernDocument,
  isMarkdownXDocument,
  convertLegacyToModern,
} from "../src/document/document-directories.js";
import { MdDocumentStorage } from "../src/storage/md-document-storage.js";
import type { DocumentType, DocumentTypeInfo } from "../src/document/schema.js";

// ==========================================================================
// UT-001 ~ UT-004: detectDocumentType tests
// ==========================================================================
describe("detectDocumentType", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  // UT-001: detectDocumentType - modern document
  it("UT-001: returns 'modern' when .mdx/.initialized exists", async () => {
    // Setup: create modern document structure
    await fs.writeTextFile("/docs/note.mdx/index.md", "# Hello\n");
    await fs.mkdir("/docs/note.mdx/.mdx");
    await fs.writeTextFile("/docs/note.mdx/.mdx/.initialized", new Date().toISOString());

    const result = await detectDocumentType("/docs/note.mdx", fs);

    expect(result).toBe("modern");
  });

  // UT-002: detectDocumentType - legacy document
  it("UT-002: returns 'legacy' when index.md exists but no .mdx/.initialized", async () => {
    // Setup: create legacy document structure (index.md + assets, no .mdx/)
    await fs.writeTextFile("/docs/note.mdx/index.md", "# Hello\n");
    await fs.mkdir("/docs/note.mdx/assets");

    const result = await detectDocumentType("/docs/note.mdx", fs);

    expect(result).toBe("legacy");
  });

  // UT-003: detectDocumentType - invalid path
  it("UT-003: returns null for non-existent path", async () => {
    const result = await detectDocumentType("/does/not/exist", fs);

    expect(result).toBeNull();
  });

  // UT-004: detectDocumentType - empty .mdx directory
  it("UT-004: returns 'legacy' when .mdx/ exists but no .initialized file", async () => {
    // Setup: create document with empty .mdx directory (no .initialized)
    await fs.writeTextFile("/docs/note.mdx/index.md", "# Hello\n");
    await fs.mkdir("/docs/note.mdx/.mdx");
    // No .initialized file

    const result = await detectDocumentType("/docs/note.mdx", fs);

    expect(result).toBe("legacy");
  });

  // B-002: Only assets directory, no index.md
  it("B-002: returns null when only assets directory exists without index.md", async () => {
    await fs.mkdir("/docs/note.mdx/assets");

    const result = await detectDocumentType("/docs/note.mdx", fs);

    expect(result).toBeNull();
  });
});

// ==========================================================================
// UT-005 ~ UT-006: Document creation tests
// ==========================================================================
describe("Document creation", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  // UT-005: createLegacyDocument - create structure
  it("UT-005: createLegacyDocument creates index.md and assets/ without .mdx/", async () => {
    const path = await createLegacyDocument("/docs/legacy.mdx", fs);

    expect(path).toBe("/docs/legacy.mdx");

    // Check index.md exists
    const indexContent = await fs.readTextFile("/docs/legacy.mdx/index.md");
    expect(indexContent).toBe("# Untitled\n\n");

    // Check .mdx/ does NOT exist (no files with .mdx prefix)
    const files = fs.listAllPaths();
    const hasMdxFiles = files.some(f => f.startsWith("/docs/legacy.mdx/.mdx"));
    expect(hasMdxFiles).toBe(false);
  });

  // UT-006: createModernDocument - create structure
  it("UT-006: createModernDocument creates index.md, assets/, and .mdx/.initialized", async () => {
    const path = await createModernDocument("/docs/modern.mdx", fs);

    expect(path).toBe("/docs/modern.mdx");

    // Check index.md exists
    const indexContent = await fs.readTextFile("/docs/modern.mdx/index.md");
    expect(indexContent).toBe("# Untitled\n\n");

    // Check .mdx/.initialized exists
    const initializedExists = await fs.exists("/docs/modern.mdx/.mdx/.initialized");
    expect(initializedExists).toBe(true);
  });

  it("createLegacyDocument with custom content", async () => {
    await createLegacyDocument("/docs/custom.mdx", fs, "# My Note\n\nCustom content.");

    const indexContent = await fs.readTextFile("/docs/custom.mdx/index.md");
    expect(indexContent).toBe("# My Note\n\nCustom content.");
  });

  it("createModernDocument with custom content", async () => {
    await createModernDocument("/docs/custom.mdx", fs, "# My Note\n\nCustom content.");

    const indexContent = await fs.readTextFile("/docs/custom.mdx/index.md");
    expect(indexContent).toBe("# My Note\n\nCustom content.");
  });
});

// ==========================================================================
// UT-007 ~ UT-008: Document conversion tests
// ==========================================================================
describe("convertLegacyToModern", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  // UT-007: convertLegacyToModern - conversion
  it("UT-007: creates .mdx/.initialized for legacy document", async () => {
    // Setup: create legacy document
    await createLegacyDocument("/docs/legacy.mdx", fs);

    // Convert
    await convertLegacyToModern("/docs/legacy.mdx", fs, "test-device-123");

    // Verify .mdx/.initialized exists
    const initializedExists = await fs.exists("/docs/legacy.mdx/.mdx/.initialized");
    expect(initializedExists).toBe(true);

    // Verify document type is now modern
    const type = await detectDocumentType("/docs/legacy.mdx", fs);
    expect(type).toBe("modern");
  });

  // UT-008: convertLegacyToModern - modern document throws error
  it("UT-008: throws error when document is already modern", async () => {
    // Setup: create modern document
    await createModernDocument("/docs/modern.mdx", fs);

    // Attempt to convert should throw
    await expect(
      convertLegacyToModern("/docs/modern.mdx", fs, "test-device-123")
    ).rejects.toThrow("Document is already modern type");
  });

  // ERR-002: Convert non-existent document
  it("ERR-002: throws error when document does not exist", async () => {
    await expect(
      convertLegacyToModern("/does/not/exist.mdx", fs, "test-device-123")
    ).rejects.toThrow("Document not found");
  });
});

// ==========================================================================
// UT-009 ~ UT-010: getDocumentTypeInfo tests
// ==========================================================================
describe("getDocumentTypeInfo", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  // UT-009: getDocumentTypeInfo - legacy
  it("UT-009: returns correct info for legacy document", async () => {
    await createLegacyDocument("/docs/legacy.mdx", fs);

    const info = await getDocumentTypeInfo("/docs/legacy.mdx", fs);

    expect(info).toEqual({
      type: "legacy",
      canConvertToModern: true,
      hasSyncCapability: false,
    } as DocumentTypeInfo);
  });

  // UT-010: getDocumentTypeInfo - modern
  it("UT-010: returns correct info for modern document", async () => {
    await createModernDocument("/docs/modern.mdx", fs);

    const info = await getDocumentTypeInfo("/docs/modern.mdx", fs);

    expect(info).toEqual({
      type: "modern",
      canConvertToModern: false,
      hasSyncCapability: true,
    } as DocumentTypeInfo);
  });

  it("returns null for non-existent document", async () => {
    const info = await getDocumentTypeInfo("/does/not/exist", fs);

    expect(info).toBeNull();
  });
});

// ==========================================================================
// UT-011 ~ UT-012: MdDocumentStorage tests
// ==========================================================================
describe("MdDocumentStorage", () => {
  let fs: MemoryFileSystemAdapter;
  let adapter: MdDocumentStorage;

  beforeEach(async () => {
    fs = new MemoryFileSystemAdapter();
    await createLegacyDocument("/docs/legacy.mdx", fs);
    adapter = new MdDocumentStorage("/docs/legacy.mdx", fs);
  });

  // UT-011: MdDocumentStorage - loadContent
  it("UT-011: loadContent returns index.md content", async () => {
    const content = await adapter.loadContent();

    expect(content).toBe("# Untitled\n\n");
  });

  // UT-012: MdDocumentStorage - saveContent
  it("UT-012: saveContent writes to index.md", async () => {
    const newContent = "# Updated\n\nNew content here.";

    await adapter.saveContent(newContent);

    // Verify content was written
    const savedContent = await fs.readTextFile("/docs/legacy.mdx/index.md");
    expect(savedContent).toBe(newContent);
  });

  it("getAssetsDir returns correct path", () => {
    const assetsDir = adapter.getAssetsDir();

    expect(assetsDir).toBe("/docs/legacy.mdx/assets");
  });

  it("loadContent throws for non-existent document", async () => {
    const badAdapter = new MdDocumentStorage("/does/not/exist", fs);

    await expect(badAdapter.loadContent()).rejects.toThrow();
  });

  it("saveContent creates index.md if it does not exist", async () => {
    // Create a document folder without index.md
    await fs.mkdir("/docs/partial.mdx");
    await fs.mkdir("/docs/partial.mdx/assets");

    const partialAdapter = new MdDocumentStorage("/docs/partial.mdx", fs);

    await partialAdapter.saveContent("# New Doc\n\nContent.");

    const content = await fs.readTextFile("/docs/partial.mdx/index.md");
    expect(content).toBe("# New Doc\n\nContent.");
  });
});

// ==========================================================================
// UT-013 ~ UT-014: isMarkdownXDocument tests (BUG FIX)
// ==========================================================================
describe("isMarkdownXDocument (BUG FIX: legacy document detection)", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  // UT-013: isMarkdownXDocument should return true for legacy documents
  it("UT-013: returns true for legacy documents (index.md without .mdx/)", async () => {
    // Setup: create legacy document structure (no .mdx/ directory)
    await fs.writeTextFile("/docs/legacy.mdx/index.md", "# Legacy Doc\n");
    await fs.mkdir("/docs/legacy.mdx/assets");

    const result = await isMarkdownXDocument("/docs/legacy.mdx", fs);

    // Expected: should return true for legacy documents
    expect(result).toBe(true);
  });

  // UT-014: isMarkdownXDocument should return true for modern documents
  it("UT-014: returns true for modern documents (index.md with .mdx/)", async () => {
    // Setup: create modern document structure
    await fs.writeTextFile("/docs/modern.mdx/index.md", "# Modern Doc\n");
    await fs.mkdir("/docs/modern.mdx/.mdx");
    await fs.writeTextFile("/docs/modern.mdx/.mdx/.initialized", new Date().toISOString());

    const result = await isMarkdownXDocument("/docs/modern.mdx", fs);

    // Expected: should return true for modern documents
    expect(result).toBe(true);
  });

  // Additional test: isMarkdownXDocument should return false for non-documents
  it("returns false for regular folders without index.md", async () => {
    // Setup: create regular folder
    await fs.mkdir("/docs/regular-folder");
    await fs.writeTextFile("/docs/regular-folder/some-file.txt", "content");

    const result = await isMarkdownXDocument("/docs/regular-folder", fs);

    // Expected: should return false for regular folders
    expect(result).toBe(false);
  });

  // Additional test: isMarkdownXDocument should return false for non-existent paths
  it("returns false for non-existent paths", async () => {
    const result = await isMarkdownXDocument("/docs/non-existent.mdx", fs);

    // Expected: should return false for non-existent paths
    expect(result).toBe(false);
  });
});
