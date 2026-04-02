/**
 * MdStorageAdapter
 *
 * Lightweight adapter for non-sync documents (no CRDT / no sync capability).
 * Provides direct read/write access to index.md without CRDT complexity.
 */
import type { FileSystemAdapter } from "./fs-adapter.js";
import { getGlobalTraceManager, TraceLevel, TraceType } from "../utils/trace.js";

/**
 * Storage adapter for legacy documents.
 *
 * Legacy documents have:
 * - index.md (direct read/write)
 * - assets/ directory
 * - No .mdx/ directory (no sync capability)
 */
export class MdStorageAdapter {
  private readonly basePath: string;
  private readonly fs: FileSystemAdapter;
  private readonly trace = getGlobalTraceManager();

  constructor(basePath: string, fsAdapter: FileSystemAdapter) {
    this.basePath = basePath;
    this.fs = fsAdapter;

    this.trace.log(TraceLevel.DEBUG, TraceType.LIFECYCLE, "MdStorageAdapter", "constructor", {
      basePath
    });
  }

  /**
   * Load content from index.md.
   * @returns The content of index.md
   * @throws Error if index.md does not exist
   */
  async loadContent(): Promise<string> {
    const indexPath = `${this.basePath}/index.md`;

    try {
      const content = await this.fs.readTextFile(indexPath);

      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdStorageAdapter", "loadContent", {
        path: indexPath,
        contentLength: content.length
      });

      return content;
    } catch (error) {
      this.trace.log(TraceLevel.ERROR, TraceType.FILE, "MdStorageAdapter", "loadContent:error", {
        path: indexPath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Save content to index.md.
   * Creates index.md if it doesn't exist.
   */
  async saveContent(content: string): Promise<void> {
    const indexPath = `${this.basePath}/index.md`;
    const tmpPath = `${indexPath}.tmp`;

    try {
      // Ensure directory exists
      await this.fs.mkdir(this.basePath);

      // Atomic write: tmp → rename
      await this.fs.writeTextFile(tmpPath, content);
      await this.fs.rename(tmpPath, indexPath);

      this.trace.log(TraceLevel.DEBUG, TraceType.FILE, "MdStorageAdapter", "saveContent", {
        path: indexPath,
        contentLength: content.length
      });
    } catch (error) {
      this.trace.log(TraceLevel.ERROR, TraceType.FILE, "MdStorageAdapter", "saveContent:error", {
        path: indexPath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get the assets directory path.
   */
  getAssetsDir(): string {
    return `${this.basePath}/assets`;
  }

  /**
   * Ensure the assets directory exists.
   */
  async ensureAssetsDir(): Promise<void> {
    await this.fs.mkdir(this.getAssetsDir());
  }
}

export { MdStorageAdapter as LegacyStorageAdapter };
