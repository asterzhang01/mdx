import { beforeEach, describe, expect, it } from "vitest";
import { FileSyncEngine } from "../src/core/file-sync-engine.js";
import { MemoryFileSystemAdapter } from "../src/fs/memory-fs-adapter.js";
import { createLegacyDocument, createModernDocument } from "../src/document/document-utils.js";

describe("FileSyncEngine unified document facade", () => {
  let fs: MemoryFileSystemAdapter;

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
  });

  it("loads legacy documents through the same engine interface", async () => {
    await createLegacyDocument("/docs/legacy.mdx", fs, "# Legacy\n\nHello");
    await fs.writeTextFile("/docs/legacy.mdx/assets/used.png", "used");
    await fs.writeTextFile("/docs/legacy.mdx/assets/orphan.png", "orphan");

    const engine = new FileSyncEngine("/docs/legacy.mdx", fs, "DEVICE-A");
    await engine.load();

    expect(engine.getDocumentType()).toBe("legacy");
    expect(engine.getDocumentTypeInfo()).toEqual({
      type: "legacy",
      canConvertToModern: true,
      hasSyncCapability: false,
    });
    expect(engine.getContent()).toBe("# Legacy\n\nHello");
    expect(engine.getAssetsDir()).toBe("/docs/legacy.mdx/assets");

    await engine.applyChange("# Legacy\n\n![used](assets/used.png)");
    await engine.forceSave();

    expect(await fs.readTextFile("/docs/legacy.mdx/index.md")).toBe(
      "# Legacy\n\n![used](assets/used.png)"
    );
    expect(await engine.getOrphanedAssets()).toEqual(["orphan.png"]);
    expect(await engine.cleanOrphanedAssets()).toBe(1);
    expect(await engine.getOrphanedAssets()).toEqual([]);
  });

  it("converts legacy documents to modern without changing the caller interface", async () => {
    await createLegacyDocument("/docs/convert.mdx", fs, "# Convert\n\nBody");

    const engine = new FileSyncEngine("/docs/convert.mdx", fs, "DEVICE-A");
    await engine.load();
    await engine.convertToModern();

    expect(engine.getDocumentType()).toBe("modern");
    expect(engine.getDocumentTypeInfo()).toEqual({
      type: "modern",
      canConvertToModern: false,
      hasSyncCapability: true,
    });
    expect(await fs.exists("/docs/convert.mdx/.mdx/.initialized")).toBe(true);
    expect(engine.getContent()).toBe("# Convert\n\nBody");
  });

  it("preserves the same interface for modern documents", async () => {
    await createModernDocument("/docs/modern.mdx", fs, "# Modern\n\nHello");

    const engine = new FileSyncEngine("/docs/modern.mdx", fs, "DEVICE-A");
    const result = await engine.load();

    expect(result.doc.content).toBe("# Modern\n\nHello");
    expect(engine.getDocumentType()).toBe("modern");

    await engine.applyChange("# Modern\n\nUpdated");
    await engine.forceSave();

    expect(await fs.readTextFile("/docs/modern.mdx/index.md")).toBe("# Modern\n\nUpdated");
  });
});
