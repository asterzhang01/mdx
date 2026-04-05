import { next as Automerge } from '@automerge/automerge';
import type { FolderDoc } from './schema.js';
import type {
  FolderAddDocOperation,
  FolderRemoveDocOperation,
  FolderRenameOperation,
} from './operation-types.js';

export function folderRename(
  doc: Automerge.Doc<FolderDoc>,
  operation: FolderRenameOperation,
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    d.title = operation.title;
  });
}

export function folderAddDoc(
  doc: Automerge.Doc<FolderDoc>,
  operation: FolderAddDocOperation,
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    d.docs.push({
      name: operation.name,
      type: operation.docType,
      url: operation.url,
    });
  });
}

export function folderRemoveDoc(
  doc: Automerge.Doc<FolderDoc>,
  operation: FolderRemoveDocOperation,
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    const index = d.docs.findIndex((link) => link.url === operation.url);
    if (index !== -1) {
      d.docs.splice(index, 1);
    }
  });
}

export function initFolderDoc(
  doc: Automerge.Doc<FolderDoc>,
  title = 'Untitled Folder',
): Automerge.Doc<FolderDoc> {
  return Automerge.change(doc, (d) => {
    d.title = title;
    d.docs = [];
  });
}
