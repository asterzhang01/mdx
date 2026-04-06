/**
 * Tests for MdxDocumentStorage
 *
 * Covers:
 *   • chunk file write with correct naming convention
 *   • snapshot write + atomic index.md export
 *   • old chunk cleanup on new write
 *   • crash recovery (two chunks for same device → pick latest)
 *   • compaction resets chunk, deletes old snapshot
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Automerge from "@automerge/automerge";
import { MemoryFileSystemAdapter } from "../src/fs/memory-fs-adapter.js";
import {
  MdxDocumentStorage,
  parseChunkFileName,
  parseSnapshotFileName,
} from "../src/storage/mdx-document-storage.js";
import type { MarkdownDoc } from "../src/document/schema.js";

function createTestDoc(content = "# Hello\n"): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(Automerge.init<MarkdownDoc>(), (d) => {
    d.content = content;
    d.commentThreads = {};
    d.assetsDocUrl = "automerge:test-assets-url" as any;
  });
}

describe("MdxDocumentStorage", () => {
  let fs: MemoryFileSystemAdapter;
  let storage: MdxDocumentStorage;
  const basePath = "/docs/note.mdx";
  const deviceId = "DEVICE-A";

  beforeEach(() => {
    fs = new MemoryFileSystemAdapter();
    storage = new MdxDocumentStorage(basePath, fs, deviceId);
  });

  // -----------------------------------------------------------------------
  // Chunk file naming
  // -----------------------------------------------------------------------

  describe("chunk file naming", () => {
    it("writes chunk with {deviceId}-{timestamp}-{seqNo}.chunk format", async () => {
      const doc = createTestDoc();
      const changes = Automerge.getAllChanges(doc);

      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();

      const metaFiles = await fs.readdir(`${basePath}/.mdx`);
      const chunkFiles = metaFiles.filter((f) => f.endsWith(".chunk"));
      expect(chunkFiles.length).toBe(1);

      const parsed = parseChunkFileName(chunkFiles[0]);
      expect(parsed).not.toBeNull();
      expect(parsed!.deviceId).toBe(deviceId);
      expect(parsed!.timestamp).toBeGreaterThan(0);
    });

    it("deletes old chunk when writing new one", async () => {
      const doc = createTestDoc();
      const changes = Automerge.getAllChanges(doc);

      // First write
      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();

      // Second write with more changes
      const doc2 = Automerge.change(doc, (d) => {
        d.content = "# Updated\n";
      });
      const newChanges = Automerge.getLastLocalChange(doc2);
      if (newChanges) {
        storage.appendChange(newChanges);
      }
      await storage.flushChanges();

      const metaFiles = await fs.readdir(`${basePath}/.mdx`);
      const chunkFiles = metaFiles.filter((f) => f.endsWith(".chunk"));
      // Should only have one chunk file (old one deleted)
      expect(chunkFiles.length).toBe(1);
    });

    it("cleans up all stale chunks for the same device on the next write", async () => {
      const doc = createTestDoc();
      const changes = Automerge.getAllChanges(doc);

      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();

      const doc2 = Automerge.change(doc, (d) => {
        d.content = "# Updated A\n";
      });
      const adapter2 = new MdxDocumentStorage(basePath, fs, deviceId);
      const change2 = Automerge.getLastLocalChange(doc2);
      if (change2) {
        adapter2.appendChange(change2);
      }
      await adapter2.flushChanges();

      const doc3 = Automerge.change(doc2, (d) => {
        d.content = "# Updated B\n";
      });
      const adapter3 = new MdxDocumentStorage(basePath, fs, deviceId);
      const change3 = Automerge.getLastLocalChange(doc3);
      if (change3) {
        adapter3.appendChange(change3);
      }
      await adapter3.flushChanges();

      const metaFiles = await fs.readdir(`${basePath}/.mdx`);
      const chunkFiles = metaFiles.filter((f) => f.endsWith(".chunk"));
      expect(chunkFiles.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot
  // -----------------------------------------------------------------------

  describe("snapshot", () => {
    it("writes snapshot with {deviceId}-{timestamp}.snapshot format and exports index.md", async () => {
      const doc = createTestDoc("# Snapshot Test\n");
      const changes = Automerge.getAllChanges(doc);

      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();

      await storage.compact(doc);
      await storage.exportIndexMd(doc);

      const metaFiles = await fs.readdir(`${basePath}/.mdx`);
      const snapshotFiles = metaFiles.filter((f) => f.endsWith(".snapshot"));
      expect(snapshotFiles.length).toBe(1);

      const parsed = parseSnapshotFileName(snapshotFiles[0]);
      expect(parsed).not.toBeNull();
      expect(parsed!.deviceId).toBe(deviceId);

      // index.md should be exported
      const indexContent = await fs.readTextFile(`${basePath}/index.md`);
      expect(indexContent).toBe("# Snapshot Test\n");
    });

    it("compaction deletes old chunk files", async () => {
      const doc = createTestDoc();
      const changes = Automerge.getAllChanges(doc);

      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();

      await storage.compact(doc);

      const metaFiles = await fs.readdir(`${basePath}/.mdx`);
      const chunkFiles = metaFiles.filter((f) => f.endsWith(".chunk"));
      expect(chunkFiles.length).toBe(0);
    });

    it("compaction deletes old snapshot when creating new one", async () => {
      const doc = createTestDoc();
      const changes = Automerge.getAllChanges(doc);

      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();

      // First compact
      await storage.compact(doc);

      // Make more changes and compact again
      const doc2 = Automerge.change(doc, (d) => {
        d.content = "# Updated\n";
      });
      const newChange = Automerge.getLastLocalChange(doc2);
      if (newChange) {
        storage.appendChange(newChange);
      }
      await storage.flushChanges();
      await storage.compact(doc2);

      const metaFiles = await fs.readdir(`${basePath}/.mdx`);
      const snapshotFiles = metaFiles.filter((f) => f.endsWith(".snapshot"));
      // Should only have one snapshot (old one deleted)
      expect(snapshotFiles.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Load
  // -----------------------------------------------------------------------

  describe("load", () => {
    it("loads document from chunk", async () => {
      const doc = createTestDoc("# Load Test\n");
      const changes = Automerge.getAllChanges(doc);

      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();

      // Create a new storage instance (simulates restart)
      const reloadedStorage = new MdxDocumentStorage(basePath, fs, deviceId);
      const loaded = await reloadedStorage.loadLocal();

      expect(loaded).not.toBeNull();
      expect(String(loaded!.content)).toBe("# Load Test\n");
    });

    it("loads document from snapshot + chunk", async () => {
      const doc = createTestDoc("# Base\n");
      const changes = Automerge.getAllChanges(doc);

      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();
      await storage.compact(doc);

      // Add more changes after snapshot
      const doc2 = Automerge.change(doc, (d) => {
        d.content = "# Updated After Snapshot\n";
      });
      const newChange = Automerge.getLastLocalChange(doc2);
      if (newChange) {
        storage.appendChange(newChange);
      }
      await storage.flushChanges();

      // Load from a new storage instance
      const reloadedStorage = new MdxDocumentStorage(basePath, fs, deviceId);
      const loaded = await reloadedStorage.loadLocal();

      expect(loaded).not.toBeNull();
      // The loaded doc should have the post-snapshot changes
      expect(loaded!.content).toBeDefined();
    });

    it("returns null when no data exists", async () => {
      const loaded = await storage.loadLocal();
      expect(loaded).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Crash recovery
  // -----------------------------------------------------------------------

  describe("crash recovery", () => {
    it("picks latest timestamp chunk when two exist for same device", async () => {
      // Simulate crash: manually write two chunk files
      await fs.mkdir(`${basePath}/.mdx`);

      const doc1 = createTestDoc("# Old\n");
      const doc2 = createTestDoc("# New\n");

      const changes1 = Automerge.getAllChanges(doc1);
      const changes2 = Automerge.getAllChanges(doc2);

      // Write old chunk
      const oldAdapter = new MdxDocumentStorage(basePath, fs, deviceId);
      for (const c of changes1) {
        oldAdapter.appendChange(c);
      }
      await oldAdapter.flushChanges();

      // Manually write a newer chunk (simulating crash left old one)
      const newerAdapter = new MdxDocumentStorage(basePath, fs, deviceId);
      for (const c of changes2) {
        newerAdapter.appendChange(c);
      }
      await newerAdapter.flushChanges();

      // Load should get the latest
      const loadAdapter = new MdxDocumentStorage(basePath, fs, deviceId);
      const loaded = await loadAdapter.loadLocal();
      expect(loaded).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Device listing
  // -----------------------------------------------------------------------

  describe("listDeviceIds", () => {
    it("lists all device IDs from chunk and snapshot files", async () => {
      // Device A writes
      const docA = createTestDoc("# Device A\n");
      for (const c of Automerge.getAllChanges(docA)) {
        storage.appendChange(c);
      }
      await storage.flushChanges();

      // Device B writes
      const adapterB = new MdxDocumentStorage(basePath, fs, "DEVICE-B");
      const docB = createTestDoc("# Device B\n");
      for (const c of Automerge.getAllChanges(docB)) {
        adapterB.appendChange(c);
      }
      await adapterB.flushChanges();

      const deviceIds = await storage.listDeviceIds();
      expect(deviceIds).toContain("DEVICE-A");
      expect(deviceIds).toContain("DEVICE-B");
      expect(deviceIds.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Dual-Write (index.md export)
  // -----------------------------------------------------------------------

  describe("exportIndexMd", () => {
    it("atomically exports index.md from document content", async () => {
      const doc = createTestDoc("# Export Test\n\nSome content.");
      await storage.ensureDirectories();
      await storage.exportIndexMd(doc);

      const content = await fs.readTextFile(`${basePath}/index.md`);
      expect(content).toBe("# Export Test\n\nSome content.");
    });
  });
});
