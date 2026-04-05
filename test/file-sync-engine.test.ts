import { beforeEach, describe, expect, it } from "vitest";
import { next as Automerge } from "@automerge/automerge";
import { FileSyncEngine } from "../src/core/file-sync-engine.js";
import { MemoryFileSystemAdapter } from "../src/fs/memory-fs-adapter.js";
import { createLegacyDocument, createModernDocument } from "../src/document/document-directories.js";
import { createCustomOperation, createCustomOperationType } from "../src/document/operation-types.js";

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

  it("applies registered custom operations to modern documents", async () => {
    await createModernDocument("/docs/custom-op.mdx", fs, "# Custom\n\nHello");

    const engine = new FileSyncEngine("/docs/custom-op.mdx", fs, "DEVICE-A");
    await engine.load();
    const canonicalType = createCustomOperationType("example.com", "setAiSummary");

    engine.registerCustomOperationHandler("example.com", "setAiSummary", (doc, operation) =>
      Automerge.change(doc, (draft) => {
        draft.aiMetadata ??= {};
        draft.aiMetadata.summary = String(operation.summary);
      }),
    );

    const result = engine.applyCustomOperation(
      createCustomOperation("example.com", "setAiSummary", {
        summary: "Summary from custom handler",
      }),
    );

    expect(result.changed).toBe(true);
    expect(engine.getDocument()?.aiMetadata?.summary).toBe("Summary from custom handler");

    await engine.forceSave();

    const reloaded = new FileSyncEngine("/docs/custom-op.mdx", fs, "DEVICE-A");
    await reloaded.load();
    expect(reloaded.getDocument()?.aiMetadata?.summary).toBe("Summary from custom handler");
  });

  it("stores lightweight registry metadata and validates custom operations", async () => {
    await createModernDocument("/docs/custom-registry.mdx", fs, "# Custom\n\nHello");

    const engine = new FileSyncEngine("/docs/custom-registry.mdx", fs, "DEVICE-A");
    await engine.load();
    const canonicalType = createCustomOperationType("example.com", "setValidatedSummary");

    engine.registerCustomOperation({
      organization: "example.com",
      typeSegment: "setValidatedSummary",
      description: "Set AI summary after validating payload",
      validate: (operation) => {
        if (typeof operation.summary !== "string" || operation.summary.trim().length === 0) {
          throw new Error("summary must be a non-empty string");
        }
      },
      apply: (doc, operation) =>
        Automerge.change(doc, (draft) => {
          draft.aiMetadata ??= {};
          draft.aiMetadata.summary = String(operation.summary);
        }),
    });

    expect(engine.getCustomOperationDefinition(canonicalType)?.description).toBe(
      "Set AI summary after validating payload",
    );
    expect(engine.listCustomOperationDefinitions().map((entry) => entry.canonicalType)).toContain(canonicalType);

    expect(() =>
      engine.applyCustomOperation(createCustomOperation("example.com", "setValidatedSummary", {
        summary: "",
      })),
    ).toThrow("summary must be a non-empty string");

    const result = engine.applyCustomOperation(
      createCustomOperation("example.com", "setValidatedSummary", {
        summary: "Validated summary",
      }),
    );

    expect(result.changed).toBe(true);
    expect(engine.getDocument()?.aiMetadata?.summary).toBe("Validated summary");

    engine.appendCustomOperationHistoryEntry(
      {
        deviceId: "DEVICE-A",
        nickname: "amber-1a2b",
        deviceName: "Aster-Mac",
        customFields: {},
      },
      {
        organization: "example.com",
        typeSegment: "setValidatedSummary",
        canonicalType,
      },
      "Set AI summary after validating payload",
    );

    expect(engine.getEditHistory().some((entry) => entry.customOperationSource?.canonicalType === canonicalType)).toBe(true);
  });

  it("throws when applying an unregistered custom operation", async () => {
    await createModernDocument("/docs/custom-op-error.mdx", fs, "# Custom\n\nHello");

    const engine = new FileSyncEngine("/docs/custom-op-error.mdx", fs, "DEVICE-A");
    await engine.load();

    expect(() =>
      engine.applyCustomOperation({
        type: createCustomOperationType("example.com", "unknownCustomOperation"),
        value: 1,
      }),
    ).toThrow("No custom operation handler registered for type: example.com/unknownCustomOperation");
  });

  it("rejects invalid organization domains and duplicate registrations", async () => {
    await createModernDocument("/docs/custom-op-dup.mdx", fs, "# Custom\n\nHello");

    const engine = new FileSyncEngine("/docs/custom-op-dup.mdx", fs, "DEVICE-A");
    await engine.load();

    expect(() =>
      engine.registerCustomOperation({
        organization: "https://example.com",
        typeSegment: "setSummary",
        apply: (doc) => doc,
      }),
    ).toThrow("Invalid custom operation organization: https://example.com. Expected a bare domain like example.com");

    engine.registerCustomOperation({
      organization: "example.com",
      typeSegment: "setSummary",
      apply: (doc) => doc,
    });

    expect(() =>
      engine.registerCustomOperation({
        organization: "example.com",
        typeSegment: "setSummary",
        apply: (doc) => doc,
      }),
    ).toThrow("Custom operation already registered: example.com/setSummary");
  });
});
