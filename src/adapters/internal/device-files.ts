import { next as Automerge } from '@automerge/automerge';
import type { MarkdownDoc } from '../../document/schema.js';
import type { FileSystemAdapter } from '../fs-adapter.js';
import {
  deserialiseChunk,
  deserialiseSnapshot,
  parseChunkFileName,
  parseSnapshotFileName,
} from '../../utils/filename-utils.js';

export interface DeviceChunkRef {
  fileName: string;
  timestamp: number;
  seqNo: number;
}

export interface DeviceSnapshotRef {
  fileName: string;
  timestamp: number;
}

export interface DeviceDocumentState {
  doc: Automerge.Doc<MarkdownDoc> | null;
  watermark: number;
  sequenceNumber: number;
  compactTimestamp: number;
  hasSnapshot: boolean;
  hasChunk: boolean;
}

export function findLatestChunk(files: string[], deviceId: string): DeviceChunkRef | null {
  let latest: DeviceChunkRef | null = null;

  for (const file of files) {
    const parsed = parseChunkFileName(file);
    if (!parsed || parsed.deviceId !== deviceId) continue;
    if (!latest || parsed.timestamp > latest.timestamp) {
      latest = { fileName: file, timestamp: parsed.timestamp, seqNo: parsed.seqNo };
    }
  }

  return latest;
}

export function findLatestSnapshot(files: string[], deviceId: string): DeviceSnapshotRef | null {
  let latest: DeviceSnapshotRef | null = null;

  for (const file of files) {
    const parsed = parseSnapshotFileName(file);
    if (!parsed || parsed.deviceId !== deviceId) continue;
    if (!latest || parsed.timestamp > latest.timestamp) {
      latest = { fileName: file, timestamp: parsed.timestamp };
    }
  }

  return latest;
}

export function collectDeviceIds(files: string[]): string[] {
  const deviceIds = new Set<string>();

  for (const file of files) {
    const chunkParsed = parseChunkFileName(file);
    if (chunkParsed) {
      deviceIds.add(chunkParsed.deviceId);
      continue;
    }

    const snapshotParsed = parseSnapshotFileName(file);
    if (snapshotParsed) {
      deviceIds.add(snapshotParsed.deviceId);
    }
  }

  return [...deviceIds];
}

export async function readDeviceDocumentState(
  fs: FileSystemAdapter,
  metaDir: string,
  files: string[],
  deviceId: string,
): Promise<DeviceDocumentState> {
  const snapshot = findLatestSnapshot(files, deviceId);
  let doc: Automerge.Doc<MarkdownDoc> | null = null;
  let watermark = -1;
  let sequenceNumber = 0;
  let compactTimestamp = 0;

  if (snapshot) {
    const data = await fs.readFile(`${metaDir}/${snapshot.fileName}`);
    const meta = deserialiseSnapshot(data);
    doc = Automerge.load<MarkdownDoc>(meta.binary);
    watermark = meta.watermark;
    compactTimestamp = meta.timestamp;
  }

  const chunk = findLatestChunk(files, deviceId);
  if (chunk) {
    const data = await fs.readFile(`${metaDir}/${chunk.fileName}`);
    const chunkMeta = deserialiseChunk(data);
    const changesToApply = watermark >= 0
      ? chunkMeta.changes.slice(watermark + 1)
      : chunkMeta.changes;

    if (changesToApply.length > 0) {
      if (!doc) {
        doc = Automerge.init<MarkdownDoc>();
      }

      for (const change of changesToApply) {
        const [applied]: [Automerge.Doc<MarkdownDoc>] = Automerge.applyChanges(doc, [change]);
        doc = applied;
      }
    }

    sequenceNumber = chunkMeta.sequenceNumber;
  }

  return {
    doc,
    watermark,
    sequenceNumber,
    compactTimestamp,
    hasSnapshot: !!snapshot,
    hasChunk: !!chunk,
  };
}
