/**
 * MdxStorageAdapter
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
import type { FileSystemAdapter } from "./fs-adapter.js";
import type { MarkdownDoc, ChunkFileMetadata, SnapshotFileMetadata } from "../document/schema.js";
import { getGlobalTraceManager, TraceLevel, TraceType } from "../utils/trace.js";
import {
  chunkFileName,
  snapshotFileName,
  parseChunkFileName,
  parseSnapshotFileName,
  serialiseChunk,
  deserialiseChunk,
  serialiseSnapshot,
} from "../utils/filename-utils.js";
import { createStoragePaths } from "./internal/storage-paths.js";
import {
  collectDeviceIds,
  findLatestChunk,
  findLatestSnapshot,
  readDeviceDocumentState,
} from "./internal/device-files.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;
const COMPACT_SIZE_THRESHOLD = 1_048_576; // 1 MB
const COMPACT_CHANGES_THRESHOLD = 500;
const COMPACT_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// MdxStorageAdapter
// ---------------------------------------------------------------------------

export class MdxStorageAdapter {
  private readonly basePath: string;
  private readonly metaDir: string;
  private readonly assetsDir: string;
  private readonly indexPath: string;
  private readonly indexTmpPath: string;
  private readonly fs: FileSystemAdapter;
  private readonly deviceId: string;

  /** In-memory buffer of uncommitted changes */
  private pendingChanges: Uint8Array[] = [];
  private sequenceNumber = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCompactTimestamp = 0;

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

    this.trace.log(TraceLevel.DEBUG, TraceType.LIFECYCLE, "MdxStorageAdapter", "constructor", {
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
    await this.fs.mkdir(this.metaDir);
    await this.fs.mkdir(this.assetsDir);
    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "ensureDirectories", {
      metaDir: this.metaDir,
      assetsDir: this.assetsDir
    });
  }

  /**
   * Load the current device's document state from its snapshot + chunk.
   * Returns null if no data exists for this device.
   */
  async loadLocal(): Promise<Automerge.Doc<MarkdownDoc> | null> {
    const ctx = this.trace.startTrace("MdxStorageAdapter", "loadLocal", TraceType.FILE);

    await this.ensureDirectories();
    const files = await this.fs.readdir(this.metaDir);
    const state = await readDeviceDocumentState(this.fs, this.metaDir, files, this.deviceId);
    const snapshot = findLatestSnapshot(files, this.deviceId);
    const chunk = findLatestChunk(files, this.deviceId);

    if (snapshot) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "loadLocal:snapshot", {
        fileName: snapshot.fileName,
        timestamp: snapshot.timestamp
      });
    }

    if (chunk) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "loadLocal:chunk", {
        fileName: chunk.fileName,
        timestamp: chunk.timestamp,
        seqNo: chunk.seqNo
      });
    }

    this.sequenceNumber = state.sequenceNumber;
    this.lastCompactTimestamp = state.compactTimestamp;

    ctx.success({
      hasSnapshot: state.hasSnapshot,
      hasChunk: state.hasChunk,
      hasDoc: !!state.doc,
      sequenceNumber: this.sequenceNumber
    });

    return state.doc;
  }

  /**
   * Load a remote device's document state from its snapshot + chunk.
   */
  async loadRemote(remoteDeviceId: string): Promise<Automerge.Doc<MarkdownDoc> | null> {
    await this.ensureDirectories();
    const files = await this.fs.readdir(this.metaDir);
    const state = await readDeviceDocumentState(this.fs, this.metaDir, files, remoteDeviceId);
    return state.doc;
  }

  /**
   * Buffer an incremental change. Flushed to disk after debounce.
   */
  appendChange(change: Uint8Array): void {
    this.pendingChanges.push(change);

    this.trace.log(TraceLevel.DEBUG, TraceType.CRDT, "MdxStorageAdapter", "appendChange", {
      changeSize: change.length,
      pendingCount: this.pendingChanges.length
    });

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flushChanges().catch((error) => {
        this.trace.error("MdxStorageAdapter", "appendChange:debounceFlush", error instanceof Error ? error : new Error(String(error)));
      });
    }, DEBOUNCE_MS);
  }

  /**
   * Immediately flush all pending changes to the chunk file.
   */
  async flushChanges(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pendingChanges.length === 0) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "flushChanges:noChanges", {});
      return;
    }

    const ctx = this.trace.startTrace("MdxStorageAdapter", "flushChanges", TraceType.FILE);
    const changesToWrite = this.pendingChanges;
    this.pendingChanges = [];

    try {
      await this.ensureDirectories();

      // Load existing chunk for this device (if any) and merge
      const files = await this.fs.readdir(this.metaDir);
      const existingChunk = findLatestChunk(files, this.deviceId);
      let allChanges: Uint8Array[] = [];

      if (existingChunk) {
        const data = await this.fs.readFile(`${this.metaDir}/${existingChunk.fileName}`);
        const existing = deserialiseChunk(data);
        allChanges = existing.changes;
      }

      allChanges.push(...changesToWrite);
      this.sequenceNumber = allChanges.length - 1;

      const timestamp = Date.now();
      const newChunkName = chunkFileName(this.deviceId, timestamp, this.sequenceNumber);

      const meta: ChunkFileMetadata = {
        deviceId: this.deviceId,
        timestamp,
        sequenceNumber: this.sequenceNumber,
        changes: allChanges,
      };

      // Atomic write: tmp → rename
      const tmpPath = `${this.metaDir}/${newChunkName}.tmp`;
      const finalPath = `${this.metaDir}/${newChunkName}`;
      await this.fs.writeFile(tmpPath, serialiseChunk(meta));
      await this.fs.rename(tmpPath, finalPath);

      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "flushChanges:written", {
        chunkFile: newChunkName,
        totalChanges: allChanges.length,
        newChanges: changesToWrite.length
      });

      // Delete old chunk files for this device
      if (existingChunk) {
        try {
          await this.fs.unlink(`${this.metaDir}/${existingChunk.fileName}`);
          this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "flushChanges:deletedOldChunk", {
            oldChunk: existingChunk.fileName
          });
        } catch {
          // Lazy cleanup — will be cleaned up on next write
        }
      }

      ctx.success({ totalChanges: allChanges.length, sequenceNumber: this.sequenceNumber });
    } catch (err) {
      ctx.error(err instanceof Error ? err : String(err));
      throw err;
    }
  }

  /**
   * Compact: merge current device's chunk into a snapshot.
   */
  async compact(currentDoc: Automerge.Doc<MarkdownDoc>): Promise<void> {
    const ctx = this.trace.startTrace("MdxStorageAdapter", "compact", TraceType.FILE);

    const timestamp = Date.now();
    const binary = Automerge.save(currentDoc);

    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "compact:start", {
      binarySize: binary.length,
      sequenceNumber: this.sequenceNumber,
      lastCompactTimestamp: this.lastCompactTimestamp
    });

    const snapshotMeta: SnapshotFileMetadata = {
      deviceId: this.deviceId,
      timestamp,
      watermark: this.sequenceNumber,
      binary,
    };

    // Atomic write snapshot
    const snapshotName = snapshotFileName(this.deviceId, timestamp);
    const tmpPath = `${this.metaDir}/${snapshotName}.tmp`;
    const finalPath = `${this.metaDir}/${snapshotName}`;
    await this.fs.writeFile(tmpPath, serialiseSnapshot(snapshotMeta));
    await this.fs.rename(tmpPath, finalPath);

    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "compact:snapshotWritten", {
      snapshotName
    });

    // Delete old snapshot for this device
    const files = await this.fs.readdir(this.metaDir);
    const oldSnapshots = files.filter((f) => {
      const parsed = parseSnapshotFileName(f);
      return parsed && parsed.deviceId === this.deviceId && f !== snapshotName;
    });
    for (const old of oldSnapshots) {
      try {
        await this.fs.unlink(`${this.metaDir}/${old}`);
      } catch {
        // Lazy cleanup
      }
    }

    // Delete chunk for this device (snapshot now contains everything)
    const oldChunks = files.filter((f) => {
      const parsed = parseChunkFileName(f);
      return parsed && parsed.deviceId === this.deviceId;
    });
    for (const old of oldChunks) {
      try {
        await this.fs.unlink(`${this.metaDir}/${old}`);
      } catch {
        // Lazy cleanup
      }
    }

    // Reset in-memory state
    this.pendingChanges = [];
    this.sequenceNumber = 0;
    this.lastCompactTimestamp = timestamp;

    ctx.success({
      snapshotName,
      deletedSnapshots: oldSnapshots.length,
      deletedChunks: oldChunks.length
    });
  }

  /**
   * Check whether compaction should be triggered.
   */
  shouldCompact(): boolean {
    const files = this.pendingChanges; // approximate — real check reads chunk from disk
    const totalSize = files.reduce((sum, c) => sum + c.length, 0);

    let reason: string | null = null;
    if (totalSize > COMPACT_SIZE_THRESHOLD) {
      reason = 'size';
    } else if (this.sequenceNumber >= COMPACT_CHANGES_THRESHOLD) {
      reason = 'count';
    } else if (this.lastCompactTimestamp > 0 && Date.now() - this.lastCompactTimestamp > COMPACT_AGE_THRESHOLD_MS) {
      reason = 'age';
    }

    if (reason) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "shouldCompact", {
        shouldCompact: true,
        reason,
        totalSize,
        sequenceNumber: this.sequenceNumber,
        lastCompactAge: this.lastCompactTimestamp > 0 ? Date.now() - this.lastCompactTimestamp : null
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

    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "exportIndexMd", {
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
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "readIndexMd", {
        path: this.indexPath,
        contentLength: content.length
      });
      return content;
    } catch (error) {
      this.trace.log(TraceLevel.WARN, TraceType.FILE, "MdxStorageAdapter", "readIndexMd:error", {
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
    const files = await this.fs.readdir(this.metaDir);
    const result = collectDeviceIds(files);
    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "listDeviceIds", {
      deviceIds: result,
      totalFiles: files.length
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
