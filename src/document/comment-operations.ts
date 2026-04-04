import { next as Automerge } from '@automerge/automerge';
import type { CommentThreadForUI, MarkdownDoc } from './schema.js';
import type {
  AddCommentThreadOperation,
  ReplyToCommentOperation,
  ResolveCommentOperation,
} from './operations.js';

export function addCommentThread(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: AddCommentThreadOperation,
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (d) => {
    const fromCursor = Automerge.getCursor(d, ['content'], operation.from);
    const toCursor = Automerge.getCursor(d, ['content'], operation.to);

    const comment: Record<string, unknown> = {
      id: `${operation.threadId}-0`,
      content: operation.initialComment,
      timestamp: Date.now(),
    };
    if (operation.contactUrl !== undefined) {
      comment.contactUrl = operation.contactUrl;
    }

    d.commentThreads[operation.threadId] = {
      id: operation.threadId,
      comments: [comment as never],
      resolved: false,
      fromCursor,
      toCursor,
    };
  });
}

export function replyToCommentThread(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: ReplyToCommentOperation,
): Automerge.Doc<MarkdownDoc> {
  if (!doc.commentThreads[operation.threadId]) {
    return doc;
  }

  return Automerge.change(doc, (d) => {
    const thread = d.commentThreads[operation.threadId];
    if (!thread) return;

    const reply: Record<string, unknown> = {
      id: operation.commentId,
      content: operation.content,
      timestamp: Date.now(),
    };
    if (operation.contactUrl !== undefined) {
      reply.contactUrl = operation.contactUrl;
    }
    thread.comments.push(reply as never);
  });
}

export function resolveCommentThread(
  doc: Automerge.Doc<MarkdownDoc>,
  operation: ResolveCommentOperation,
): Automerge.Doc<MarkdownDoc> {
  if (!doc.commentThreads[operation.threadId]) {
    return doc;
  }

  return Automerge.change(doc, (d) => {
    const thread = d.commentThreads[operation.threadId];
    if (!thread) return;
    thread.resolved = true;
  });
}

export function resolveCommentThreadPositions(
  doc: Automerge.Doc<MarkdownDoc>,
  activeThreadId: string | null,
): CommentThreadForUI[] {
  const threads = doc.commentThreads ?? {};

  return Object.values(threads)
    .filter((thread) => !thread.resolved)
    .flatMap((thread) => {
      let from = 0;
      let to = 0;
      try {
        from = Automerge.getCursorPosition(doc, ['content'], thread.fromCursor);
        to = Automerge.getCursorPosition(doc, ['content'], thread.toCursor);
      } catch (error) {
        if (error instanceof RangeError) {
          return [];
        }
        throw error;
      }

      if (to <= from) return [];

      return [{
        ...thread,
        from,
        to,
        active: thread.id === activeThreadId,
      }];
    });
}
