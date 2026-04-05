import type { AutomergeUrl } from "@automerge/automerge-repo";

export type TextSpliceOperation = {
  type: "textSplice";
  index: number;
  deleteCount: number;
  insert: string;
};

export type AssetUploadOperation = {
  type: "assetUpload";
  filename: string;
  contentType: string;
  data: Uint8Array;
  insertAtIndex?: number;
};

export type AssetDeleteOperation = {
  type: "assetDelete";
  filename: string;
};

export type AddCommentThreadOperation = {
  type: "addCommentThread";
  threadId: string;
  from: number;
  to: number;
  initialComment: string;
  contactUrl?: AutomergeUrl;
};

export type ReplyToCommentOperation = {
  type: "replyToComment";
  threadId: string;
  commentId: string;
  content: string;
  contactUrl?: AutomergeUrl;
};

export type ResolveCommentOperation = {
  type: "resolveCommentThread";
  threadId: string;
};

export type FolderRenameOperation = {
  type: "folderRename";
  title: string;
};

export type FolderAddDocOperation = {
  type: "folderAddDoc";
  name: string;
  docType: string;
  url: AutomergeUrl;
};

export type FolderRemoveDocOperation = {
  type: "folderRemoveDoc";
  url: AutomergeUrl;
};

export type BuiltInDocumentOperation =
  | TextSpliceOperation
  | AssetUploadOperation
  | AssetDeleteOperation
  | AddCommentThreadOperation
  | ReplyToCommentOperation
  | ResolveCommentOperation
  | FolderRenameOperation
  | FolderAddDocOperation
  | FolderRemoveDocOperation;

export type BuiltInDocumentOperationType = BuiltInDocumentOperation["type"];

export type CanonicalCustomOperationType = `${string}/${string}`;

export type CustomDocumentOperation<
  TCanonicalType extends string = CanonicalCustomOperationType,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = TPayload & {
  type: Exclude<TCanonicalType, BuiltInDocumentOperationType>;
};

export type DocumentOperation = BuiltInDocumentOperation | CustomDocumentOperation;

const ORGANIZATION_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CUSTOM_OPERATION_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

export type CustomOperationValidator<
  TOperation extends CustomDocumentOperation = CustomDocumentOperation,
> = (operation: TOperation) => void;

export type CustomOperationDefinition<
  TOperation extends CustomDocumentOperation = CustomDocumentOperation,
  TDoc = unknown,
> = {
  organization: string;
  typeSegment: string;
  description?: string;
  validate?: CustomOperationValidator<TOperation>;
  apply: (doc: TDoc, operation: TOperation) => TDoc;
  type?: never;
};

export type LegacyCompatibleCustomOperationDefinition<
  TOperation extends CustomDocumentOperation = CustomDocumentOperation,
  TDoc = unknown,
> = Omit<CustomOperationDefinition<TOperation, TDoc>, "typeSegment" | "type"> & {
  typeSegment?: string;
  type?: string;
};

export function normalizeCustomOperationOrganization(organization: string): string {
  const normalized = organization.trim().toLowerCase();
  if (!ORGANIZATION_DOMAIN_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid custom operation organization: ${organization}. Expected a bare domain like example.com`,
    );
  }
  return normalized;
}

export function validateCustomOperationTypeSegment(typeSegment: string): string {
  const normalized = typeSegment.trim();
  if (!CUSTOM_OPERATION_TYPE_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid custom operation type: ${typeSegment}. Expected an identifier like setReviewStatus`,
    );
  }
  return normalized;
}

export function createCustomOperationType(
  organization: string,
  typeSegment: string,
): CanonicalCustomOperationType {
  return `${normalizeCustomOperationOrganization(organization)}/${validateCustomOperationTypeSegment(
    typeSegment,
  )}`;
}

export function resolveCustomOperationTypeSegment(
  definition: Pick<LegacyCompatibleCustomOperationDefinition, "typeSegment" | "type">,
): string {
  const typeSegment = definition.typeSegment ?? definition.type;
  if (!typeSegment) {
    throw new Error("Custom operation definition requires a typeSegment");
  }
  return validateCustomOperationTypeSegment(typeSegment);
}

export function createCustomOperation<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
>(
  organization: string,
  typeSegment: string,
  payload: TPayload,
): CustomDocumentOperation<CanonicalCustomOperationType, TPayload> {
  return {
    ...payload,
    type: createCustomOperationType(organization, typeSegment),
  };
}
