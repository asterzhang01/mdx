export interface StoragePaths {
  basePath: string;
  metaDir: string;
  assetsDir: string;
  indexPath: string;
  indexTmpPath: string;
}

export function createStoragePaths(basePath: string): StoragePaths {
  return {
    basePath,
    metaDir: `${basePath}/.mdx`,
    assetsDir: `${basePath}/assets`,
    indexPath: `${basePath}/index.md`,
    indexTmpPath: `${basePath}/index.md.tmp`,
  };
}
