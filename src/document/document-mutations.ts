export {
  splice,
  extractTitle,
  createDocument,
  getAllChanges,
  extractChanges,
  applyContentChange,
  initDocument,
} from "./text-operations.js";
export {
  appendEditHistory,
  createDocumentMetadata,
  createEditHistoryEntry,
  ensureDocumentCapabilities,
  touchDocumentMetadata,
  updateDocumentMetadata,
} from "./metadata-operations.js";
export { uploadAsset, deleteAsset, initAssetsDoc } from "./asset-operations.js";
export {
  addCommentThread,
  replyToCommentThread,
  resolveCommentThread,
  resolveCommentThreadPositions,
} from "./comment-operations.js";
export {
  folderRename,
  folderAddDoc,
  folderRemoveDoc,
  initFolderDoc,
} from "./folder-operations.js";
