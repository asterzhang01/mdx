/**
 * FileSystemAdapter — platform-agnostic file-system interface.
 *
 * Different platforms supply different implementations:
 *   • MemoryFileSystemAdapter  — tests (memory-fs-adapter.ts)
 *   • ElectronFileSystemAdapter — Phase 2
 */

export interface FileSystemAdapter {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    mtime: number;
  }>;
  watch(path: string, callback: (event: 'change' | 'rename', filename: string) => void): () => void;
}
