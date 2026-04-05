import { next as Automerge } from '@automerge/automerge';
import type { AssetsDoc, MarkdownDoc } from './schema.js';
import type { AssetDeleteOperation, AssetUploadOperation } from './operation-types.js';

export function uploadAsset(
  assetsDoc: Automerge.Doc<AssetsDoc>,
  markdownDoc: Automerge.Doc<MarkdownDoc> | null,
  operation: AssetUploadOperation,
): { assetsDoc: Automerge.Doc<AssetsDoc>; markdownDoc: Automerge.Doc<MarkdownDoc> | null } {
  const newAssetsDoc = Automerge.change(assetsDoc, (d) => {
    d.files[operation.filename] = {
      contentType: operation.contentType,
      contents: operation.data,
    };
  });

  let newMarkdownDoc = markdownDoc;
  if (markdownDoc && operation.insertAtIndex !== undefined) {
    const imageRef = `![](assets/${operation.filename})`;
    newMarkdownDoc = Automerge.change(markdownDoc, (d) => {
      Automerge.splice(d, ['content'], operation.insertAtIndex!, 0, imageRef);
    });
  }

  return { assetsDoc: newAssetsDoc, markdownDoc: newMarkdownDoc };
}

export function deleteAsset(
  assetsDoc: Automerge.Doc<AssetsDoc>,
  operation: AssetDeleteOperation,
): Automerge.Doc<AssetsDoc> {
  return Automerge.change(assetsDoc, (d) => {
    delete d.files[operation.filename];
  });
}

export function initAssetsDoc(doc: Automerge.Doc<AssetsDoc>): Automerge.Doc<AssetsDoc> {
  return Automerge.change(doc, (d) => {
    d.files = {};
  });
}
