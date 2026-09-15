import type {
  SessionBindingRecord as ProtocolSessionBindingRecord,
  SessionRecord as ProtocolSessionRecord,
  SessionForkRecord,
  SessionTurnIndexItem,
  SessionTurnRecord,
  SessionTurnSegmentRecord,
  MessageToolCallsFile,
  StoredIntermediateMessage,
  StoredToolCall,
  TurnIntermediateMessagesFile,
  SpaceTurnAuthorFilter as ProtocolSpaceTurnAuthorFilter,
  SpaceTurnListItem as ProtocolSpaceTurnListItem,
  SpaceTurnsResponse as ProtocolSpaceTurnsResponse,
} from "@cohub/protocol/model";
import type {
  ModelStatusEntry,
  ModelStatusResponse,
} from "@cohub/protocol/model/status";
import type {
  ChannelConfig,
  ChannelHealth,
} from "@cohub/protocol/gateway/types";
import type {
  ContentBlock,
  Usage,
} from "@cohub/protocol/core";
import type {
  CreateGenerationTaskRequest,
  CreateGenerationTaskResponse,
  GenerationContentBlock,
  GenerationPolicy,
  GenerationResult,
  GenerationTaskResult,
  GenerationUsageBilling,
  ListGenerationModelsResponse,
  PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import type { MessageRecord } from "@cohub/protocol/model";
import type { ModelThinkingLevel } from "@cohub/protocol";

export type {
  BoardAssetRef,
  BoardAuthoringItem,
  BoardAuthoringReadInput,
  BoardAuthoringSnapshot,
  BoardCapabilities,
  BoardCapability,
  BoardCameraFocus,
  BoardCameraFocusParams,
  BoardCameraState,
  BoardProceduralClip,
  BoardCoordinateSpace,
  BoardCreateInput,
  BoardDiagnostic,
  BoardEffect,
  BoardEffectInput,
  BoardAnimationSpec,
  BoardDealParams,
  BoardAnimationTarget,
  BoardCompositionPlayback,
  BoardEasing,
  BoardManifest,
  BoardItemPatch,
  BoardMutationReceipt,
  BoardPlaybackCommand,
  BoardPlaybackPolicy,
  BoardPlaybackSnapshot,
  BoardRecord,
  BoardRenderCost,
  BoardComposition,
  BoardSemanticCommand,
  BoardSemanticMutation,
  BoardSummary,
  BoardTimeline,
  BoardTimelineMarker,
  BoardTrack,
  BoardTransactionOperation,
  BoardTransactionRecord,
  BoardTransactionsPage,
  BoardTransactionsReadInput,
  BoardValidationResult,
  SpaceStartupResponse,
} from "@cohub/protocol";

export type {
  ChannelConfig,
  ChannelHealth,
  ChannelHealthReasonCode,
  ChannelRuntimeState,
  DiscordChannelConfig,
  FeishuChannelConfig,
} from "@cohub/protocol/gateway/types";

export type SpaceTurnAuthorFilter = ProtocolSpaceTurnAuthorFilter;
export type SpaceTurnListItem = ProtocolSpaceTurnListItem;
export type SpaceTurnsResponse = ProtocolSpaceTurnsResponse;

export type ApiError = {
  message: string;
};

export type UserProfile = {
  userUuid: string;
  logtoUserId?: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  syncedAt?: string;
};

export type PublicUserProfile = {
  userUuid: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type BatchUserProfilesResponse = {
  profiles: Record<string, PublicUserProfile>;
  missingUserUuids: string[];
};

export type PublicUserSpaceItem = {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  publicProfile: { avatarUrl: string | null };
  accessLabel: "public" | "sign-in-required";
  spaceUrl: string;
  updatedAt: string | null;
};

export type PublicUserAppItem = {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  icon?: string | null;
  spaceSlug: string;
  spaceName: string;
  publicUrl: string;
  publishedAt: string | null;
  updatedAt: string | null;
};

export type PublicUserPageResponse = {
  profile: PublicUserProfile;
  spaces: PublicUserSpaceItem[];
  apps: PublicUserAppItem[];
};

export type SpacePresenceUser = {
  userId: string;
  connectionCount: number;
  lastSeenAt: string;
  meta: Record<string, unknown> | null;
  metas: Record<string, unknown>[];
  profile: PublicUserProfile;
};

export type SpacePresenceSnapshot = {
  spaceId: string;
  users: SpacePresenceUser[];
  updatedAt: string;
};

export type MeResponse = {
  uuid: string;
  profile: UserProfile;
  email: string | null;
};

export type BillingPluginStatus = {
  provider: "disabled" | "talesofai";
  configured: boolean;
  reason?: string;
};

export type BillingCreditUnit = {
  tokenType: string;
  displayCurrency: "USD";
  displayUnit: string;
  unitToUsd: number;
  unitsPerUsd: number;
  usdDecimalPlaces: number;
};

export type BillingCreditGrantStatus = {
  id: string;
  tokenType: string;
  benefitKey: string | null;
  benefitName: string | null;
  grantKind: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: string;
  availableNow: boolean | null;
  unavailableReasons: string[];
  remainingAmount: number;
  remainingAmountUsd: number;
  originalAmount: number | null;
  originalAmountUsd: number | null;
  consumedAmount: number | null;
  consumedAmountUsd: number | null;
  usageConsumedAmount: number | null;
  usageConsumedAmountUsd: number | null;
  settledOverageAmount: number | null;
  settledOverageAmountUsd: number | null;
  consumedPercent: number | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  createdAt: string;
};

export type BillingCreditExpiryGroup = {
  key: "expired" | "lt_7d" | "lt_30d" | "gte_30d" | "never";
  remainingAmountUsd: number;
  grants: BillingCreditGrantStatus[];
};

export type BillingCreditStatus = {
  netUsd: number;
  groups: BillingCreditExpiryGroup[];
};

export type BillingProductKind = "plan" | "addon";

export type BillingProductBillingInterval =
  | "monthly"
  | "quarterly"
  | "yearly"
  | "one_time"
  | "other";

export type BillingProductPricing = {
  amountMinor: number;
  amountUsd: number;
  compareAtAmountMinor: number | null;
  compareAtAmountUsd: number | null;
  discountLabel: string | null;
  discountRate: number | null;
};

export type BillingDiscountPricing = {
  amountMinor: number;
  amountUsd: number;
  discountAmountMinor: number;
  discountAmountUsd: number;
  paidAmountMinor: number;
  paidAmountUsd: number;
  currency: string;
};

export type BillingDiscountOfferRef = {
  key: string;
  revision: string;
};

export type BillingDiscountOffer = {
  ref: BillingDiscountOfferRef;
  name: string;
  duration: "once" | "forever";
  endsAt: string | null;
  pricing: BillingDiscountPricing;
};

export type BillingProductPromotion = {
  kind: "first_purchase";
  percentOff: number;
  endsAt: string | null;
};

export type BillingProductDisplay = {
  description: string | null;
  benefits: string[];
  creditsAmount: number | null;
  validity: string | null;
  creditBenefits: BillingProductCreditBenefit[];
};

export type BillingProductCreditBenefit = {
  key: string;
  name: string;
  tokenType: string;
  grantKind: string;
  scope: string;
  cycleAmount: number;
  cycleAmountUsd: number;
  periodAmount: number;
  periodAmountUsd: number;
  expiresInDays: number | null;
};

export type BillingCatalogProduct = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  billingType: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currency: string;
  kind: BillingProductKind;
  interval: BillingProductBillingInterval;
  pricing: BillingProductPricing;
  promotion: BillingProductPromotion | null;
  offer: BillingDiscountOffer | null;
  display: BillingProductDisplay;
  isDefaultPlan: boolean;
};

export type SpaceCommerceFeatureBenefit = {
  key: string;
  name: string;
  description: string | null;
  status: string;
  type: "feature";
  config: { type: "feature"; metadata: Record<string, string | number | boolean> };
};

export type SpaceCommerceCreditsBenefit = {
  key: string;
  name: string;
  description: string | null;
  status: string;
  type: "credits";
  config: { type: "credits"; amount: number; expiresInDays: number | null };
};

export type SpaceCommerceBenefit = SpaceCommerceFeatureBenefit | SpaceCommerceCreditsBenefit;

export type SpaceCommerceProductCreditBenefit = {
  key: string;
  name: string;
  amount: number;
  expiresInDays: number | null;
};

export type SpaceCommerceProduct = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  billingType: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currency: string;
  kind: "addon";
  interval: "one_time";
  pricing: {
    amountMinor: number;
    amountUsd: number;
    compareAtAmountMinor: number | null;
    compareAtAmountUsd: number | null;
    discountLabel: string | null;
    discountRate: number | null;
  };
  display: {
    description: string | null;
    benefits: string[];
    creditsAmount: number | null;
    validity: string | null;
    creditBenefits: SpaceCommerceProductCreditBenefit[];
  };
  cohubBalance: {
    amountUsd: number;
    amountMinor: number;
    policyVersion: string;
  } | null;
  isDefaultPlan: boolean;
};

export type SpaceCommerceProductBenefitBinding = {
  id: string | null;
  productKey: string;
  benefitKey: string;
  createdAt: string | null;
};

export type SpaceCommerceBuyerProfile = {
  displayName: string;
  avatarUrl: string | null;
};

export type SpaceCommerceOrder = {
  id: string;
  productKeySnapshot: string;
  productNameSnapshot: string;
  status: string;
  amountSnapshot: number;
  paidAmountSnapshot: number;
  createdAt: string;
  paidAt: string | null;
  buyerProfile: SpaceCommerceBuyerProfile | null;
};

export type BillingSubscriptionSummary = {
  id: string;
  productKey: string | null;
  productName: string | null;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type BillingPaymentStatus = {
  available: boolean;
  reason: string | null;
};

export type BillingCatalog = {
  userId: string;
  billing: BillingPluginStatus;
  payment: BillingPaymentStatus;
  products: BillingCatalogProduct[];
  plans: BillingCatalogProduct[];
  addons: BillingCatalogProduct[];
  currentSubscriptions: BillingSubscriptionSummary[];
  hasActiveSubscription: boolean;
  defaultPlanProductKey: string | null;
};

export type BillingHistoryPagination = {
  hasMore: boolean;
  nextPage: number | null;
};

export type BillingCheckoutActionState = {
  canPay: boolean;
  checkoutUrl: string | null;
  checkoutUsable: boolean;
  canCancelCheckout: boolean;
  canCancelAutoRenew: boolean;
  unavailableReason: string | null;
};

export type BillingSubscriptionHistoryStatus = {
  id: string;
  externalUserId: string;
  productKey: string;
  productName: string;
  status: string;
  amountMinor: number;
  amountUsd: number;
  paidAmountMinor: number;
  paidAmountUsd: number;
  currency: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  checkoutExpiresAt: string | null;
  checkoutCanceledAt: string | null;
  checkoutExpiredAt: string | null;
  paymentConflictedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  providerStatus: string | null;
  providerTerminal: boolean;
  checkoutStatus: string | null;
  actions: BillingCheckoutActionState;
};

export type BillingSubscriptionHistoryList = {
  userId: string;
  billing: BillingPluginStatus;
  page: number;
  limit: number;
  items: BillingSubscriptionHistoryStatus[];
  pagination: BillingHistoryPagination;
};

export type BillingCheckoutResult = {
  userId: string;
  billing: BillingPluginStatus;
  payment: BillingPaymentStatus;
  productKey: string;
  checkoutUrl: string | null;
  checkoutUsable: boolean;
  message: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  reused: boolean;
};

export type BillingCheckoutConfirmation = {
  productKey: string;
  settled: boolean;
  status: string | null;
  pending: boolean;
  productName: string | null;
};

export type BillingPromotionCodePreview = {
  userId: string;
  productKey: string;
  promotionCode: string;
  eligible: boolean;
  reasonCode: string | null;
  message: string | null;
  name: string | null;
  duration: "once" | "forever" | null;
  endsAt: string | null;
  pricing: BillingDiscountPricing | null;
};

export type BillingRedemptionResult = {
  userId: string;
  billing: BillingPluginStatus;
  redeemed: boolean;
  message: string | null;
  redemptionRecordId: string | null;
  itemCount: number;
};

export type BillingConversionIntent = {
  level: "soft" | "hard";
  reason:
    | "negative_balance"
    | "negative_balance_limit_exceeded"
    | "balance_not_positive"
    | "minimum_balance_not_met"
    | "feature_not_entitled";
  audience: "free" | "paid" | "unknown";
  preferredOfferKind: "plan" | "upgrade" | "addon" | "mixed";
  title: string;
  message: string;
  primaryAction: {
    label: string;
    action: "open_billing_conversion";
  };
  source: string;
};

/**
 * Standard `billing` payload on 402 error bodies and soft-warning success
 * responses. `conversion` drives the shared upgrade UI.
 */
export type BillingResponsePayload = {
  conversion: BillingConversionIntent;
  status?: "blocked" | "allowed_with_debt";
  netUsd?: number;
  hardNegativeLimitUsd?: number;
  minimumBalanceUsd?: number;
};

export type BillingBalanceActivityKind =
  | "grant"
  | "usage"
  | "refund"
  | "expire"
  | "revoke"
  | "adjust";

export type BillingBalanceActivityStatus = "covered" | "overage" | "partial" | null;

export type BillingBalanceActivity = {
  id: string;
  kind: BillingBalanceActivityKind;
  tokenType: string;
  title: string;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  operationId: string | null;
  amountUsd: number;
  status: BillingBalanceActivityStatus;
  createdAt: string;
};

export type BillingBalanceActivityList = {
  userId: string;
  billing: BillingPluginStatus;
  tokenType: string;
  unit: BillingCreditUnit;
  page: number;
  limit: number;
  items: BillingBalanceActivity[];
  pagination: BillingHistoryPagination;
};

export type UserRulesResponse = {
  content: string;
  updatedAt: string | null;
  source: "config-space";
  path: string;
};

export type {
  ContentBlock,
  MessageRecord,
  SessionTurnRecord,
  SessionTurnIndexItem,
  MessageToolCallsFile,
  StoredIntermediateMessage,
  StoredToolCall,
  TurnIntermediateMessagesFile,
  SessionForkRecord,
  SessionTurnSegmentRecord,
  CreateGenerationTaskRequest,
  CreateGenerationTaskResponse,
  GenerationContentBlock,
  GenerationPolicy,
  GenerationResult,
  GenerationTaskResult,
  GenerationUsageBilling,
  ListGenerationModelsResponse,
  PublicGenerationDeclaration,
  ModelStatusEntry,
  ModelStatusResponse,
};

export type SpaceFsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mimeType: string | null;
  mtimeMs: number;
};

export type SpaceFsTreeResponse = { path: string; entries: SpaceFsEntry[] };
export type SpaceFsFileKind = "text" | "binary";
export type SpaceFsEncoding = "utf-8" | "base64";
export type SpaceFsFileResponse = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  /** File metadata change time in epoch milliseconds, when available. */
  ctimeMs?: number;
  kind: SpaceFsFileKind;
  encoding: SpaceFsEncoding;
  content: string;
  delivery?: "inline" | "url";
  url?: string;
};
export type SpaceFsReadFilesInput = {
  paths: string[];
};
export type SpaceFsReadFilesError = {
  path: string;
  code: string;
  message: string;
  status: number;
};
export type SpaceFsPreparingFile = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  retryAfterMs: number;
};
export type SpaceFsReadFilesResponse = {
  files: SpaceFsFileResponse[];
  preparing?: SpaceFsPreparingFile[];
  errors: SpaceFsReadFilesError[];
};
export type SpaceFsWriteFileInput = {
  path: string;
  content: string;
  encoding: SpaceFsEncoding;
  expected?: {
    mtimeMs: number;
    size: number;
  };
  mutationId?: string;
};
export type SpaceFsMoveInput = {
  fromPath: string;
  toPath: string;
  mutationId?: string;
};
export type SpaceFsCreateDirectoryInput = {
  path: string;
  mutationId?: string;
};
export type SpaceFsDeleteNodeInput = {
  path: string;
  recursive?: boolean;
  mutationId?: string;
};
export type SpaceFsUploadEntry = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  /** Whether this upload created the file rather than replacing it. */
  created?: boolean;
};
export type SpaceFsUploadError = {
  name: string;
  code: "file_too_large" | "name_invalid" | "path_invalid" | "write_failed" | "object_missing";
  message: string;
};
export type SpaceFsUploadResponse = {
  uploaded: SpaceFsUploadEntry[];
  errors: SpaceFsUploadError[];
  /** Workspace-relative directories created while materializing the upload. */
  createdDirs?: string[];
};
export type SpaceFsUploadPlanEntryInput = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType?: string | null;
  lastModified?: number;
  /**
   * Optional durable public URL. When set, client skips PUT and complete pulls from this URL.
   * Must be an allowed public-asset origin.
   */
  downloadUrl?: string;
};
export type SpaceFsUploadDestination =
  | {
      kind: "workspace";
      targetDir?: string;
    }
  | {
      kind: "sandbox_tmp";
      /** Optional association only; materialize path is /tmp/uploads/{uploadId}. */
      sessionId?: string;
    };
export type SpaceFsCreateUploadInput = {
  destination: SpaceFsUploadDestination;
  entries: SpaceFsUploadPlanEntryInput[];
};
export type SpaceFsUploadPlanEntry = {
  id: string;
  /** Present for client-PUT entries; omitted for remote downloadUrl entries. */
  objectKey?: string;
  /** Present for client-PUT entries; omitted for remote downloadUrl entries. */
  uploadUrl?: string;
  headers?: Record<string, string>;
  /** Echo of remote source when entry uses downloadUrl. */
  downloadUrl?: string;
};
export type SpaceFsCreateUploadResponse = {
  uploadId: string;
  expiresAt: string;
  entries: SpaceFsUploadPlanEntry[];
};
export type SpaceFsCompleteUploadInput = {
  entries: Array<{ id: string; etag?: string | null }>;
};
export type SpaceFsCompleteUploadResponse = {
  ok: true;
  uploaded: SpaceFsUploadEntry[];
};
export type SpaceFsUploadProgress = {
  phase: "queued" | "importing" | "done" | "failed";
  totalFiles: number;
  importedFiles: number;
  totalBytes: number;
  importedBytes: number;
  currentPath?: string;
  errors: SpaceFsUploadError[];
};


export type SessionBindingRecord = ProtocolSessionBindingRecord;

export type SessionRecord = ProtocolSessionRecord & {
  bindings?: SessionBindingRecord[];
  totalMessages?: number;
  totalToolCalls?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: string | number | null;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type SpaceSandboxAutoDestroyPolicy =
  | { mode: "idle"; ttlSeconds: number }
  | { mode: "never" };

export type SpaceSandboxProvider = "cloud" | "local";
export type SandboxSpecId = "standard" | "boost" | "ultra";

export type SpaceSandboxConfig = {
  provider?: SpaceSandboxProvider;
  autoDestroy: SpaceSandboxAutoDestroyPolicy;
  spec?: SandboxSpecId;
  appliedSpec?: SandboxSpecId | null;
  specPendingRestart?: boolean;
  allowedSpec?: SandboxSpecId;
  specs?: Record<string, unknown>;
};

export type SpaceConfig = {
  sandbox?: SpaceSandboxConfig;
};

export type SpaceBootstrapSource =
  | { type: "blank" }
  | { type: "git_repo"; repoUrl: string; ref?: string | null }
  | { type: "checkpoint"; checkpointId: string };

export type SpaceBootstrapStatus = "pending" | "running" | "ready" | "failed";

export type SpaceBootstrapStage =
  | "prepare"
  | "import"
  | "checkpoint_restore"
  | "finalize";

export type SpaceBootstrapMeta = {
  source: SpaceBootstrapSource;
  status: SpaceBootstrapStatus;
  stage: SpaceBootstrapStage | null;
  taskRunId: string | null;
  errorMessage: string | null;
  errorCode?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stageTimings?: Record<string, number>;
  initialCheckpointTaskRunId?: string | null;
};

export type SpacePublicProfile = {
  avatarUrl: string | null;
};

export type SpaceMeta = JsonObject & {
  config?: SpaceConfig;
  extraEnv?: SpaceEnvInput[];
  bootstrap?: SpaceBootstrapMeta;
  publicProfile?: Partial<SpacePublicProfile> | null;
};

export type SpaceRecord = {
  id: string;
  userUuid: string;
  name: string | null;
  slug: string | null;
  description: string | null;
  storageRepoName?: string | null;
  baseCheckpointId?: string | null;
  headCheckpointId?: string | null;
  title: string | null;
  status: string | null;
  meta: SpaceMeta | null;
  publicProfile?: SpacePublicProfile;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string | null;
  channels?: {
    id: string;
    name: string | null;
    provider: string;
    status: string;
  }[];
  access?: SpaceAccess;
  accessLevel?: "minimal";
  ownerProfile?: Pick<UserProfile, "userUuid" | "username" | "displayName" | "avatarUrl"> | null;
  /** Whether the viewer has pinned this space (only present in list responses). */
  isPinned?: boolean;
};

export type SpaceConfigInput = {
  sandbox?: {
    provider?: SpaceSandboxProvider;
    autoDestroy?: SpaceSandboxAutoDestroyPolicy;
    spec?: SandboxSpecId;
  };
};

export type CreateSpaceModInput = {
  modSpaceId: string;
  name?: string | null;
  mountSlug?: string | null;
  enabled?: boolean;
};

export type CreateSpaceInput = {
  name: string;
  slug?: string | null;
  description?: string | null;
  source?: string;
  extraEnv?: SpaceEnvInput[];
  channelBindings?: SpaceChannelBindingInput[];
  mods?: CreateSpaceModInput[];
  bootstrapSource?: SpaceBootstrapSource;
  config?: SpaceConfigInput;
};

export type SpaceConfigResponse = {
  config: Required<Pick<SpaceConfig, "sandbox">>;
};

export type SpaceConfigUpdateResponse = {
  space: SpaceRecord;
  sandbox?: {
    resized?: boolean;
    applying?: boolean;
    pendingRestart?: boolean;
    appliedSpec?: SandboxSpecId;
    skipped?: boolean;
    message?: string;
  };
};

export type SpaceCreateResponse = {
  space: SpaceRecord;
  taskRunId: string;
};

export type SpaceDefaultResponse = {
  space: SpaceRecord | null;
};

export type SpaceListItem = SpaceRecord;

export type SessionMessagesResponse = {
  session: SessionRecord;
  messages: MessageRecord[];
};

export type SessionMessageResponse = {
  session: SessionRecord;
  message: MessageRecord;
};

export type SessionMessagesPaginatedResponse = {
  session: SessionRecord;
  messages: MessageRecord[];
  hasMore: boolean;
  nextCursor: number | undefined;
};

export type SessionTurnsPaginatedResponse = {
  session: SessionRecord;
  turns: SessionTurnRecord[];
  hasMore: boolean;
  nextCursor: number | undefined;
};

export type SessionTurnIndexResponse = {
  session: SessionRecord;
  turns: SessionTurnIndexItem[];
  hasMore: boolean;
  nextCursor: number | undefined;
};

export type SessionTurnWindowResponse = {
  session: SessionRecord;
  turns: SessionTurnRecord[];
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  oldestCursor: number | undefined;
  newestCursor: number | undefined;
  anchorSequence: number | undefined;
};

export type SessionTurnResponse = {
  session: SessionRecord;
  turn: SessionTurnRecord;
  billing?: BillingResponsePayload | null;
};

export type SessionTurnSignedUrlsResponse = {
  urls: Record<string, string>;
};

export type SessionTurnStreamSnapshotResponse = {
  snapshot: {
    version: 2;
    spaceId: string;
    sessionId: string;
    turnId: string | null;
    anchorUserMessageId: string | null;
    seq: number;
    current: {
      messageId: string | null;
      messageOrdinal: number | null;
      content: ContentBlock[];
      appendPath: string | null;
    };
    intermediateMessages: Array<{
      messageId: string | null;
      messageOrdinal: number | null;
      content: ContentBlock[];
      id?: string;
      sessionId?: string;
      role?: "user" | "assistant" | "system";
      text?: string | null;
      provider?: string | null;
      model?: string | null;
      stopReason?: string | null;
      errorMessage?: string | null;
      usage?: Usage | null;
      toolCallsObjectKey?: string | null;
      meta?: Record<string, unknown> | null;
      createdAt?: string;
    }>;
    lifecycle?: {
      phase: "llm_call_started";
      llmRound: number;
      provider: string | null;
      model: string | null;
      at: string;
    } | null;
    updatedAt: number;
  } | null;
};

export type ModelCatalogEntry = {
  provider: string;
  id: string;
  model: Record<string, unknown>;
};

export type PromptTemplateCatalogEntry = {
  name: string;
  description: string;
  argumentHint?: string;
  category?: string;
  /** When true, this prompt is surfaced as a quick action button above the chat composer. */
  quickAction?: boolean;
  /** Optional override label for the quick action button. */
  buttonLabel?: string;
  /** Optional sort weight for quick action buttons (ascending, lower first). */
  order?: number;
  scope: "platform" | "mod" | "user" | "project";
};

export type PromptTemplateCatalogResponse = {
  prompts: PromptTemplateCatalogEntry[];
};

export type SkillCatalogSource = {
  type: "mod";
  modSpaceId: string;
  mountSlug: string;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  scope: "platform" | "mod" | "user" | "project";
  source?: SkillCatalogSource;
};

export type SkillCatalogResponse = {
  skills: SkillCatalogEntry[];
};

export type Channel = {
  id: string;
  userUuid: string;
  provider: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  boundSpace: {
    id: string;
    title: string | null;
    status: string;
  } | null;
  health?: ChannelHealth | null;
};

export type SpaceEnvInput = {
  name: string;
  value: string;
};

export type SpaceChannelBindingInput = {
  channelId: string;
  config?: ChannelConfig | null;
};

export type GlobalSearchType = "turn" | "session" | "space" | "label";

export type GlobalSearchViewerRelation = "creator" | "participant" | "unrelated";

export type GlobalSearchResult = {
  type: GlobalSearchType;
  id: string;
  spaceId: string;
  sessionId: string | null;
  turnId: string | null;
  sequence: number | null;
  title: string;
  excerpt?: string | null;
  spaceName?: string | null;
  sessionTitle?: string | null;
  ownerProfile?: Pick<UserProfile, "userUuid" | "username" | "displayName" | "avatarUrl"> | null;
  spaceProfile?: SpacePublicProfile | null;
  matchedField: "userText" | "title" | "name" | "description" | "labelName" | "labelItemContent";
  viewerRelation?: GlobalSearchViewerRelation | null;
  effectiveTier?: number | null;
  href: string;
  score: number;
  textScore: number;
  recencyScore: number;
  typePriorityScore: number;
  membershipPriorityScore?: number;
  labelRef?: string | null;
  labelName?: string | null;
  labelResourceType?: LabelResourceType | null;
  labelResourceRef?: string | null;
  updatedAt: string | null;
  source: "remote";
};

export type GlobalSearchResponse = {
  items: GlobalSearchResult[];
  query: string;
  source: "remote";
  degraded?: boolean;
};

export type PaletteOverviewSpaceRelation = "owner" | "member" | "public";

export type PaletteOverviewSpace = {
  id: string;
  name: string | null;
  description: string | null;
  ownerProfile: Pick<UserProfile, "userUuid" | "username" | "displayName" | "avatarUrl"> | null;
  spaceProfile: SpacePublicProfile | null;
  isPinned: boolean;
  relation: PaletteOverviewSpaceRelation;
  lastParticipatedAt: string | null;
  updatedAt: string | null;
};

export type PaletteOverviewSession = {
  id: string;
  spaceId: string;
  spaceName: string | null;
  title: string | null;
  viewerRelation: "creator" | "participant";
  lastMessageAt: string | null;
  updatedAt: string | null;
};

export type PaletteOverviewResponse = {
  generatedAt: string;
  spaces: PaletteOverviewSpace[];
  recentSessions: PaletteOverviewSession[];
  /** Present when the server could not produce a complete overview. */
  degraded?: boolean;
};

export type CreateSpaceSessionInput = {
  title?: string | null;
  /** Optional channel; falls back to X-Cohub-Source-Via. */
  source?: string | null;
  labelRefs?: string[];
};

export type SpaceSessionsResponse = {
  sessions: SessionRecord[];
  forks?: Array<SessionForkRecord & {
    firstUserTextAfterFork?: string | null;
    parentTitle?: string | null;
  }>;
  pageInfo?: {
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type UserSessionSpaceSummary = {
  id: string;
  name: string;
  slug: string | null;
  publicProfile?: SpacePublicProfile | null;
};

/** Cross-space session list item returned by `GET /api/me/sessions`. */
export type UserSessionListItem = SessionRecord & {
  space?: UserSessionSpaceSummary | null;
};


/**
 * Source kinds for the `source` query on `GET /api/me/sessions`. Keys match the
 * `Source/*` labels a space sidebar shows; `other` catches anything unlabelled.
 */
export type UserSessionSourceKey =
  | "public_api"
  | "scheduled_task"
  | "space_hook"
  | "web"
  | "websocket"
  | "cli"
  | "feishu"
  | "wechat"
  | "discord"
  | "qq"
  | "other";

export type UserSessionsResponse = {
  sessions: UserSessionListItem[];
  pageInfo?: {
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type PromptAccessMode = "read_only" | "full_access";

export type CreateSpacePromptInput = {
  mode?: "agent" | "create";
  generation?: {
    model: string;
    content: GenerationContentBlock[];
    parameters?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  } | null;
  sessionId?: string | null;
  title?: string | null;
  /** Optional channel; falls back to X-Cohub-Source-Via. */
  source?: string | null;
  content?: ContentBlock[];
  model?: string | null;
  provider?: string | null;
  /** Optional thinking level override for this turn. Omit to inherit session default. */
  thinkingLevel?: ModelThinkingLevel | null;
  clientMessageId?: string | null;
  generationPolicy?: GenerationPolicy | null;
  intent?: "followup" | "steer" | "compact" | null;
  accessMode?: PromptAccessMode | null;
  env?: Record<string, string> | null;
  labelRefs?: string[];
  schedule?:
    | { mode?: "immediate" }
    | { mode: "delay"; delayMs: number }
    | { mode: "at"; sendAt: string }
    | { mode: "repeat"; cronExpression: string; timezone: string };
};

export type CreateSpacePromptResponse =
  | (SessionTurnResponse & { mode: "immediate"; execution?: { kind: "direct_generation"; taskRunId: string } })
  | {
      mode: "delay" | "at";
      taskRunId: string;
      scheduledAt: string;
      sessionId: string | null;
    }
  | {
      mode: "repeat";
      cronJobId: string;
      nextRunAt: string;
      timezone: string;
      sessionId: string | null;
    };

export type {
  CompletionAssistantMessage,
  CompletionMessage,
  CompletionMessageRole,
  CompletionThinkingLevel,
  CompletionUsage,
  CreateSpaceCompletionInput,
  ModelThinkingLevel,
  SpaceCompletionResult,
  SpaceCompletionStreamEvent,
} from "@cohub/protocol";

export type CronJobPayload = Record<string, unknown>;

export type SendMessageCronJobPayload = CronJobPayload & {
  content: ContentBlock[];
  clientMessageId?: string;
  generationPolicy?: unknown;
  intent?: "followup" | "steer" | string;
  accessMode?: "read_only" | "full_access";
  env?: Record<string, string> | null;
  source?: string;
  sessionId?: string;
  title?: string;
  model?: string;
  provider?: string;
  thinkingLevel?: ModelThinkingLevel | null;
  labelIds?: string[];
};

export type CronJobUpdatePatch<TPayload extends CronJobPayload = CronJobPayload> = {
  title?: string;
  payload?: TPayload;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export type CursorPageInfo = {
  hasMore: boolean;
  nextCursor: string | null;
};

export type CronJobRecord<TPayload extends CronJobPayload = CronJobPayload> = {
  id: string;
  userUuid: string;
  userProfile?: UserProfile;
  title: string;
  taskType: string;
  payload: TPayload;
  cronExpression: string;
  timezone: string;
  bullJobKey: string;
  spaceId: string | null;
  sessionId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskRunDetailResponse = {
  run: TaskRunRecord;
  progress: unknown;
};

export type TaskRunRecord = {
  id: string;
  jobId: string;
  cronJobId: string | null;
  taskType: string;
  status: "pending" | "running" | "completed" | "failed";
  payload: unknown;
  result: unknown;
  errorMessage: string | null;
  attemptCount: number;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  userUuid: string | null;
  userProfile?: UserProfile;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CheckpointRecord = {
  id: string;
  spaceId: string;
  commitHash: string;
  description: string;
  parentCheckpointId: string | null;
  rootCheckpointId?: string | null;
  forkCount: number;
  saveVersion?: number;
  meta?: Record<string, unknown> | null;
  createdAt: string;
};

export type SpaceCheckpointDetailResponse = {
  checkpoint: CheckpointRecord;
};

export type CheckpointDiffStatus = "A" | "M" | "D" | "R" | "C" | "T";

export type CheckpointDiffStats = {
  changedFileCount: number;
  addedFileCount: number;
  modifiedFileCount: number;
  deletedFileCount: number;
  renamedFileCount: number;
  copiedFileCount: number;
  additions: number;
  deletions: number;
};

export type CheckpointDiffFile = {
  status: CheckpointDiffStatus;
  path: string;
  oldPath?: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  asset: boolean;
};

export type CheckpointDiffDelivery = "inline" | "url";

export type CheckpointDiffSummary = {
  baseCheckpointId: string | null;
  baseCommitHash: string | null;
  headCheckpointId: string;
  headCommitHash: string;
  files: CheckpointDiffFile[];
  truncated: boolean;
  stats: CheckpointDiffStats;
  delivery?: CheckpointDiffDelivery;
  url?: string;
  precomputed?: boolean;
};

export type CheckpointDiffPatchKind =
  | "text"
  | "binary"
  | "asset"
  | "too_large"
  | "unavailable";

export type CheckpointDiffPatchLine = {
  type: "context" | "add" | "del" | "hunk" | "meta";
  text: string;
};

export type CheckpointDiffFileResponse = {
  path: string;
  oldPath?: string | null;
  status: CheckpointDiffStatus | null;
  kind: CheckpointDiffPatchKind;
  binary: boolean;
  asset: boolean;
  additions: number | null;
  deletions: number | null;
  oldSize?: number | null;
  newSize?: number | null;
  truncated: boolean;
  lines: CheckpointDiffPatchLine[];
  delivery?: CheckpointDiffDelivery;
  url?: string;
  precomputed?: boolean;
};

export type SpacePendingDiffSummary = {
  baseCheckpointId: string | null;
  files: CheckpointDiffFile[];
  truncated: boolean;
  incomplete: boolean;
  stats: CheckpointDiffStats;
};

export type SpacePendingDiffFileResponse = CheckpointDiffFileResponse & {
  baseCheckpointId: string | null;
};

// ─── RBAC types ───

export type SpaceRole = "host" | "builder" | "guest";

export type SpaceMember = {
  userId: string;
  role: SpaceRole;
  profile: UserProfile;
  createdAt: string;
  updatedAt: string;
};

export type LabelScopeType = "space" | "user" | "org";

export type LabelSource = "user" | "system";

export type LabelResourceType = "session" | "checkpoint" | "file" | "space";

export type LabelRecord = {
  id: string;
  scopeType: LabelScopeType;
  scopeId: string;
  name: string;
  slug: string;
  parentId: string | null;
  depth: number;
  source: LabelSource;
  systemKey: string | null;
  rank: number;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type LabelListItem = LabelRecord & {
  children?: LabelListItem[];
};

export type LabelAssignmentRecord = {
  id: string;
  labelId: string;
  scopeType: LabelScopeType;
  scopeId: string;
  resourceType: LabelResourceType;
  resourceRef: string;
  rank: number | null;
  source: LabelSource;
  createdBy: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Label metadata joined in user-scope assignment responses. */
  labelSystemKey?: string | null;
  labelName?: string;
};

export type LabelAssignmentListItem = LabelAssignmentRecord & {
  href: string;
  resource: {
    title: string;
    subtitle: string | null;
    status: string | null;
  } | null;
};

export type LabelAssignmentPageInfo = {
  hasMore: boolean;
  nextCursor: string | null;
};

/** Optional hydrated session previews for label item pages (avoids N+1 session detail fetches). */
export type LabelItemsSessionFork = SessionForkRecord & {
  firstUserTextAfterFork?: string | null;
  parentTitle?: string | null;
};

export type LabelItemsResponse = {
  items: LabelAssignmentListItem[];
  pageInfo: LabelAssignmentPageInfo;
  /** Hydrated sessions for this page (optional for older servers). */
  sessions?: SessionRecord[];
  /** Fork edges for page sessions (optional for older servers). */
  forks?: LabelItemsSessionFork[];
};

export type PatchResourceLabelsInput = {
  addLabelRefs?: string[];
  removeLabelRefs?: string[];
};

export type ResourceLabelsResponse = {
  labels: LabelListItem[];
  assignments: LabelAssignmentRecord[];
};

export type PatchResourceLabelsResponse = ResourceLabelsResponse & {
  changed: boolean;
};

export type SpaceModListItem = {
  id: string;
  spaceId: string;
  modSpaceId: string;
  name: string | null;
  mountSlug: string;
  mountPath: string;
  enabled: boolean;
  sortOrder: number;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
  modSpaceName: string | null;
  modSpaceDescription: string | null;
};

/**
 * The full permission vocabulary, mirrored from `@cohub/core` permissions.
 * Kept as a runtime constant so hosts can validate untrusted scopes from
 * app iframes — TypeScript unions cannot constrain cross-window messages.
 */
export const PERMISSIONS = [
  "space.view",
  "space.edit",
  "space.create",
  "space.label.view",
  "space.label.manage",
  "space.label.assign",
  "session.view",
  "session.edit",
  "session.prompt.readonly",
  "session.prompt.fullaccess",
  "session.access.manage",
  "generation.create",
  "file.view",
  "file.view.filtered",
  "file.edit",
  "checkpoint.view",
  "checkpoint.edit",
  "member.view",
  "member.manage",
  "references.view",
  "channel.view",
  "channel.manage",
  "cronjob.view",
  "cronjob.manage",
  "taskrun.view",
  "command.execute",
  "sandbox.view",
  "sandbox.manage",
  "mod.view",
  "mod.manage",
  "space.commerce.view",
  "space.commerce.manage",
  "user.space.list",
  "user.session.list",
  "user.taskrun.list",
  "user.usage.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Account-level permissions, not bound to a specific Space. Mirrored from
 * `@cohub/core` alongside {@link PERMISSIONS}. A request whose scopes are all
 * account-level needs no target Space and must not open a Space picker.
 */
export const USER_LEVEL_PERMISSIONS = new Set<Permission>([
	"user.space.list",
	"user.session.list",
	"user.taskrun.list",
	"user.usage.read",
	"space.create",
]);

export const isUserLevelPermission = (permission: Permission): boolean =>
	USER_LEVEL_PERMISSIONS.has(permission);

/** A held permission that already covers the checked one. */
const IMPLIED_PERMISSIONS: Partial<Record<Permission, readonly Permission[]>> = {
  "session.prompt.readonly": ["session.prompt.fullaccess"],
  "file.view.filtered": ["file.view"],
};

/** Implication-aware membership check, mirroring `@cohub/core`. */
export function scopeListHasPermission(
	scopes: readonly Permission[],
	permission: Permission,
): boolean {
	if (scopes.includes(permission)) return true;
	return (IMPLIED_PERMISSIONS[permission] ?? []).some((implies) =>
		scopes.includes(implies),
	);
}

export type SpaceAccess = {
  role: SpaceRole | null;
  permissions: Permission[];
};

export type SpaceAccessPolicy = {
  signed_in_user: SpaceRole | null;
  anonymous_user: SpaceRole | null;
};

export type SpaceUsageHourlyStat = {
  bucketStartAt: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  models: string[];
};

export type SpaceUsageSummary = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
};

export type GenerationUsageHourlyStat = {
  bucketStartAt: Date | string;
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  models: string[];
  usageTypes: string[];
};

export type GenerationUsageSummary = {
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
};

export type GenerationUsageBlock = {
  hourly: GenerationUsageHourlyStat[];
  summary: GenerationUsageSummary;
};

export type SpaceUsageResponse = {
  hourly: SpaceUsageHourlyStat[];
  summary: SpaceUsageSummary;
  /** Generation rollups (image / video / music). Optional for older servers. */
  generation?: GenerationUsageBlock;
  days: number;
};

export type UserActivityQuery = {
  days?: number;
  from?: string | Date;
  to?: string | Date;
};

export type UserActivityRange = {
  from: string;
  to: string;
};

export type UserActivityRankings = {
  llmModels: Array<{
    provider: string;
    model: string;
    totalTokens: number;
    requestCount: number;
    costTotal: number;
  }>;
  generationModels: Array<{
    provider: string;
    model: string;
    requestCount: number;
    costTotal: number;
  }>;
  apps: Array<{
    appId: string;
    spaceId: string;
    spaceName: string;
    slug: string;
    title: string;
    status: "published" | "disabled";
    viewCount: number;
  }>;
};

export type UserActivityResponse = SpaceUsageResponse & {
  range: UserActivityRange;
  rankings: UserActivityRankings;
};

export type SpaceActivityAppRanking = {
  appId: string;
  slug: string;
  title: string;
  status: "published" | "disabled";
  viewCount: number;
};

export type SpaceActivityContributor = {
  userUuid: string;
  role: SpaceRole | null;
  tokens: number;
  requests: number;
  /** Zeroed for viewers without space-management access. */
  costTotal: number;
  /** Distinct sessions with usage inside the selected range. */
  sessionCount: number;
  lastActiveAt: string | null;
  profile: PublicUserProfile | null;
};

export type SpaceActivityResponse = SpaceUsageResponse & {
  rankings: {
    llmModels: UserActivityRankings["llmModels"];
    generationModels: UserActivityRankings["generationModels"];
    apps: SpaceActivityAppRanking[];
  };
  contributors: {
    items: SpaceActivityContributor[];
    /** Total space members — independent of the selected range. */
    memberCount: number;
  };
};

// ─── Referral types ───

export type ReferralStatus = "pending" | "qualified" | "rewarded";

export type ReferralReward = {
  inviterUsd: number;
  inviteeUsd: number;
};

export type PublicReferral = {
  code: string;
  inviter: Pick<UserProfile, "userUuid" | "username" | "displayName" | "avatarUrl">;
  reward: ReferralReward;
};

export type ClaimReferralResponse = {
  referralId: string;
  status: ReferralStatus;
};

export type ReferralListItem = {
  id: string;
  status: ReferralStatus;
  claimedAt: string;
  qualifiedAt: string | null;
  rewardedAt: string | null;
  profile: Pick<UserProfile, "userUuid" | "username" | "displayName" | "avatarUrl"> | null;
};

export type ReferralDashboard = {
  code: string;
  reward: ReferralReward;
  summary: {
    total: number;
    pending: number;
    qualified: number;
    rewarded: number;
    earnedUsd: number;
  };
  items: ReferralListItem[];
};

// ─── Invitation types ───

export type SpaceInvitation = {
  token: string;
  role: SpaceRole;
  status: "active" | "revoked" | "exhausted";
  useCount: number;
  maxUses: number | null;
  createdAt: string | null;
  expiresInSeconds: number | null;
};

export type SpaceInvitationLocation = {
  spaceId: string;
  spaceSlug: string | null;
  ownerUsername: string | null;
};

export type SpaceInvitationListResponse = SpaceInvitationLocation & {
  items: SpaceInvitation[];
};

export type CreateInvitationInput = {
  role?: SpaceRole;
  ttlSeconds?: number;
  maxUses?: number;
};

export type CreateInvitationResponse = SpaceInvitationLocation & {
  token: string;
  role: SpaceRole;
  expiresAt: string;
  maxUses: number | null;
};

export type InvitationDetail = SpaceInvitationLocation & {
  token: string;
  spaceName: string;
  role: SpaceRole;
  expiresInSeconds: number | null;
};

export type AcceptInvitationResponse = SpaceInvitationLocation & {
  ok: true;
  spaceName: string;
  role: SpaceRole;
};

// ─── Reference types ───

export type ReferenceResourceType =
  | "turn"
  | "session"
  | "space"
  | "checkpoint"
  | "file"
  | "app";

/**
 * Resource types usable as a query `source`: they resolve to an owning space to
 * authorize against. `turn` gives the finest precision; session/space roll up.
 * `file` appears only as an edge target, never as a queryable source.
 */
export type ReferenceQueryableType = "turn" | "session" | "space" | "checkpoint";

export type ReferenceKind =
  | "session_fork"
  | "space_fork"
  | "checkpoint_fork"
  | "mod"
  | "mention"
  | "tool_call"
  | "agent_tool_file_read"
  | "agent_tool_file_write"
  | "agent_tool_file_edit"
  | "agent_tool_file_ls"
  | "agent_tool_file_find"
  | "agent_tool_file_grep";

export type ReferenceDirection = "out" | "in" | "both";

export type ReferenceRecord = {
  kind: ReferenceKind;
  sourceType: ReferenceResourceType;
  sourceId: string;
  targetType: ReferenceResourceType;
  targetId: string;
  sourceSpaceId: string;
  sourceSessionId: string | null;
  count: number;
  createdAt: string;
  updatedAt: string;
  meta: Record<string, unknown> | null;
};

export type ReferenceQueryResponse = {
  source: string;
  direction: ReferenceDirection;
  references: ReferenceRecord[];
};

export type ReferenceAggregateGroupBy = "kind" | "targetType" | "target" | "sourceType" | "day";

export type ReferenceAggregateGroup = {
  group: string;
  references: number;
  total: number;
};

export type ReferenceAggregateResponse = {
  space: string;
  groupBy: ReferenceAggregateGroupBy;
  groups: ReferenceAggregateGroup[];
};

/** @deprecated Use `PublicUserAppItem`. */
export type PublicUserWorkItem = PublicUserAppItem;
