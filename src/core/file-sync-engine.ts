/**
 * FileSyncEngine
 *
 * The unified facade for .mdx document operations.
 * This is the main entry point for application code to work with .mdx documents.
 *
 * Responsibilities:
 *   - Document lifecycle orchestration (via MdxDocumentStorage)
 *   - Content changes via CRDT splice
 *   - Multi-device sync
 *   - External editor integration
 *
 * Note: FileSyncEngine does NOT directly hold FileSystemAdapter.
 * All file system access is delegated to MdxDocumentStorage.
 */
import { next as Automerge } from "@automerge/automerge";
import type { DocumentType, DocumentTypeInfo, MarkdownDoc } from "../document/schema.js";
import { MdxDocumentStorage } from "../storage/mdx-document-storage.js";
import { MdDocumentStorage } from "../storage/md-document-storage.js";
import type { FileSystemAdapter } from "../fs/fs-adapter.js";
import { getGlobalTraceManager, TraceLevel, TraceType } from "../utils/trace.js";
import { createDocument, getAllChanges, extractChanges, applyContentChange } from "../document/document-operations.js";
import { detectDocumentType, convertLegacyToModern } from "../document/document-utils.js";
import { findReferencedAssets, findOrphanedAssets } from "../utils/asset-utils.js";

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
  private readonly fs: FileSystemAdapter;
  private readonly exportIndexMarkdown: boolean;
  private storage: MdxDocumentStorage | null = null;
  private legacyStorage: MdDocumentStorage | null = null;
  private document: Automerge.Doc<MarkdownDoc> | null = null;
  private documentType: DocumentType | null = null;

  /** Trace manager for logging */
  private readonly trace = getGlobalTraceManager();

  constructor(
    basePath: string,
    fs: FileSystemAdapter,
    deviceId: string,
    options: { exportIndexMarkdown?: boolean } = {},
  ) {
    this.basePath = basePath;
    this.deviceId = deviceId;
    this.fs = fs;
    this.exportIndexMarkdown = options.exportIndexMarkdown ?? true;

    this.trace.log(TraceLevel.DEBUG, TraceType.LIFECYCLE, "FileSyncEngine", "constructor", {
      basePath,
      deviceId,
      exportIndexMarkdown: this.exportIndexMarkdown,
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

    const detectedType = await detectDocumentType(this.basePath, this.fs);
    this.documentType = detectedType ?? 'modern';

    if (this.documentType === 'legacy') {
      this.legacyStorage = new MdDocumentStorage(this.basePath, this.fs);
      await this.legacyStorage.ensureAssetsDir();
      await this.legacyStorage.saveContent(initialContent);
      this.document = createDocument(initialContent);
      ctx.success({ deviceId: this.deviceId, contentLength: initialContent.length, documentType: this.documentType });
      return;
    }

    const storage = this.getOrCreateModernStorage();
    await storage.ensureDirectories();

    this.document = createDocument(initialContent);

    const changes = getAllChanges(this.document);
    for (const change of changes) {
      storage.appendChange(change);
    }
    await storage.flushChanges();

    // Export index.md for compatibility
    if (this.document && this.exportIndexMarkdown) {
      await storage.exportIndexMd(this.document);
    }

    ctx.success({ deviceId: this.deviceId, contentLength: initialContent.length, documentType: this.documentType });
  }

  /**
   * Load an existing document from disk.
   */
  async load(): Promise<LoadResult> {
    const ctx = this.trace.startTrace("FileSyncEngine", "load", TraceType.SYNC);

    const detectedType = await detectDocumentType(this.basePath, this.fs);
    if (!detectedType) {
      throw new Error(`Invalid MarkdownX document: ${this.basePath}`);
    }

    this.documentType = detectedType;

    if (this.documentType === 'legacy') {
      this.legacyStorage = new MdDocumentStorage(this.basePath, this.fs);
      const content = await this.legacyStorage.loadContent();
      this.document = createDocument(content);
      ctx.success({ deviceId: this.deviceId, loadedFromCRDT: false, merged: false, documentType: this.documentType });
      return { merged: false, doc: this.document };
    }

    const storage = this.getOrCreateModernStorage();
    await storage.ensureDirectories();

    // Try loading from CRDT storage
    let doc = await storage.loadLocal();
    const loadedFromCRDT = !!doc;

    if (!doc) {
      // Bootstrap from index.md if exists
      let initialContent = "# Untitled\n\n";
      
      // Use storage to read index.md
      const indexContent = await storage.readIndexMd();
      if (indexContent !== null) {
        initialContent = indexContent;
      }
      
      doc = createDocument(initialContent);
      
      // Persist initial state
      const changes = getAllChanges(doc);
      for (const change of changes) {
        storage.appendChange(change);
      }
      await storage.flushChanges();
    }

    // Sync with other devices
    const { doc: mergedDoc, merged } = await this.syncAll(doc);
    this.document = mergedDoc;

    ctx.success({ deviceId: this.deviceId, loadedFromCRDT, merged, documentType: this.documentType });
    return { merged, doc: mergedDoc };
  }

  /**
   * Apply content changes using CRDT splice.
   */
  async applyChange(newContent: string): Promise<ChangeResult> {
    if (!this.document) {
      throw new Error("Document not loaded. Call init() or load() first.");
    }

    if (this.documentType === 'legacy') {
      const changed = newContent !== this.getContent();
      if (changed) {
        this.document = createDocument(newContent);
      }
      return {
        changed,
        doc: this.document,
      };
    }

    const result = applyContentChange(this.document, newContent);

    if (result.changed) {
      this.document = result.doc;
      const changes = extractChanges(this.document);
      const storage = this.getOrCreateModernStorage();
      for (const change of changes) {
        storage.appendChange(change);
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

    if (this.documentType === 'legacy') {
      if (this.legacyStorage && this.document) {
        await this.legacyStorage.saveContent(this.getContent());
      }
      ctx.success({ documentType: this.documentType });
      return;
    }

    const storage = this.getOrCreateModernStorage();
    await storage.flushChanges();
    if (this.document && this.exportIndexMarkdown) {
      await storage.exportIndexMd(this.document);
    }

    ctx.success({ documentType: this.documentType });
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

  getDocumentType(): DocumentType | null {
    return this.documentType;
  }

  getDocumentTypeInfo(): DocumentTypeInfo | null {
    if (!this.documentType) return null;
    return {
      type: this.documentType,
      canConvertToModern: this.documentType === 'legacy',
      hasSyncCapability: this.documentType === 'modern',
    };
  }

  getAssetsDir(): string {
    if (this.documentType === 'legacy') {
      if (!this.legacyStorage) {
        this.legacyStorage = new MdDocumentStorage(this.basePath, this.fs);
      }
      return this.legacyStorage.getAssetsDir();
    }

    return `${this.basePath}/assets`;
  }

  async convertToModern(): Promise<void> {
    if (this.documentType !== 'legacy') {
      return;
    }

    await convertLegacyToModern(this.basePath, this.fs, this.deviceId);
    this.documentType = 'modern';
    this.legacyStorage = null;
    this.storage = null;
    await this.load();
  }

  async getOrphanedAssets(): Promise<string[]> {
    const assetsDir = this.getAssetsDir();
    const hasAssetsDir = await this.fs.exists(assetsDir);
    if (!hasAssetsDir) {
      return [];
    }

    const referenced = findReferencedAssets(this.getContent());
    const existingFiles = await this.fs.readdir(assetsDir);
    return findOrphanedAssets(referenced, existingFiles);
  }

  async cleanOrphanedAssets(): Promise<number> {
    const orphaned = await this.getOrphanedAssets();
    let deletedCount = 0;

    for (const filename of orphaned) {
      try {
        await this.fs.unlink(`${this.getAssetsDir()}/${filename}`);
        deletedCount++;
      } catch (error) {
        this.trace.log(TraceLevel.WARN, TraceType.FILE, "FileSyncEngine", "cleanOrphanedAssets:unlinkFailed", {
          filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return deletedCount;
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
    const storage = this.getOrCreateModernStorage();

    const deviceIds = await storage.listDeviceIds();
    const remoteDeviceIds = deviceIds.filter(id => id !== this.deviceId);

    this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "syncAll:start", {
      allDeviceIds: deviceIds,
      remoteDeviceIds,
      localDeviceId: this.deviceId
    });

    let merged = false;
    let currentDoc = localDoc;

    for (const remoteDeviceId of remoteDeviceIds) {
      const remoteDoc = await storage.loadRemote(remoteDeviceId);
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
    if (merged && this.exportIndexMarkdown) {
      await storage.exportIndexMd(currentDoc);
      this.trace.log(TraceLevel.DEBUG, TraceType.SYNC, "FileSyncEngine", "syncAll:exportedIndex", {});
    }

    ctx.success({ merged, remoteDevicesProcessed: remoteDeviceIds.length });
    return { merged, doc: currentDoc };
  }

  /**
   * Write local changes to the current device's chunk file.
   */
  async flushLocalChanges(changes: Uint8Array[]): Promise<void> {
    const storage = this.getOrCreateModernStorage();
    for (const change of changes) {
      storage.appendChange(change);
    }
    await storage.flushChanges();
  }

  /**
   * Trigger compaction: merge current device's chunk into a snapshot.
   */
  async compact(localDoc: Automerge.Doc<MarkdownDoc>): Promise<void> {
    const storage = this.getOrCreateModernStorage();
    await storage.compact(localDoc);
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

    if (this.documentType === 'legacy') {
      if (!this.legacyStorage) {
        this.legacyStorage = new MdDocumentStorage(this.basePath, this.fs);
      }
      const externalContent = await this.legacyStorage.loadContent();
      const currentContent = localDoc.content ?? "";
      if (externalContent === currentContent) {
        ctx.success({ result: 'noChange' });
        return null;
      }
      const updatedDoc = createDocument(externalContent);
      this.document = updatedDoc;
      ctx.success({ result: 'updated', newLength: externalContent.length });
      return updatedDoc;
    }

    const storage = this.getOrCreateModernStorage();

    // Use storage to read index.md instead of direct fs access
    const externalContent = await storage.readIndexMd();
    
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
      storage.appendChange(changes);
      await storage.flushChanges();
    }

    this.document = updatedDoc;
    ctx.success({ result: 'updated', newLength: externalContent.length });
    return updatedDoc;
  }

  private getOrCreateModernStorage(): MdxDocumentStorage {
    if (!this.storage) {
      this.storage = new MdxDocumentStorage(this.basePath, this.fs, this.deviceId);
    }
    return this.storage;
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
