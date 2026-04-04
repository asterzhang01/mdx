export * from './document/schema.js';
export * from './document/document-utils.js';
// Generic Automerge sync layer
export { AutomergeSyncEngine, createAutomergeSyncEngine } from './sync/automerge-sync-engine.js';
export type { AutomergeSyncEngineOptions } from './sync/automerge-sync-engine.js';
export * from './sync/schema.js';
// File-system adapters
export * from './fs/fs-adapter.js';
export * from './fs/memory-fs-adapter.js';
export * from './fs/node-fs-adapter.js';
export * from './utils/trace.js';
export * from './utils/image-processing.js';
// Core sync engine - main entry point for .mdx documents
export { FileSyncEngine } from './core/file-sync-engine.js';
export type { LoadResult, ChangeResult } from './core/file-sync-engine.js';
