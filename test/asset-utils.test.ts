/**
 * Tests for asset utility functions
 *
 * TDD Test Cases:
 *   UT-001: findReferencedAssets extracts asset filenames from markdown content
 *   UT-002: findReferencedAssets handles multiple image references
 *   UT-003: findReferencedAssets ignores external URLs
 *   UT-004: findOrphanedAssets identifies files not in referenced set
 *   UT-005: findOrphanedAssets returns empty array when all assets referenced
 */
import { describe, it, expect } from 'vitest';
import { findReferencedAssets, findOrphanedAssets } from "../src/utils/asset-utils.js";

// ---------------------------------------------------------------------------
// UT-001: findReferencedAssets extracts asset filenames from markdown content
// ---------------------------------------------------------------------------
describe('UT-001: findReferencedAssets extracts asset filenames', () => {
  it('should extract single asset filename from markdown image syntax', () => {
    const content = '# My Note\n\n![image](assets/a1b2c3d4e5f6g7h8.png)\n\nSome text.';
    const result = findReferencedAssets(content);

    expect(result.has('a1b2c3d4e5f6g7h8.png')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('should extract asset filename with different extensions', () => {
    const content = '![photo](assets/abc123.jpg)';
    const result = findReferencedAssets(content);

    expect(result.has('abc123.jpg')).toBe(true);
  });

  it('should extract asset from standard markdown image syntax', () => {
    const content = '![](assets/hash123.webp)';
    const result = findReferencedAssets(content);

    expect(result.has('hash123.webp')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UT-002: findReferencedAssets handles multiple image references
// ---------------------------------------------------------------------------
describe('UT-002: findReferencedAssets handles multiple references', () => {
  it('should extract multiple unique asset filenames', () => {
    const content = `
# Gallery

![First](assets/aaa111.png)
Some text here.
![Second](assets/bbb222.jpg)
More text.
![Third](assets/ccc333.webp)
`;
    const result = findReferencedAssets(content);

    expect(result.size).toBe(3);
    expect(result.has('aaa111.png')).toBe(true);
    expect(result.has('bbb222.jpg')).toBe(true);
    expect(result.has('ccc333.webp')).toBe(true);
  });

  it('should deduplicate repeated references to same asset', () => {
    const content = `
![Logo](assets/logo.png)
Some content.
![Logo again](assets/logo.png)
More content.
`;
    const result = findReferencedAssets(content);

    expect(result.size).toBe(1);
    expect(result.has('logo.png')).toBe(true);
  });

  it('should handle assets mixed with regular text', () => {
    const content = 'Text before ![img](assets/img1.png) text between ![img2](assets/img2.gif) text after';
    const result = findReferencedAssets(content);

    expect(result.size).toBe(2);
    expect(result.has('img1.png')).toBe(true);
    expect(result.has('img2.gif')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UT-003: findReferencedAssets ignores external URLs
// ---------------------------------------------------------------------------
describe('UT-003: findReferencedAssets ignores external URLs', () => {
  it('should not include external http URLs', () => {
    const content = '![External](https://example.com/image.png)';
    const result = findReferencedAssets(content);

    expect(result.size).toBe(0);
  });

  it('should not include external https URLs', () => {
    const content = '![External](https://cdn.example.com/photos/pic.jpg)';
    const result = findReferencedAssets(content);

    expect(result.size).toBe(0);
  });

  it('should distinguish between assets and external URLs', () => {
    const content = `
![Local](assets/local.png)
![External](https://example.com/remote.jpg)
![Also Local](assets/another.gif)
`;
    const result = findReferencedAssets(content);

    expect(result.size).toBe(2);
    expect(result.has('local.png')).toBe(true);
    expect(result.has('another.gif')).toBe(true);
  });

  it('should ignore data URIs', () => {
    const content = '![Data](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)';
    const result = findReferencedAssets(content);

    expect(result.size).toBe(0);
  });

  it('should ignore relative paths outside assets directory', () => {
    const content = '![Other](../images/outside.png)';
    const result = findReferencedAssets(content);

    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UT-004: findOrphanedAssets identifies files not in referenced set
// ---------------------------------------------------------------------------
describe('UT-004: findOrphanedAssets identifies orphaned files', () => {
  it('should identify files not in referenced set', () => {
    const referenced = new Set(['used1.png', 'used2.jpg']);
    const existing = ['used1.png', 'used2.jpg', 'orphan1.png', 'orphan2.gif'];

    const result = findOrphanedAssets(referenced, existing);

    expect(result).toHaveLength(2);
    expect(result).toContain('orphan1.png');
    expect(result).toContain('orphan2.gif');
  });

  it('should return all files when referenced set is empty', () => {
    const referenced = new Set<string>();
    const existing = ['file1.png', 'file2.jpg', 'file3.webp'];

    const result = findOrphanedAssets(referenced, existing);

    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining(existing));
  });

  it('should handle case where some files are referenced', () => {
    const referenced = new Set(['kept.png']);
    const existing = ['kept.png', 'orphan.png', 'another_orphan.jpg'];

    const result = findOrphanedAssets(referenced, existing);

    expect(result).toHaveLength(2);
    expect(result).not.toContain('kept.png');
  });
});

// ---------------------------------------------------------------------------
// UT-005: findOrphanedAssets returns empty array when all assets referenced
// ---------------------------------------------------------------------------
describe('UT-005: findOrphanedAssets returns empty when all referenced', () => {
  it('should return empty array when all files are referenced', () => {
    const referenced = new Set(['file1.png', 'file2.jpg', 'file3.webp']);
    const existing = ['file1.png', 'file2.jpg', 'file3.webp'];

    const result = findOrphanedAssets(referenced, existing);

    expect(result).toHaveLength(0);
    expect(result).toEqual([]);
  });

  it('should return empty array when both sets are empty', () => {
    const referenced = new Set<string>();
    const existing: string[] = [];

    const result = findOrphanedAssets(referenced, existing);

    expect(result).toHaveLength(0);
  });

  it('should handle extra referenced items gracefully', () => {
    // Referenced set has items not in existing - that's fine, they're just not orphaned
    const referenced = new Set(['file1.png', 'file2.jpg', 'nonexistent.gif']);
    const existing = ['file1.png', 'file2.jpg'];

    const result = findOrphanedAssets(referenced, existing);

    expect(result).toHaveLength(0);
  });
});
