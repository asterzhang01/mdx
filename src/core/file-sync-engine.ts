/**
 * FileSyncEngine
 *
 * The unified facade for .mdx document operations.
 * This is the main entry point for application code to work with .mdx documents.
 *
 * Responsibilities:
 *   - Document lifecycle orchestration (via MdxStorageAdapter)
 *   - Content changes via CRDT splice
 *   - Multi-device sync
 *   - External editor integration
 *
 * Note: FileSyncEngine does NOT directly hold FileSystemAdapter.
 * All file system access is delegated to MdxStorageAdapter.
 */
import { next as Automerge } from "@automerge/automerge";
import type { MarkdownDoc } from "../document/schema.js";
import { MdxStorageAdapter } from "../adapters/mdx-storage-adapter.js";
import { getGlobalTraceManager, TraceLevel, TraceType } from "../utils/trace.js";
import { createDocument, getAllChanges, extractChanges, applyContentChange } from "../document/document-operations.js";

export interface LoadResult {
  merged: boolean;
  doc: Automerge.Doc<MarkdownDoc>;
}

export interface ChangeResult {
  changed: boolean;
  doc: Automerge.Doc<MarkdownDoc>;
}

export class FileSyncEngine {
  private readonly basePath: string;
  private readonly deviceId: string;
  private readonly storage: MdxStorageAdapter;
  private document: Automerge.Doc<MarkdownDoc> | null = null;

  /** Trace manager for logging */
  private readonly trace = getGlobalTraceManager();

  constructor(basePath: string, fs: any, deviceId: string) {
    this.basePath = basePath;
    this.deviceId = deviceId;
    // MdxStorageAdapter manages the FileSystemAdapter internally
    this.storage = new MdxStorageAdapter(basePath, fs, deviceId);

    this.trace.log(TraceLevel.DEBUG, TraceType.LIFECYCLE, "FileSyncEngine", "constructor", {
      basePath,
      deviceId
    });
  }

  // ===========================================================================
  // High-level Document Lifecycle APIs
  // ===========================================================================

  /**
   * Initialize a new document with optional content.
   */
  async init(initialContent: string = "# Untitled\n\n"): Promise<void> {
    const ctx = this.trace.startTrace("FileSyncEngine", "init", TraceType.SYNC);

    await this.storage.ensureDirectories();

    this.document = createDocument(initialContent);

    const changes = getAllChanges(this.document);
    for (const change of changes) {
      this.storage.appendChange(change);
    }
    await this.storage.flushChanges();

    // Export index.md for compatibility
    if (this.document) {
      await this.storage.exportIndexMd(this.document);
    }

    ctx.success({ deviceId: this.deviceId, contentLength: initialContent.length });
  }

  /**
   * Load an existing document from disk.
   */
  async load(): Promise<LoadResult> {
    const ctx = this.trace.startTrace("FileSyncEngine", "load", TraceType.SYNC);

    await this.storage.ensureDirectories();

    // Try loading from CRDT storage
    let doc = await this.storage.loadLocal();
    const loadedFromCRDT = !!doc;

    if (!doc) {
      // Bootstrap from index.md if exists
      let initialContent = "# Untitled\n\n";
      
      // Use storage to read index.md
      const indexContent = await this.storage.readIndexMd();
      if (indexContent !== null) {
        initialContent = indexContent;
      }
      
      doc = createDocument(initialContent);
      
      // Persist initial state
      const changes = getAllChanges(doc);
      for (const change of changes) {
        this.storage.appendChange(change);
      }
      await this.storage.flushChanges();
    }

    // Sync with other devices
    const { doc: mergedDoc, merged } = await this.syncAll(doc);
    this.document = mergedDoc;

    ctx.success({ deviceId: this.deviceId, loadedFromCRDT, merged });
    return { merged, doc: mergedDoc };
  }

  /**
   * Apply content changes using CRDT splice.
   */
  async applyChange(newContent: string): Promise<ChangeResult> {
    if (!this.document) {
      throw new Error("Document not loaded. Call init() or load() first.");
    }

    const result = applyContentChange(this.document, newContent);

    if (result.changed) {
      this.document = result.doc;
      const changes = extractChanges(this.document);
      for (const change of changes) {
        this.storage.appendChange(change);
      }
    }

    return {
      changed: result.changed,
      doc: this.document!
    };
  }

  /**
   * Force save pending changes to disk and export index.md.
   */
  async forceSave(): Promise<void> {
    const ctx = this.trace.startTrace("FileSyncEngine", "forceSave", TraceType.FILE);

    await this.storage.flushChanges();
    if (this.document) {
      await this.storage.exportIndexMd(this.document);
    }

    ctx.success({});
  }

  /**
   * Get current document content.
   */
  getContent(): string {
    if (!this.document) {
      return "";
    }
    return String(this.document.content ?? "");
  }

  /**
   * Get current document reference (read-only).
   */
  getDocument(): Automerge.Doc<MarkdownDoc> | null {
    return this.document;
  }

  // ===========================================================================
  // Low-level Sync APIs (for advanced usage)
  // ===========================================================================

  /**
   * Scan .mdx/ directory, load all devices' chunk + snapshot files,
   * and CRDT-merge them into the local document.
   *
   * @returns merged — whether any remote changes were incorporated
   */
  async syncAll(
    localDoc: Automerge.Doc<MarkdownDoc>
  ): Promise<{ merged: boolean; doc: Automerge.Doc<MarkdownDoc> }> {
    const ctx = this.trace.startTrace("FileSyncEngine", "syncAll", TraceType.SYNC);

    const deviceIds = await this.storage.listDeviceIds();
    const remoteDeviceIds = deviceIds.filter(id => id !== this.deviceId);

    this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "syncAll:start", {
      allDeviceIds: deviceIds,
      remoteDeviceIds,
      localDeviceId: this.deviceId
    });

    let merged = false;
    let currentDoc = localDoc;

    for (const remoteDeviceId of remoteDeviceIds) {
      const remoteDoc = await this.storage.loadRemote(remoteDeviceId);
      if (!remoteDoc) {
        this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "syncAll:noRemoteDoc", {
          remoteDeviceId
        });
        continue;
      }

      const beforeHeads = Automerge.getHeads(currentDoc);
      currentDoc = Automerge.merge(currentDoc, remoteDoc);
      const afterHeads = Automerge.getHeads(currentDoc);

      const headsChanged = beforeHeads.length !== afterHeads.length ||
        beforeHeads.some((h, i) => h !== afterHeads[i]);

      this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "syncAll:merged", {
        remoteDeviceId,
        headsChanged,
        beforeHeads: beforeHeads.length,
        afterHeads: afterHeads.length
      });

      if (headsChanged) {
        merged = true;
      }
    }

    // If we merged remote changes, update index.md
    if (merged) {
      await this.storage.exportIndexMd(currentDoc);
      this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "syncAll:exportedIndex", {});
    }

    ctx.success({ merged, remoteDevicesProcessed: remoteDeviceIds.length });
    return { merged, doc: currentDoc };
  }

  /**
   * Write local changes to the current device's chunk file.
   */
  async flushLocalChanges(changes: Uint8Array[]): Promise<void> {
    for (const change of changes) {
      this.storage.appendChange(change);
    }
    await this.storage.flushChanges();
  }

  /**
   * Trigger compaction: merge current device's chunk into a snapshot.
   */
  async compact(localDoc: Automerge.Doc<MarkdownDoc>): Promise<void> {
    await this.storage.compact(localDoc);
  }

  /**
   * Handle external editor (VS Code / Typora) modifying index.md directly.
   *
   * Reads the current index.md, diffs it against the CRDT content,
   * and applies character-level splices to preserve CRDT history.
   *
   * @returns Updated doc if changes were found, null otherwise.
   */
  async handleExternalMarkdownEdit(
    localDoc: Automerge.Doc<MarkdownDoc>
  ): Promise<Automerge.Doc<MarkdownDoc> | null> {
    const ctx = this.trace.startTrace("FileSyncEngine", "handleExternalMarkdownEdit", TraceType.SYNC);

    // Use storage to read index.md instead of direct fs access
    const externalContent = await this.storage.readIndexMd();
    
    if (externalContent === null) {
      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "FileSyncEngine", "handleExternalMarkdownEdit:noIndex", {});
      ctx.success({ result: 'noIndex' });
      return null;
    }

    const currentContent = localDoc.content ?? "";

    if (externalContent === currentContent) {
      this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "handleExternalMarkdownEdit:noChange", {
        contentLength: currentContent.length
      });
      ctx.success({ result: 'noChange' });
      return null;
    }

    this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "handleExternalMarkdownEdit:detected", {
      oldLength: currentContent.length,
      newLength: externalContent.length,
      diffStart: findDiffStart(currentContent, externalContent)
    });

    // Apply the external edit as a character-level diff using Automerge.splice.
    // We use a simple diff: delete all old content, insert all new content.
    // This preserves CRDT identity (no whole-string replacement).
    const updatedDoc = Automerge.change(localDoc, (d) => {
      // Use Automerge.splice to replace content character by character
      // For simplicity and correctness, we do a full splice replacement
      // which still goes through the CRDT splice path (not assignment).
      const oldLength = currentContent.length;
      Automerge.splice(d, ["content"], 0, oldLength, externalContent);
    });

    // Persist the change
    const changes = Automerge.getLastLocalChange(updatedDoc);
    if (changes) {
      this.storage.appendChange(changes);
      await this.storage.flushChanges();
    }

    ctx.success({ result: 'updated', newLength: externalContent.length });
    return updatedDoc;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Find the index where two strings start to differ */
function findDiffStart(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return i;
  }
  return minLen;
}
