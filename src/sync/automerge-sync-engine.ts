import { next as Automerge } from "@automerge/automerge";
import type { FileSystemAdapter } from "../fs/fs-adapter.js";
import type { ChunkFileMetadata, SnapshotFileMetadata } from "./schema.js";
import { getGlobalTraceManager, TraceLevel, TraceType } from "../utils/trace.js";
import {
  chunkFileName,
  deserialiseChunk,
  parseChunkFileName,
  parseSnapshotFileName,
  serialiseChunk,
  serialiseSnapshot,
} from "../utils/filename-utils.js";
import {
  collectDeviceIds,
  findLatestChunk,
  readDeviceDocumentState,
  type DeviceDocumentState,
} from "../storage/internal/device-files.js";

const DEFAULT_DEBOUNCE_MS = 500;

export interface AutomergeSyncEngineOptions {
  metaDir: string;
  fs: FileSystemAdapter;
  deviceId: string;
  traceComponent?: string;
  debounceMs?: number;
}

export class AutomergeSyncEngine<TDoc extends object> {
  private readonly metaDir: string;
  private readonly fs: FileSystemAdapter;
  private readonly deviceId: string;
  private readonly traceComponent: string;
  private readonly debounceMs: number;

  private pendingChanges: Uint8Array[] = [];
  private sequenceNumber = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCompactTimestamp = 0;

  private readonly trace = getGlobalTraceManager();

  constructor(options: AutomergeSyncEngineOptions) {
    this.metaDir = options.metaDir;
    this.fs = options.fs;
    this.deviceId = options.deviceId;
    this.traceComponent = options.traceComponent ?? "AutomergeSyncEngine";
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async ensureDirectories(): Promise<void> {
    await this.fs.mkdir(this.metaDir);
  }

  async loadLocalState(): Promise<DeviceDocumentState<TDoc>> {
    await this.ensureDirectories();
    const files = await this.fs.readdir(this.metaDir);
    const state = await readDeviceDocumentState<TDoc>(this.fs, this.metaDir, files, this.deviceId);
    this.sequenceNumber = state.sequenceNumber;
    this.lastCompactTimestamp = state.compactTimestamp;
    return state;
  }

  async loadLocal(): Promise<Automerge.Doc<TDoc> | null> {
    const state = await this.loadLocalState();
    return state.doc;
  }

  async loadRemoteState(remoteDeviceId: string): Promise<DeviceDocumentState<TDoc>> {
    await this.ensureDirectories();
    const files = await this.fs.readdir(this.metaDir);
    return readDeviceDocumentState<TDoc>(this.fs, this.metaDir, files, remoteDeviceId);
  }

  async loadRemote(remoteDeviceId: string): Promise<Automerge.Doc<TDoc> | null> {
    const state = await this.loadRemoteState(remoteDeviceId);
    return state.doc;
  }

  async mergeAll(localDoc: Automerge.Doc<TDoc> | null): Promise<Automerge.Doc<TDoc> | null> {
    const deviceIds = await this.listDeviceIds();
    const remoteDeviceIds = deviceIds.filter((deviceId) => deviceId !== this.deviceId);

    let mergedDoc = localDoc;
    for (const remoteDeviceId of remoteDeviceIds) {
      const remoteDoc = await this.loadRemote(remoteDeviceId);
      if (!remoteDoc) {
        continue;
      }

      if (!mergedDoc) {
        mergedDoc = remoteDoc;
      } else {
        mergedDoc = Automerge.merge(mergedDoc, remoteDoc);
      }
    }

    return mergedDoc;
  }

  async loadMerged(): Promise<Automerge.Doc<TDoc> | null> {
    const localDoc = await this.loadLocal();
    return this.mergeAll(localDoc);
  }

  appendChange(change: Uint8Array): void {
    this.pendingChanges.push(change);

    this.trace.log(TraceLevel.DEBUG, TraceType.CRDT, this.traceComponent, "appendChange", {
      changeSize: change.length,
      pendingCount: this.pendingChanges.length,
    });

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushChanges().catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.trace.error(this.traceComponent, "appendChange:debounceFlush", normalized);
      });
    }, this.debounceMs);
  }

  async flushChanges(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pendingChanges.length === 0) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, this.traceComponent, "flushChanges:noChanges", {});
      return;
    }

    const changesToWrite = this.pendingChanges;
    this.pendingChanges = [];
    await this.ensureDirectories();

    const files = await this.fs.readdir(this.metaDir);
    const existingChunk = findLatestChunk(files, this.deviceId);
    let allChanges: Uint8Array[] = [];

    if (existingChunk) {
      try {
        const data = await this.fs.readFile(`${this.metaDir}/${existingChunk.fileName}`);
        const existing = deserialiseChunk(data);
        allChanges = existing.changes;
      } catch {
        allChanges = [];
      }
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

    const tmpPath = `${this.metaDir}/${newChunkName}.tmp`;
    const finalPath = `${this.metaDir}/${newChunkName}`;
    await this.fs.writeFile(tmpPath, serialiseChunk(meta));
    await this.fs.rename(tmpPath, finalPath);

    const staleChunks = files.filter((file) => {
      const parsed = parseChunkFileName(file);
      return parsed && parsed.deviceId === this.deviceId && file !== newChunkName;
    });

    for (const staleChunk of staleChunks) {
      try {
        await this.fs.unlink(`${this.metaDir}/${staleChunk}`);
      } catch {
        // Lazy cleanup
      }
    }
  }

  async compact(doc: Automerge.Doc<TDoc>): Promise<void> {
    await this.ensureDirectories();

    const timestamp = Date.now();
    const binary = Automerge.save(doc);
    const snapshotMeta: SnapshotFileMetadata = {
      deviceId: this.deviceId,
      timestamp,
      watermark: this.sequenceNumber,
      binary,
    };

    const snapshotName = `${this.deviceId}-${timestamp}.snapshot`;
    const tmpPath = `${this.metaDir}/${snapshotName}.tmp`;
    const finalPath = `${this.metaDir}/${snapshotName}`;
    await this.fs.writeFile(tmpPath, serialiseSnapshot(snapshotMeta));
    await this.fs.rename(tmpPath, finalPath);

    const files = await this.fs.readdir(this.metaDir);
    const oldSnapshots = files.filter((file) => {
      const parsed = parseSnapshotFileName(file);
      return parsed && parsed.deviceId === this.deviceId && file !== snapshotName;
    });
    for (const oldSnapshot of oldSnapshots) {
      try {
        await this.fs.unlink(`${this.metaDir}/${oldSnapshot}`);
      } catch {
        // Lazy cleanup
      }
    }

    const oldChunks = files.filter((file) => {
      const parsed = parseChunkFileName(file);
      return parsed && parsed.deviceId === this.deviceId;
    });
    for (const oldChunk of oldChunks) {
      try {
        await this.fs.unlink(`${this.metaDir}/${oldChunk}`);
      } catch {
        // Lazy cleanup
      }
    }

    this.pendingChanges = [];
    this.sequenceNumber = 0;
    this.lastCompactTimestamp = timestamp;
  }

  async listDeviceIds(): Promise<string[]> {
    await this.ensureDirectories();
    const files = await this.fs.readdir(this.metaDir);
    return collectDeviceIds(files);
  }

  getSequenceNumber(): number {
    return this.sequenceNumber;
  }

  getLastCompactTimestamp(): number {
    return this.lastCompactTimestamp;
  }

  getPendingChangeBytes(): number {
    return this.pendingChanges.reduce((total, change) => total + change.length, 0);
  }
}

export function createAutomergeSyncEngine<TDoc extends object>(
  options: AutomergeSyncEngineOptions,
): AutomergeSyncEngine<TDoc> {
  return new AutomergeSyncEngine<TDoc>(options);
}
