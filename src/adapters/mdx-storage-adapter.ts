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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;
const COMPACT_SIZE_THRESHOLD = 1_048_576; // 1 MB
const COMPACT_CHANGES_THRESHOLD = 500;
const COMPACT_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// File-name helpers
// ---------------------------------------------------------------------------

function chunkFileName(deviceId: string, timestamp: number, seqNo: number): string {
  const paddedSeqNo = String(seqNo).padStart(4, "0");
  return `${deviceId}-${timestamp}-${paddedSeqNo}.chunk`;
}

function snapshotFileName(deviceId: string, timestamp: number): string {
  return `${deviceId}-${timestamp}.snapshot`;
}

function parseChunkFileName(name: string): { deviceId: string; timestamp: number; seqNo: number } | null {
  const match = name.match(/^(.+)-(\d{13})-(\d{4})\.chunk$/);
  if (!match) return null;
  return { deviceId: match[1], timestamp: Number(match[2]), seqNo: Number(match[3]) };
}

function parseSnapshotFileName(name: string): { deviceId: string; timestamp: number } | null {
  const match = name.match(/^(.+)-(\d{13})\.snapshot$/);
  if (!match) return null;
  return { deviceId: match[1], timestamp: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// Serialisation helpers (chunk / snapshot envelope)
// ---------------------------------------------------------------------------

/**
 * Encode a ChunkFileMetadata into a single Uint8Array.
 *
 * Layout:
 *   [4 bytes header length (LE)] [JSON header] [change₁ length (4 LE)] [change₁] …
 */
function serialiseChunk(meta: ChunkFileMetadata): Uint8Array {
  const header = JSON.stringify({
    deviceId: meta.deviceId,
    timestamp: meta.timestamp,
    sequenceNumber: meta.sequenceNumber,
  });
  const headerBytes = new TextEncoder().encode(header);

  let totalSize = 4 + headerBytes.length;
  for (const change of meta.changes) {
    totalSize += 4 + change.length;
  }

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  // header length + header
  view.setUint32(offset, headerBytes.length, true);
  offset += 4;
  buffer.set(headerBytes, offset);
  offset += headerBytes.length;

  // changes
  for (const change of meta.changes) {
    view.setUint32(offset, change.length, true);
    offset += 4;
    buffer.set(change, offset);
    offset += change.length;
  }

  return buffer;
}

function deserialiseChunk(data: Uint8Array): ChunkFileMetadata {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const headerLen = view.getUint32(offset, true);
  offset += 4;
  const headerBytes = data.slice(offset, offset + headerLen);
  offset += headerLen;
  const header = JSON.parse(new TextDecoder().decode(headerBytes));

  const changes: Uint8Array[] = [];
  while (offset < data.length) {
    const changeLen = view.getUint32(offset, true);
    offset += 4;
    changes.push(data.slice(offset, offset + changeLen));
    offset += changeLen;
  }

  return {
    deviceId: header.deviceId,
    timestamp: header.timestamp,
    sequenceNumber: header.sequenceNumber,
    changes,
  };
}

/**
 * Encode a SnapshotFileMetadata into a single Uint8Array.
 *
 * Layout: [4 bytes header length (LE)] [JSON header] [binary]
 */
function serialiseSnapshot(meta: SnapshotFileMetadata): Uint8Array {
  const header = JSON.stringify({
    deviceId: meta.deviceId,
    timestamp: meta.timestamp,
    watermark: meta.watermark,
  });
  const headerBytes = new TextEncoder().encode(header);

  const buffer = new Uint8Array(4 + headerBytes.length + meta.binary.length);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, headerBytes.length, true);
  buffer.set(headerBytes, 4);
  buffer.set(meta.binary, 4 + headerBytes.length);

  return buffer;
}

function deserialiseSnapshot(data: Uint8Array): SnapshotFileMetadata {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLen = view.getUint32(0, true);
  const headerBytes = data.slice(4, 4 + headerLen);
  const header = JSON.parse(new TextDecoder().decode(headerBytes));
  const binary = data.slice(4 + headerLen);

  return {
    deviceId: header.deviceId,
    timestamp: header.timestamp,
    watermark: header.watermark,
    binary,
  };
}

// ---------------------------------------------------------------------------
// MdxStorageAdapter
// ---------------------------------------------------------------------------

export class MdxStorageAdapter {
  private readonly basePath: string;
  private readonly metaDir: string;
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
    this.basePath = basePath;
    this.metaDir = `${basePath}/.mdx`;
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
    await this.fs.mkdir(`${this.basePath}/assets`);
    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "ensureDirectories", {
      metaDir: this.metaDir,
      assetsDir: `${this.basePath}/assets`
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

    // Find latest snapshot for this device
    const snapshot = this.findLatestSnapshot(files, this.deviceId);
    let doc: Automerge.Doc<MarkdownDoc> | null = null;
    let watermark = -1;

    if (snapshot) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "loadLocal:snapshot", {
        fileName: snapshot.fileName,
        timestamp: snapshot.timestamp
      });
      const data = await this.fs.readFile(`${this.metaDir}/${snapshot.fileName}`);
      const meta = deserialiseSnapshot(data);
      doc = Automerge.load<MarkdownDoc>(meta.binary);
      watermark = meta.watermark;
      this.lastCompactTimestamp = meta.timestamp;
    }

    // Find latest chunk for this device
    const chunk = this.findLatestChunk(files, this.deviceId);
    if (chunk) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "loadLocal:chunk", {
        fileName: chunk.fileName,
        timestamp: chunk.timestamp,
        seqNo: chunk.seqNo
      });
      const data = await this.fs.readFile(`${this.metaDir}/${chunk.fileName}`);
      const chunkMeta = deserialiseChunk(data);

      // Apply only changes after the watermark
      const changesToApply = watermark >= 0
        ? chunkMeta.changes.slice(watermark + 1)
        : chunkMeta.changes;

      if (changesToApply.length > 0) {
        this.trace.log(TraceLevel.DEBUG, TraceType.CRDT, "MdxStorageAdapter", "loadLocal:applyChanges", {
          changesCount: changesToApply.length,
          watermark
        });
        if (!doc) {
          doc = Automerge.init<MarkdownDoc>();
        }
        for (const change of changesToApply) {
          const [applied]: [Automerge.Doc<MarkdownDoc>] = Automerge.applyChanges(doc!, [change]);
          doc = applied;
        }
      }

      this.sequenceNumber = chunkMeta.sequenceNumber;
    }

    ctx.success({
      hasSnapshot: !!snapshot,
      hasChunk: !!chunk,
      hasDoc: !!doc,
      sequenceNumber: this.sequenceNumber
    });

    return doc;
  }

  /**
   * Load a remote device's document state from its snapshot + chunk.
   */
  async loadRemote(remoteDeviceId: string): Promise<Automerge.Doc<MarkdownDoc> | null> {
    const files = await this.fs.readdir(this.metaDir);

    const snapshot = this.findLatestSnapshot(files, remoteDeviceId);
    let doc: Automerge.Doc<MarkdownDoc> | null = null;
    let watermark = -1;

    if (snapshot) {
      const data = await this.fs.readFile(`${this.metaDir}/${snapshot.fileName}`);
      const meta = deserialiseSnapshot(data);
      doc = Automerge.load<MarkdownDoc>(meta.binary);
      watermark = meta.watermark;
    }

    const chunk = this.findLatestChunk(files, remoteDeviceId);
    if (chunk) {
      const data = await this.fs.readFile(`${this.metaDir}/${chunk.fileName}`);
      const chunkMeta = deserialiseChunk(data);

      const changesToApply = watermark >= 0
        ? chunkMeta.changes.slice(watermark + 1)
        : chunkMeta.changes;

      if (changesToApply.length > 0) {
        if (!doc) {
          doc = Automerge.init<MarkdownDoc>();
        }
        for (const change of changesToApply) {
          const [applied]: [Automerge.Doc<MarkdownDoc>] = Automerge.applyChanges(doc!, [change]);
          doc = applied;
        }
      }
    }

    return doc;
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
      const existingChunk = this.findLatestChunk(files, this.deviceId);
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
    const tmpPath = `${this.basePath}/index.md.tmp`;
    const finalPath = `${this.basePath}/index.md`;
    await this.fs.writeTextFile(tmpPath, content);
    await this.fs.rename(tmpPath, finalPath);

    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "exportIndexMd", {
      path: finalPath,
      contentLength: content.length
    });
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
    const deviceIds = new Set<string>();

    for (const file of files) {
      const chunkParsed = parseChunkFileName(file);
      if (chunkParsed) {
        deviceIds.add(chunkParsed.deviceId);
        continue;
      }
      const snapParsed = parseSnapshotFileName(file);
      if (snapParsed) {
        deviceIds.add(snapParsed.deviceId);
      }
    }

    const result = [...deviceIds];
    this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdxStorageAdapter", "listDeviceIds", {
      deviceIds: result,
      totalFiles: files.length
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private findLatestChunk(
    files: string[],
    deviceId: string
  ): { fileName: string; timestamp: number; seqNo: number } | null {
    let latest: { fileName: string; timestamp: number; seqNo: number } | null = null;

    for (const file of files) {
      const parsed = parseChunkFileName(file);
      if (!parsed || parsed.deviceId !== deviceId) continue;
      if (!latest || parsed.timestamp > latest.timestamp) {
        latest = { fileName: file, timestamp: parsed.timestamp, seqNo: parsed.seqNo };
      }
    }

    return latest;
  }

  private findLatestSnapshot(
    files: string[],
    deviceId: string
  ): { fileName: string; timestamp: number } | null {
    let latest: { fileName: string; timestamp: number } | null = null;

    for (const file of files) {
      const parsed = parseSnapshotFileName(file);
      if (!parsed || parsed.deviceId !== deviceId) continue;
      if (!latest || parsed.timestamp > latest.timestamp) {
        latest = { fileName: file, timestamp: parsed.timestamp };
      }
    }

    return latest;
  }
}

// Re-export helpers for testing
export {
  chunkFileName,
  snapshotFileName,
  parseChunkFileName,
  parseSnapshotFileName,
  serialiseChunk,
  deserialiseChunk,
  serialiseSnapshot,
  deserialiseSnapshot,
};
