import { next as Automerge } from '@automerge/automerge';
import type { MarkdownDoc } from './schema.js';
import type { TextSpliceOperation } from './operation-types.js';

export function splice(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: TextSpliceOperation,
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (d) => {
    Automerge.splice(d, ['content'], operation.index, operation.deleteCount, operation.insert);
  });
}

export function extractTitle(content: string): string {
  const frontmatterMatch = content.match(/---\n([\s\S]+?)\n---/);
  if (frontmatterMatch) {
    const titleMatch = frontmatterMatch[1].match(/title:\s"(.+?)"/);
    if (titleMatch) {
      return titleMatch[1];
    }
  }

  const headingMatch = content.match(/(^|\n)#\s(.+)/);
  if (headingMatch) {
    return headingMatch[2];
  }

  return 'Untitled';
}

export function createDocument(initialContent: string = '# Untitled\n\n'): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(Automerge.init<MarkdownDoc>(), (d) => {
    d.content = initialContent;
    d.commentThreads = {};
    d.assetsDocUrl = '' as never;
    d.editHistory = [];
  });
}

export function getAllChanges(doc: Automerge.Doc<MarkdownDoc>): Uint8Array[] {
  return Automerge.getAllChanges(doc);
}

export function extractChanges(doc: Automerge.Doc<MarkdownDoc>): Uint8Array[] {
  const lastChange = Automerge.getLastLocalChange(doc);
  return lastChange ? [lastChange] : [];
}

export function applyContentChange(
  doc: Automerge.Doc<MarkdownDoc>,
  newContent: string,
): { doc: Automerge.Doc<MarkdownDoc>; changed: boolean } {
  const currentContent = doc.content ?? '';

  if (newContent === currentContent) {
    return { doc, changed: false };
  }

  const updatedDoc = Automerge.change(doc, (d) => {
    Automerge.splice(d, ['content'], 0, currentContent.length, newContent);
  });

  return { doc: updatedDoc, changed: true };
}

export function initDocument(
  doc: Automerge.Doc<MarkdownDoc>,
  assetsDocUrl: string,
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (d) => {
    d.content = '# Untitled\n\n';
    d.commentThreads = {};
    d.assetsDocUrl = assetsDocUrl as never;
    d.editHistory = [];
  });
}
