/**
 * DocumentOperations
 *
 * Public facade for typed document mutations. The implementation is split by
 * capability so the CRDT logic stays easier to navigate and evolve.
 */
export {
  splice,
  extractTitle,
  createDocument,
  getAllChanges,
  extractChanges,
  applyContentChange,
  initDocument,
} from './text-operations.js';
export { uploadAsset, deleteAsset, initAssetsDoc } from './asset-operations.js';
export {
  addCommentThread,
  replyToCommentThread,
  resolveCommentThread,
  resolveCommentThreadPositions,
} from './comment-operations.js';
export {
  folderRename,
  folderAddDoc,
  folderRemoveDoc,
  initFolderDoc,
} from './folder-operations.js';
