import { describe, expect, it } from "vitest";
import { FileSyncEngine } from "../src/core/file-sync-engine.js";
import { MemoryFileSystemAdapter } from "../src/fs/memory-fs-adapter.js";
import type { UserProfile } from "../src/document/schema.js";

const testUser: UserProfile = {
  deviceId: "DEV-A",
  nickname: "amber-1234",
  deviceName: "Aster-Mac",
  customFields: {},
};

describe("document metadata and history", () => {
  it("persists metadata and history in modern documents", async () => {
    const fs = new MemoryFileSystemAdapter();
    const basePath = "/docs/note.mdx";
    const engine = new FileSyncEngine(basePath, fs, testUser.deviceId);

    await engine.init("# Test\n");
    engine.ensureCapabilities(testUser, { includeCreationHistory: true });
    engine.updateMetadata({
      ...engine.getDocumentMetadata()!,
      customFields: {
        project: "MarkdownX",
      },
    });
    engine.appendHistoryEntry(testUser, "metadata-updated", "Metadata updated");
    await engine.forceSave();

    const reloaded = new FileSyncEngine(basePath, fs, testUser.deviceId);
    await reloaded.load();

    expect(reloaded.getDocumentMetadata()?.customFields.project).toBe("MarkdownX");
    expect(reloaded.getEditHistory().some((entry) => entry.kind === "document-created")).toBe(true);
    expect(reloaded.getEditHistory().some((entry) => entry.kind === "metadata-updated")).toBe(true);
  });
});
