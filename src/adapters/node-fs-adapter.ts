/**
 * NodeFileSystemAdapter
 *
 * Implements FileSystemAdapter using Node.js `fs/promises`.
 * Used in Electron main process and Node.js CLI tools.
 *
 * Phase 2 deliverable — bridges @markdownx/core to real file system.
 */
import { promises as fs, watch } from "node:fs";
import type { FileSystemAdapter } from "./fs-adapter.js";

export class NodeFileSystemAdapter implements FileSystemAdapter {
  async readFile(path: string): Promise<Uint8Array> {
    const buffer = await fs.readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await fs.writeFile(path, data);
  }

  async readTextFile(path: string): Promise<string> {
    return fs.readFile(path, "utf-8");
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(path);
  }

  async unlink(path: string): Promise<void> {
    await fs.unlink(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async stat(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    mtime: number;
  }> {
    const stats = await fs.stat(path);
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mtime: stats.mtimeMs,
    };
  }

  watch(path: string, callback: (event: 'change' | 'rename', filename: string) => void): () => void {
    const watcher = watch(path, (event: string, filename: string | null) => {
      if (filename) {
        callback(event === 'rename' ? 'rename' : 'change', filename);
      }
    });
    return () => watcher.close();
  }
}

/**
 * Factory function for creating a Node.js file system adapter.
 * Preferred entry point — matches the import used in Electron main process.
 */
export function createNodeFsAdapter(): NodeFileSystemAdapter {
  return new NodeFileSystemAdapter();
}
