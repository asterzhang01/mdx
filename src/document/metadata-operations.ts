import { next as Automerge } from "@automerge/automerge";
import type {
  DocumentMetadata,
  EditHistoryEntry,
  EditHistoryKind,
  MetadataMap,
  MetadataValue,
  MarkdownDoc,
  UserProfile,
} from "./schema.js";

function createHistoryId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function cloneMetadataValue<T extends MetadataValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneMetadataValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const next: MetadataMap = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = cloneMetadataValue(item);
    }
    return next as T;
  }
  return value;
}

function cloneMetadataMap(value: MetadataMap): MetadataMap {
  return cloneMetadataValue(value);
}

function applyCustomFields(target: MetadataMap, source: MetadataMap): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    target[key] = cloneMetadataValue(value);
  }
}

function applyMetadata(target: NonNullable<MarkdownDoc["metadata"]>, source: DocumentMetadata): void {
  target.createdAt = source.createdAt;
  target.createdByDeviceId = source.createdByDeviceId;
  target.createdByNickname = source.createdByNickname;
  target.updatedAt = source.updatedAt;
  target.updatedByDeviceId = source.updatedByDeviceId;
  target.updatedByNickname = source.updatedByNickname;
  if (!target.customFields) {
    target.customFields = {};
  }
  applyCustomFields(target.customFields, cloneMetadataMap(source.customFields ?? {}));
}

export function createDocumentMetadata(
  user: UserProfile,
  now: string = new Date().toISOString(),
): DocumentMetadata {
  return {
    createdAt: now,
    createdByDeviceId: user.deviceId,
    createdByNickname: user.nickname,
    updatedAt: now,
    updatedByDeviceId: user.deviceId,
    updatedByNickname: user.nickname,
    customFields: {},
  };
}

export function touchDocumentMetadata(
  metadata: DocumentMetadata,
  user: UserProfile,
  now: string = new Date().toISOString(),
): DocumentMetadata {
  return {
    ...metadata,
    updatedAt: now,
    updatedByDeviceId: user.deviceId,
    updatedByNickname: user.nickname,
    customFields: metadata.customFields ?? {},
  };
}

export function createEditHistoryEntry(
  user: UserProfile,
  kind: EditHistoryKind,
  summary: string,
  now: string = new Date().toISOString(),
): EditHistoryEntry {
  return {
    id: createHistoryId(),
    timestamp: now,
    actorDeviceId: user.deviceId,
    actorNickname: user.nickname,
    actorDeviceName: user.deviceName,
    kind,
    summary,
  };
}

export function ensureDocumentCapabilities(
  doc: Automerge.Doc<MarkdownDoc>,
  user: UserProfile,
  options: {
    now?: string;
    includeCreationHistory?: boolean;
  } = {},
): { doc: Automerge.Doc<MarkdownDoc>; changed: boolean } {
  const now = options.now ?? new Date().toISOString();
  const includeCreationHistory = options.includeCreationHistory ?? false;
  const hasMetadata = !!doc.metadata;
  const hasHistory = Array.isArray(doc.editHistory);
  const needsCreationHistory = includeCreationHistory && (doc.editHistory?.length ?? 0) === 0;

  if (hasMetadata && hasHistory && !needsCreationHistory) {
    return { doc, changed: false };
  }

  const updated = Automerge.change(doc, (draft) => {
    if (!draft.metadata) {
      draft.metadata = createDocumentMetadata(user, now);
    }
    if (!draft.editHistory) {
      draft.editHistory = [];
    }
    if (includeCreationHistory && draft.editHistory.length === 0) {
      draft.editHistory.push(
        createEditHistoryEntry(user, "document-created", "Document created", now),
      );
    }
  });

  return { doc: updated, changed: true };
}

export function appendEditHistory(
  doc: Automerge.Doc<MarkdownDoc>,
  user: UserProfile,
  kind: EditHistoryKind,
  summary: string,
  now: string = new Date().toISOString(),
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (draft) => {
    if (!draft.editHistory) {
      draft.editHistory = [];
    }
    draft.editHistory.push(createEditHistoryEntry(user, kind, summary, now));
  });
}

export function updateDocumentMetadata(
  doc: Automerge.Doc<MarkdownDoc>,
  metadata: DocumentMetadata,
): Automerge.Doc<MarkdownDoc> {
  return Automerge.change(doc, (draft) => {
    if (!draft.metadata) {
      draft.metadata = createDocumentMetadata({
        deviceId: metadata.updatedByDeviceId,
        nickname: metadata.updatedByNickname,
        deviceName: "",
        customFields: {},
      }, metadata.createdAt);
    }
    applyMetadata(draft.metadata, {
      ...metadata,
      customFields: cloneMetadataMap(metadata.customFields ?? {}),
    });
  });
}
