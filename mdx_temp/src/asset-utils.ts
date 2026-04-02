/**
 * Asset Utility Functions
 *
 * Utilities for analyzing and managing document assets:
 *   - findReferencedAssets: Extract asset filenames referenced in markdown content
 *   - findOrphanedAssets: Identify assets not referenced in the document
 */

/**
 * Extract all asset filenames referenced in markdown content.
 *
 * Matches markdown image syntax with assets/ prefix:
 *   - ![alt](assets/filename.png)
 *   - ![](assets/hash123.jpg)
 *
 * Ignores:
 *   - External URLs (http://, https://)
 *   - Data URIs (data:)
 *   - Relative paths outside assets directory
 *
 * @param content - Markdown content to parse
 * @returns Set of asset filenames referenced in the content
 */
export function findReferencedAssets(content: string): Set<string> {
  const referenced = new Set<string>();

  // Match markdown image syntax: ![alt](path)
  // This regex captures the path part after assets/
  const imageRegex = /!\[.*?\]\((assets\/([^)]+))\)/g;

  let match: RegExpExecArray | null;
  while ((match = imageRegex.exec(content)) !== null) {
    const path = match[1]; // Full path like "assets/abc123.png"
    const filename = match[2]; // Just the filename like "abc123.png"

    // Skip external URLs, data URIs, and paths outside assets
    if (path.startsWith('http://') || path.startsWith('https://')) {
      continue;
    }
    if (path.startsWith('data:')) {
      continue;
    }
    if (!path.startsWith('assets/')) {
      continue;
    }

    referenced.add(filename);
  }

  return referenced;
}

/**
 * Identify assets that exist but are not referenced in the document.
 *
 * @param referenced - Set of asset filenames that are referenced
 * @param existing - Array of all existing asset filenames
 * @returns Array of orphaned asset filenames
 */
export function findOrphanedAssets(
  referenced: Set<string>,
  existing: string[]
): string[] {
  return existing.filter((filename) => !referenced.has(filename));
}
