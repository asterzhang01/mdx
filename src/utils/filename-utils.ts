/**
 * Filename utilities for .mdx format
 *
 * Helpers for parsing and generating chunk/snapshot filenames
 * used in the CRDT sync protocol.
 */

import type { ChunkFileMetadata, SnapshotFileMetadata } from "../sync/schema.js";

// ---------------------------------------------------------------------------
// File name generation
// ---------------------------------------------------------------------------

/**
 * Generate a chunk filename.
 * Format: {deviceId}-{timestamp}-{seqNo}.chunk
 */
export function chunkFileName(deviceId: string, timestamp: number, seqNo: number): string {
  const paddedSeqNo = String(seqNo).padStart(4, "0");
  return `${deviceId}-${timestamp}-${paddedSeqNo}.chunk`;
}

/**
 * Generate a snapshot filename.
 * Format: {deviceId}-{timestamp}.snapshot
 */
export function snapshotFileName(deviceId: string, timestamp: number): string {
  return `${deviceId}-${timestamp}.snapshot`;
}

// ---------------------------------------------------------------------------
// File name parsing
// ---------------------------------------------------------------------------

/**
 * Parse a chunk filename to extract metadata.
 * Returns null if the filename doesn't match the expected format.
 */
export function parseChunkFileName(name: string): { deviceId: string; timestamp: number; seqNo: number } | null {
  const match = name.match(/^(.+)-(\d{13})-(\d{4})\.chunk$/);
  if (!match) return null;
  return { deviceId: match[1], timestamp: Number(match[2]), seqNo: Number(match[3]) };
}

/**
 * Parse a snapshot filename to extract metadata.
 * Returns null if the filename doesn't match the expected format.
 */
export function parseSnapshotFileName(name: string): { deviceId: string; timestamp: number } | null {
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
export function serialiseChunk(meta: ChunkFileMetadata): Uint8Array {
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

/**
 * Decode a Uint8Array to ChunkFileMetadata.
 */
export function deserialiseChunk(data: Uint8Array): ChunkFileMetadata {
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
export function serialiseSnapshot(meta: SnapshotFileMetadata): Uint8Array {
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

/**
 * Decode a Uint8Array to SnapshotFileMetadata.
 */
export function deserialiseSnapshot(data: Uint8Array): SnapshotFileMetadata {
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
