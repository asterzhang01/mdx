/**
 * Image processing utilities for .mdx format
 *
 * Handles content-addressed storage of image assets:
 *   - Computes SHA-256 hash of image data
 *   - Writes to assets/ directory with hash-based filename
 *   - Returns relative path for Markdown embedding
 */
import { type FileSystemAdapter } from "../fs/fs-adapter.js";

/** Result of processing an image for storage */
export interface AssetInfo {
  /** Hash-based filename, e.g. "a3f5c8d2e1b4f7a9.png" */
  filename: string;
  /** Relative path for Markdown embedding, e.g. "assets/a3f5c8d2e1b4f7a9.png" */
  relativePath: string;
  /** Full absolute path where the file was written */
  absolutePath: string;
  /** MIME content type */
  contentType: string;
}

/**
 * Compute SHA-256 hex digest of binary data.
 * Uses the Web Crypto API (available in Node 18+ and all modern browsers).
 */
async function computeSha256Hex(data: Uint8Array): Promise<string> {
  // Use crypto.subtle with proper type casting for Node.js compatibility
  const hashBuffer = await globalThis.crypto.subtle.digest(
    "SHA-256",
    data as unknown as ArrayBuffer
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract file extension from a filename.
 * Returns lowercase extension without the dot, or "bin" if none found.
 */
function extractExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return "bin";
  return fileName.slice(dotIndex + 1).toLowerCase();
}

/**
 * Infer MIME content type from file extension.
 */
function inferContentType(extension: string): string {
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    bin: "application/octet-stream",
  };
  return mimeMap[extension] ?? "application/octet-stream";
}

/**
 * Process an image file for storage in the assets directory.
 *
 * - Computes SHA-256 hash of the data
 * - Writes to `{assetsDir}/{hash}.{ext}` (content-addressed, idempotent)
 * - Skips writing if the file already exists (deduplication)
 *
 * @param data       Raw image bytes
 * @param fileName   Original filename (used to extract extension)
 * @param assetsDir  Absolute path to the assets/ directory
 * @param fsAdapter  File system adapter
 * @returns Asset info with relative path for Markdown embedding
 */
export async function processImage(
  data: Uint8Array,
  fileName: string,
  assetsDir: string,
  fsAdapter: FileSystemAdapter
): Promise<AssetInfo> {
  const extension = extractExtension(fileName);
  const hash = await computeSha256Hex(data);
  const hashedFilename = `${hash}.${extension}`;
  const absolutePath = `${assetsDir}/${hashedFilename}`;
  const relativePath = `assets/${hashedFilename}`;
  const contentType = inferContentType(extension);

  await fsAdapter.mkdir(assetsDir);

  const alreadyExists = await fsAdapter.exists(absolutePath);
  if (!alreadyExists) {
    await fsAdapter.writeFile(absolutePath, data);
  }

  return {
    filename: hashedFilename,
    relativePath,
    absolutePath,
    contentType,
  };
}
