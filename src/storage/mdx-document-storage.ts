/**
 * MdxDocumentStorage
 *
 * Maps automerge-repo StorageAdapterInterface calls to the .mdx file structure:
 *
 *   note.mdx/
 *   ├── index.md                          ← human-readable golden copy (derived)
 *   ├── assets/                           ← content-addressed resources
 *   └── .mdx/                             ← sync metadata
 *       ├── {deviceId}-{ts}-{seqNo}.chunk
 *       └── {deviceId}-{ts}.snapshot
 *
 * Key invariants:
 *   • Each device only writes its own deviceId-prefixed files (write isolation).
 *   • Chunk files accumulate incremental Automerge changes with debounce.
 *   • Snapshots compact all changes into a single Automerge.save() binary.
 *   • index.md is atomically derived from CRDT state (Dual-Write).
 */
import { next as Automerge } from "@automerge/automerge";
import type { FileSystemAdapter } from "../fs/fs-adapter.js";
import type { MarkdownDoc } from "../document/schema.js";
import { getGlobalTraceManager, TraceLevel, TraceType } from "../utils/trace.js";
import {
  parseChunkFileName,
  parseSnapshotFileName,
} from "../utils/filename-utils.js";
import { createStoragePaths } from "./internal/storage-paths.js";
import {
  findLatestChunk,
  findLatestSnapshot,
} from "./internal/device-files.js";
import { AutomergeSyncEngine } from "../sync/automerge-sync-engine.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;
const COMPACT_SIZE_THRESHOLD = 1_048_576; // 1 MB
const COMPACT_CHANGES_THRESHOLD = 500;
const COMPACT_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// MdxDocumentStorage
// ---------------------------------------------------------------------------

export class MdxDocumentStorage {
  private readonly basePath: string;
  private readonly metaDir: string;
  private readonly assetsDir: string;
  private readonly indexPath: string;
  private readonly indexTmpPath: string;
  private readonly fs: FileSystemAdapter;
  private readonly deviceId: string;
  private readonly syncStorage: AutomergeSyncEngine<MarkdownDoc>;

  /** Trace manager for logging */
  private readonly trace = getGlobalTraceManager();

  constructor(basePath: string, fs: FileSystemAdapter, deviceId: string) {
    const paths = createStoragePaths(basePath);

    this.basePath = paths.basePath;
    this.metaDir = paths.metaDir;
    this.assetsDir = paths.assetsDir;
    this.indexPath = paths.indexPath;
    this.indexTmpPath = paths.indexTmpPath;
    this.fs = fs;
    this.deviceId = deviceId;
    this.syncStorage = new AutomergeSyncEngine<MarkdownDoc>({
      metaDir: this.metaDir,
      fs,
      deviceId,
      traceComponent: "MdxDocumentStorage",
      debounceMs: DEBOUNCE_MS,
    });

    this.trace.log(TraceLevel.DEBUG, TraceType.LIFECYCLE, "MdxDocumentStorage", "constructor", {
      basePath,
      metaDir: this.metaDir,
      deviceId
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Ensure directory structure exists */
  async ensureDirectories(): Promise<void> {
    await this.syncStorage.ensureDirectories();
    await this.fs.mkdir(this.assetsDir);
    const initializedPath = `${this.metaDir}/.initialized`;
    if (!(await this.fs.exists(initializedPath))) {
      await this.fs.writeTextFile(initializedPath, new Date().toISOString());
    }
    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "ensureDirectories", {
      metaDir: this.metaDir,
      assetsDir: this.assetsDir
    });
  }

  /**
   * Load the current device's document state from its snapshot + chunk.
   * Returns null if no data exists for this device.
   */
  async loadLocal(): Promise<Automerge.Doc<MarkdownDoc> | null> {
    const ctx = this.trace.startTrace("MdxDocumentStorage", "loadLocal", TraceType.FILE);

    await this.ensureDirectories();
    const files = await this.fs.readdir(this.metaDir);
    const state = await this.syncStorage.loadLocalState();
    const snapshot = findLatestSnapshot(files, this.deviceId);
    const chunk = findLatestChunk(files, this.deviceId);

    if (snapshot) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "loadLocal:snapshot", {
        fileName: snapshot.fileName,
        timestamp: snapshot.timestamp
      });
    }

    if (chunk) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "loadLocal:chunk", {
        fileName: chunk.fileName,
        timestamp: chunk.timestamp,
        seqNo: chunk.seqNo
      });
    }

    ctx.success({
      hasSnapshot: state.hasSnapshot,
      hasChunk: state.hasChunk,
      hasDoc: !!state.doc,
      sequenceNumber: state.sequenceNumber
    });

    return state.doc;
  }

  /**
   * Load a remote device's document state from its snapshot + chunk.
   */
  async loadRemote(remoteDeviceId: string): Promise<Automerge.Doc<MarkdownDoc> | null> {
    return this.syncStorage.loadRemote(remoteDeviceId);
  }

  /**
   * Buffer an incremental change. Flushed to disk after debounce.
   */
  appendChange(change: Uint8Array): void {
    this.syncStorage.appendChange(change);
  }

  /**
   * Immediately flush all pending changes to the chunk file.
   */
  async flushChanges(): Promise<void> {
    const ctx = this.trace.startTrace("MdxDocumentStorage", "flushChanges", TraceType.FILE);

    try {
      const beforeFiles = await this.fs.readdir(this.metaDir).catch(() => []);
      const previousChunk = findLatestChunk(beforeFiles, this.deviceId);
      await this.syncStorage.flushChanges();
      const afterFiles = await this.fs.readdir(this.metaDir);
      const currentChunk = findLatestChunk(afterFiles, this.deviceId);
      const currentMeta = currentChunk
        ? parseChunkFileName(currentChunk.fileName)
        : null;

      if (currentChunk && currentMeta) {
        this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "flushChanges:written", {
          chunkFile: currentChunk.fileName,
          totalChanges: currentMeta.seqNo + 1,
          newChanges: currentMeta.seqNo + 1 - (previousChunk?.seqNo ?? -1) - 1,
        });
      }

      if (previousChunk && currentChunk && previousChunk.fileName !== currentChunk.fileName) {
        this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "flushChanges:deletedOldChunk", {
          oldChunk: previousChunk.fileName,
        });
      }

      ctx.success({
        totalChanges: currentMeta ? currentMeta.seqNo + 1 : 0,
        sequenceNumber: this.syncStorage.getSequenceNumber(),
      });
    } catch (err) {
      ctx.error(err instanceof Error ? err : String(err));
      throw err;
    }
  }

  /**
   * Compact: merge current device's chunk into a snapshot.
   */
  async compact(currentDoc: Automerge.Doc<MarkdownDoc>): Promise<void> {
    const ctx = this.trace.startTrace("MdxDocumentStorage", "compact", TraceType.FILE);

    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "compact:start", {
      binarySize: Automerge.save(currentDoc).length,
      sequenceNumber: this.syncStorage.getSequenceNumber(),
      lastCompactTimestamp: this.syncStorage.getLastCompactTimestamp()
    });

    await this.syncStorage.compact(currentDoc);
    const files = await this.fs.readdir(this.metaDir);
    const snapshot = findLatestSnapshot(files, this.deviceId);

    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "compact:snapshotWritten", {
      snapshotName: snapshot?.fileName
    });

    ctx.success({
      snapshotName: snapshot?.fileName,
      deletedSnapshots: Math.max(files.filter((f) => {
        const parsed = parseSnapshotFileName(f);
        return parsed && parsed.deviceId === this.deviceId;
      }).length - 1, 0),
      deletedChunks: files.filter((f) => {
        const parsed = parseChunkFileName(f);
        return parsed && parsed.deviceId === this.deviceId;
      }).length,
    });
  }

  /**
   * Check whether compaction should be triggered.
   */
  shouldCompact(): boolean {
    const totalSize = this.syncStorage.getPendingChangeBytes();

    let reason: string | null = null;
    if (totalSize > COMPACT_SIZE_THRESHOLD) {
      reason = 'size';
    } else if (this.syncStorage.getSequenceNumber() >= COMPACT_CHANGES_THRESHOLD) {
      reason = 'count';
    } else if (
      this.syncStorage.getLastCompactTimestamp() > 0 &&
      Date.now() - this.syncStorage.getLastCompactTimestamp() > COMPACT_AGE_THRESHOLD_MS
    ) {
      reason = 'age';
    }

    if (reason) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "shouldCompact", {
        shouldCompact: true,
        reason,
        totalSize,
        sequenceNumber: this.syncStorage.getSequenceNumber(),
        lastCompactAge: this.syncStorage.getLastCompactTimestamp() > 0
          ? Date.now() - this.syncStorage.getLastCompactTimestamp()
          : null
      });
    }

    return reason !== null;
  }

  /**
   * Atomically export index.md from the current document state (Dual-Write).
   */
  async exportIndexMd(doc: Automerge.Doc<MarkdownDoc>): Promise<void> {
    const content = doc.content ?? "";
    await this.fs.writeTextFile(this.indexTmpPath, content);
    await this.fs.rename(this.indexTmpPath, this.indexPath);

    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "exportIndexMd", {
      path: this.indexPath,
      contentLength: content.length
    });
  }

  /**
   * Read the current index.md file.
   * Returns null if it doesn't exist.
   */
  async readIndexMd(): Promise<string | null> {
    try {
      if (!await this.fs.exists(this.indexPath)) {
        return null;
      }
      const content = await this.fs.readTextFile(this.indexPath);
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "readIndexMd", {
        path: this.indexPath,
        contentLength: content.length
      });
      return content;
    } catch (error) {
      this.trace.log(TraceLevel.WARN, TraceType.FILE, "MdxDocumentStorage", "readIndexMd:error", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Save document state and export index.md in one call (Dual-Write).
   */
  async saveAndExport(doc: Automerge.Doc<MarkdownDoc>, changes: Uint8Array[]): Promise<void> {
    for (const change of changes) {
      this.appendChange(change);
    }
    await this.flushChanges();
    await this.exportIndexMd(doc);

    if (this.shouldCompact()) {
      await this.compact(doc);
    }
  }

  /**
   * List all device IDs that have data in the .mdx directory.
   */
  async listDeviceIds(): Promise<string[]> {
    await this.ensureDirectories();
    const result = await this.syncStorage.listDeviceIds();
    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxDocumentStorage", "listDeviceIds", {
      deviceIds: result,
      totalFiles: (await this.fs.readdir(this.metaDir)).length
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------
}

export {
  parseChunkFileName,
  parseSnapshotFileName,
};
