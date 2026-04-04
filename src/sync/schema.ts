/**
 * Sync protocol envelope types for Automerge-backed file persistence.
 *
 * These types belong to the generic sync layer rather than any specific
 * document model.
 */

/**
 * Chunk file metadata persisted inside a sync metadata directory.
 * Each device writes exactly one chunk file at a time.
 */
export type ChunkFileMetadata = {
  deviceId: string;
  timestamp: number;
  sequenceNumber: number;
  changes: Uint8Array[];
};

/**
 * Snapshot file metadata persisted inside a sync metadata directory.
 * Contains a full Automerge.save() binary plus a watermark.
 */
export type SnapshotFileMetadata = {
  deviceId: string;
  timestamp: number;
  watermark: number;
  binary: Uint8Array;
};
