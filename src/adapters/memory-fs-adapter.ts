/**
 * In-memory file system for fast, side-effect-free testing.
 *
 * Internally stores data in a flat Map keyed by full path.
 * Binary data is stored as Uint8Array; text data as string.
 * mkdir is a no-op (flat namespace).
 */
import type { FileSystemAdapter } from './fs-adapter.js';

export class MemoryFileSystemAdapter implements FileSystemAdapter {
  private files = new Map<string, Uint8Array | string>();

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (data === undefined) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    if (typeof data === "string") {
      return new TextEncoder().encode(data);
    }
    return data;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  async readTextFile(path: string): Promise<string> {
    const data = this.files.get(path);
    if (data === undefined) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    if (typeof data === "string") {
      return data;
    }
    return new TextDecoder().decode(data);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    // Check if path is a "directory" (any stored key starts with path/)
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async mkdir(_path: string): Promise<void> {
    // no-op in flat memory store
  }

  async readdir(dirPath: string): Promise<string[]> {
    const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const relative = key.slice(prefix.length);
        const firstSegment = relative.split("/")[0];
        if (firstSegment) {
          names.add(firstSegment);
        }
      }
    }
    return [...names];
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data === undefined) {
      throw new Error(`ENOENT: no such file: ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, data);
  }

  async stat(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    mtime: number;
  }> {
    const data = this.files.get(path);
    if (data === undefined) {
      // Check if it's a "directory"
      const prefix = path.endsWith("/") ? path : `${path}/`;
      for (const key of this.files.keys()) {
        if (key.startsWith(prefix)) {
          return {
            isFile: false,
            isDirectory: true,
            size: 0,
            mtime: Date.now(),
          };
        }
      }
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    const size = typeof data === "string" ? new TextEncoder().encode(data).length : data.length;
    return {
      isFile: true,
      isDirectory: false,
      size,
      mtime: Date.now(),
    };
  }

  watch(_path: string, _callback: (event: 'change' | 'rename', filename: string) => void): () => void {
    // In-memory watch not implemented for now
    return () => {};
  }

  /** Test helper: return a snapshot of all stored paths */
  listAllPaths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Test helper: clear all files */
  clear(): void {
    this.files.clear();
  }
}
