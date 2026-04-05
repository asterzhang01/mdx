import type { AutomergeUrl } from "@automerge/automerge-repo";

export type MetadataPrimitive = string | number | boolean | null;

export interface MetadataMap {
  [key: string]: MetadataValue;
}

export interface MetadataList extends Array<MetadataValue> {}

export type MetadataValue = MetadataPrimitive | MetadataMap | MetadataList;

export type AIMetadata = {
  embeddingModel?: string;
  lastIndexedAt?: string;
  tags?: string[];
  summary?: string;
  vectorIndexPath?: string;
};

export type UserProfile = {
  deviceId: string;
  nickname: string;
  deviceName: string;
  customFields: MetadataMap;
};

export type DocumentMetadata = {
  createdAt: string;
  createdByDeviceId: string;
  createdByNickname: string;
  updatedAt: string;
  updatedByDeviceId: string;
  updatedByNickname: string;
  customFields: MetadataMap;
};

export type EditHistoryKind =
  | "document-created"
  | "content-saved"
  | "metadata-updated"
  | "external-change"
  | "custom-operation";

export type CustomOperationSource = {
  organization: string;
  typeSegment: string;
  canonicalType: string;
};

export type EditHistoryEntry = {
  id: string;
  timestamp: string;
  actorDeviceId: string;
  actorNickname: string;
  actorDeviceName: string;
  kind: EditHistoryKind;
  summary: string;
  customOperationSource?: CustomOperationSource;
};

export type Comment = {
  id: string;
  content: string;
  contactUrl?: AutomergeUrl;
  timestamp: number;
};

export type CommentThread = {
  id: string;
  comments: Comment[];
  resolved: boolean;
  fromCursor: string;
  toCursor: string;
};

export type MarkdownDoc = {
  content: string;
  commentThreads: Record<string, CommentThread>;
  assetsDocUrl: AutomergeUrl;
  aiMetadata?: AIMetadata;
  metadata?: DocumentMetadata;
  editHistory?: EditHistoryEntry[];
};

export type FileEntry = {
  contentType: string;
  contents: string | Uint8Array;
};

export type AssetsDoc = {
  files: Record<string, FileEntry>;
};

export type DocLink = {
  name: string;
  type: string;
  url: AutomergeUrl;
};

export type FolderDoc = {
  title: string;
  docs: DocLink[];
};

export type CommentThreadForUI = CommentThread & {
  from: number;
  to: number;
  active: boolean;
};

export type DocumentType = "legacy" | "modern";

export type DocumentTypeInfo = {
  type: DocumentType;
  canConvertToModern: boolean;
  hasSyncCapability: boolean;
};

export type VaultSettings = {
  showLineNumbers: boolean;
};

export type VaultConfigDoc = {
  settings: VaultSettings;
};
