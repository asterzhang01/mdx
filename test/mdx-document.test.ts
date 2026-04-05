/**
 * Tests for mdx-document utilities
 *
 * Covers:
 *   • isMarkdownXDocument detects valid .mdx directories
 *   • isMarkdownXDocument returns false for invalid paths
 *   • createMarkdownXDocument creates correct directory structure
 *   • createMarkdownXDocument uses custom initial content
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFileSystemAdapter } from "../src/fs/memory-fs-adapter.js";
import {
  isMarkdownXDocument,
  createMarkdownXDocument,
} from "../src/document/document-directories.js";

describe("isMarkdownXDocument", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  it("returns true when index.md and .mdx/ both exist", async () => {
    await fs.writeTextFile("/docs/note.mdx/index.md", "# Hello\n");
    await fs.writeFile("/docs/note.mdx/.mdx/placeholder", new Uint8Array([0]));

    const result = await isMarkdownXDocument("/docs/note.mdx", fs);
    expect(result).toBe(true);
  });

  it("returns false when index.md is missing", async () => {
    await fs.writeFile("/docs/note.mdx/.mdx/placeholder", new Uint8Array([0]));

    const result = await isMarkdownXDocument("/docs/note.mdx", fs);
    expect(result).toBe(false);
  });

  it("returns true for legacy documents (index.md without .mdx/)", async () => {
    await fs.writeTextFile("/docs/note.mdx/index.md", "# Hello\n");

    const result = await isMarkdownXDocument("/docs/note.mdx", fs);
    // NOTE: This now returns true because legacy documents (index.md only) are valid
    expect(result).toBe(true);
  });

  it("returns false for non-existent path", async () => {
    const result = await isMarkdownXDocument("/does/not/exist", fs);
    expect(result).toBe(false);
  });
});

describe("createMarkdownXDocument", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  it("creates directory structure with default content", async () => {
    const path = await createMarkdownXDocument("/docs/new.mdx", fs);

    expect(path).toBe("/docs/new.mdx");

    const indexContent = await fs.readTextFile("/docs/new.mdx/index.md");
    expect(indexContent).toBe("# Untitled\n\n");

    const isValid = await isMarkdownXDocument("/docs/new.mdx", fs);
    expect(isValid).toBe(true);
  });

  it("creates directory structure with custom content", async () => {
    await createMarkdownXDocument("/docs/custom.mdx", fs, "# My Document\n\nHello world.\n");

    const indexContent = await fs.readTextFile("/docs/custom.mdx/index.md");
    expect(indexContent).toBe("# My Document\n\nHello world.\n");
  });

  it("created document is detectable by isMarkdownXDocument", async () => {
    await createMarkdownXDocument("/docs/test.mdx", fs);

    const isValid = await isMarkdownXDocument("/docs/test.mdx", fs);
    expect(isValid).toBe(true);
  });
});
