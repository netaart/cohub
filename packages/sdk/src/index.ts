export {
  RUNTIME_PROTOCOL_VERSION, RUNTIME_MAX_FRAME_BYTES, runtimeCommandSchema, runtimeEventSchema, runtimeReadySchema,
  contextToPiMessages, contextToTranscript, isLocalHarness, resolveHarness,
} from "@cohub/protocol";
export type {
  HarnessKind, LocalHarness, RuntimeCapabilities, RuntimeCommand, RuntimeContext,
  RuntimeContextMessage, RuntimeTurnInput, RuntimeMessage, RuntimeExecutionEvent, HarnessArchive,
  RuntimeStatus, RuntimeStopConfirmation,
} from "@cohub/protocol";
export { CohubHttpClient, createHttpClient } from "./http.js";
export { BillingApi } from "./apis/billing.js";
export { CohubClient, createCohubClient } from "./client.js";
export { WebsocketClient, createWebsocketClient } from "./websocket.js";
export { VoiceApi, VoiceInputClient, createVoiceInputClient } from "./voice-input.js";
export { UsersApi } from "./apis/users.js";
export { AppsApi } from "./apis/apps.js";
export { DesktopCommandsApi } from "./apis/desktop-commands.js";
export type { CreateDesktopCommandInput, WaitForDesktopCommandOptions } from "./apis/desktop-commands.js";
export { AppSurfaceApi } from "./app-surface.js";
export type { AppSurfaceHandler, AppSurfaceHandlerContext } from "./app-surface.js";
export {
  formatAppRef,
  isAppId,
  parseAppRef,
  AppRefParseError,
} from "./app-ref.js";
export type { ParsedAppRef, AppPublicRef } from "./app-ref.js";
export { isUuid } from "@cohub/protocol/identifiers";
export { AppCommerceApi } from "./apis/app-commerce.js";
export { AppRealtimeApi, AppRoom } from "./apis/app-realtime.js";
export { ReferencesApi } from "./apis/references.js";
export { ReferralsApi } from "./apis/referrals.js";
export { buildSpaceInvitePath, buildSpacePath } from "./apis/invitations.js";
export type { BuildSpaceInvitePathInput, BuildSpacePathInput } from "./apis/invitations.js";
export type { ReferenceResourceSelector } from "./apis/references.js";
export type { AppAuthorizationRequest } from "./app-runtime.js";
export type { AppAuthorizationResult, AppAuthorizationTarget, AppAuthorizationGrant } from "@cohub/protocol";
export { ParentBridgeTransport, PopupBrokerTransport, AppRuntimeError, AppRuntimeApi, createSlugAppIdResolver, createAppRuntime, resolveAppTransport } from "./app-runtime.js";
export type { AppContextChangedListener, AppDiagnostic, AppDiagnosticListener, AppIdResolver, AppRuntimeInvocationContext, AppRuntimeModeConfig, AppRuntimeRequestOptions, AppRuntimeShellContext, AppRuntimeTransport, AppRuntimeConfigureRequest, AppRuntimeAnchor, AppRuntimeRect } from "./app-runtime.js";
export { attachAppEmbed } from "./app-embed.js";
export type { AppEmbedAttachOptions, AppEmbedHandle, AppEmbedShell } from "./app-embed.js";
export type { AppNavigationCall, AppNavigationLaunch, AppNavigationOpenMessage, AppNavigationOpenResponse, AppNavigationTarget } from "@cohub/protocol/app-navigation";
export { createAppBridgeCore } from "./app-bridge-core.js";
export type { AppBridgeAuthorizationContext, AppBridgeCore, AppBridgeCoreConfig, AppBridgeCoreApp, AppBridgeDialogState, AppBridgeDiagnostic, AppAuthorizeRequest, AppCheckoutStarted, AppPurchaseRequest, AppBridgeGetAccessToken, AppBridgeGetViewerUuid, AppBridgeRequestSignIn, AppPromotionAttributionContext } from "./app-bridge-core.js";
export { normalizeSpacePickerQuery, orderSpacePickerItems, filterSpacePickerItems, selectSpacePickerItems } from "./space-picker.js";
export type { SpacePickerFilter, SpacePickerItem, SpacePickerOptions } from "./space-picker.js";
export { clearGrantedAppScopes, hasGrantedAppScopes, setGrantedAppScopes } from "./app-grant-cache.js";
export { SessionPatchReducer, createSessionPatchReducer } from "./session-patch-reducer.js";
export {
  SessionGenerationStreamClient,
  createSessionGenerationStreamClient,
  parseAssistantMessageCommit,
} from "./session-generation-stream.js";
export {
  BILLING_ACCESS_BLOCKED_ERROR_CODE,
  FEATURE_NOT_ENTITLED_ERROR_CODE,
  extractBillingPayload,
  isBillingAccessBlockedCode,
  isBillingAccessBlockedError,
  isFeatureNotEntitledError,
  isHttpErrorCode,
} from "./http-error.js";
export { HttpError, joinApiUrl, matchesUnauthorizedErrorToken, sanitizeAccessToken } from "./transport.js";
export {
  COHUB_SOURCE_HEADER,
  COHUB_SOURCE_HEADER_NAMES,
  hasRequestSourceIdentity,
  isRequestSourceClientId,
  isRequestSourceEmpty,
  isRequestSourceUuid,
  mergeRequestSourceIntoMeta,
  normalizeRequestSource,
  parseRequestSourceFromHeaders,
  readRequestSourceFromEnv,
  REQUEST_SOURCE_VIA_MAX_LENGTH,
  requestSourceToHeaders,
  resolveRequestSourceChannel,
} from "@cohub/protocol/provenance";
export type { RequestSource, RequestSourceVia } from "@cohub/protocol/provenance";
export {
  GenerationPolicyError,
  assertGenerationRequestAllowedByPolicy,
  decodeGenerationPolicy,
  encodeGenerationPolicy,
  filterDiscoverableGenerationModels,
  filterGenerationDeclarationsByPolicy,
  findGenerationModelPolicy,
  getAllowedGenerationModelIds,
  isGenerationModelHidden,
  normalizeGenerationPolicy,
  parseGenerationPolicyFromEnv,
} from "@cohub/protocol/generation";
export type {
  GenerationModelPolicy,
  GenerationModelVisibility,
  GenerationParameterConstraint,
  GenerationPolicy,
  GenerationUsageBilling,
} from "@cohub/protocol/generation";
export type { RawHttpResponse } from "./transport.js";
export {
  COHUB_ENVIRONMENTS,
  getCohubContext,
  normalizeBaseUrl,
  normalizeVoiceInputWebsocketUrl,
  normalizeWebsocketUrl,
  resolveApiBaseUrl,
  resolveCohubEnvironment,
  resolveExecutionAppId,
  resolveExecutionToken,
  resolveVoiceInputWebsocketUrl,
  resolveWebsocketUrl,
} from "./environment.js";
export type { CohubClientOptions, Fetch, HttpTraceContext, UnauthorizedContext } from "./transport.js";
export type { CohubContext, CohubEnvironment, CohubExecutionContext, CohubRuntimeKind } from "./environment.js";
export type { TaskWaitOptions } from "./apis/tasks.js";
export type {
  VoiceInputCallbacks,
  VoiceInputClientOptions,
  VoiceInputCreateOptions,
  VoiceInputEvent,
} from "./voice-input.js";
export type {
  SessionPatchApplyInput,
  SessionPatchApplyResult,
  SessionPatchState,
  SessionPatchStatus,
} from "./session-patch-reducer.js";
export type {
  AssistantMessageCommit,
  GenerationStreamCommitEvent,
  GenerationStreamErrorEvent,
  GenerationStreamEvent,
  GenerationStreamFinalizedEvent,
  GenerationStreamIntermediateMessage,
  GenerationStreamLifecycleEvent,
  GenerationStreamOutOfSyncEvent,
  GenerationStreamStateEvent,
  GenerationStreamSubscribeOptions,
  GenerationStreamSubscriptionHandlers,
  GenerationStreamTurnUpdatedEvent,
} from "./session-generation-stream.js";
export * from "./types.js";
export type {
  BoardAwarenessGesture,
  BoardAwarenessNodePreview,
  BoardAwarenessStateUpdate,
  BoardAwarenessUpdate,
  ChannelEnvelope,
  LabelAssignmentsUpdatedEvent,
  RealtimeServerEvent,
} from "@cohub/protocol/realtime";
export type {
  RealtimeAppRecord,
  RealtimeAppVersionRecord,
  AppVersionPublishedEvent,
} from "@cohub/protocol/realtime";
export type {
  BoardAwarenessUpdatedEvent,
  BoardChangedEvent,
  BoardEventName,
  BoardPlaybackChangedEvent,
  BoardSubscriptionHandlers,
  SessionEventName,
  SessionSubscriptionHandlers,
  SpaceChannelBindingRecord,
  SpaceEventName,
  SpaceTurnListOptions,
  WebSocketConnectionState,
} from "./apis/spaces.js";
export type {
  RealtimeRoomDescriptor,
  RealtimeRoomEvent,
  RealtimeRoomMember,
} from "@cohub/protocol/realtime";
export type {
  AppRoomAdmissionResponse,
  AppRoomCreateInput,
  AppRoomEvent,
  AppRoomEventMap,
  AppRoomPublishResult,
  AppRoomState,
} from "./apis/app-realtime.js";
export {
  BoardClient,
  SpacePublicFilesApi,
  SpaceWebhooksApi,
} from "./apis/spaces.js";
export type { SpaceWebhookListItem, SpaceWebhookTriggerResponse } from "@cohub/protocol";
export {
  BOARD_COLOR_IDS,
  BOARD_GEO_KINDS,
} from "@cohub/protocol";
export type {
  BoardColorId,
  BoardGeoKind,
} from "@cohub/protocol";
export {
  BOARD_ANIMATION_CHANNEL_CAPABILITIES,
  BoardAnimationSpecSchema,
  BoardAuthoringItemSchema,
  BoardCompositionInputSchema,
  BoardCompositionSchema,
  BoardDealParamsSchema,
  BoardEffectInputSchema,
  BoardEffectSchema,
  BoardItemPatchSchema,
  BoardSemanticCommandSchema,
  parseBoardEffectInput,
  BoardPlaybackPolicySchema,
  parseBoardCompositionInput,
  parseBoardPlaybackPolicy,
} from "@cohub/protocol";
export * from "./board/animation.js";
export type { CreatePublicAssetUploadInput, CreatePublicAssetUploadResponse, PublicAssetMimeType, PublicAssetPurpose, PublicAssetUploadProgress, PublicAssetUploadProtocol, UploadAppSourceInput, UploadChatAttachmentInput, UploadChatImageAttachmentInput, UploadPublicAssetInput } from "./apis/public-assets.js";
export type { AppActionRunResponse, AppAuthorizeResponse, AppContent, AppContentDownload, AppCreateInput, AppDetailResponse, AppExtractedPageMeta, AppGetResponse, AppMeta, AppPresentationMeta, AppPromotionCreateInput, AppPromotionEventResponse, AppPromotionProvider, AppPromotionProviderStatus, AppPromotionRecord, AppPromotionStatsResponse, AppPublicOwnerRecord, AppPublicSpaceRecord, AppRecord, AppResolveResponse, AppSessionResponse, AppStatus, AppTargetType, AppUpdateInput, AppVersionRecord, AppViewerGrantRecord, AppViewSource, AppViewStatsResponse, AppVisibility, PublicAppVersionSummary } from "./apis/apps.js";
export type {
  PublicFileCreateUploadInput,
  PublicFileCreateUploadResponse,
  PublicFileListEntry,
  PublicFileListResponse,
  PublicFileUploadEntryInput,
  PublicFileUploadPlanEntry,
  PublicFileUrlResponse,
  AppArtifactDescriptor,
  AppArtifactDownloadDescriptor,
  AppArtifactManifest,
  AppArtifactManifestFile,
  AppBoardArtifactManifest,
  AppBoardAsset,
  AppContentKind,
  AppVersionSource,
} from "@cohub/protocol";
export {
  isTerminalDesktopCommandStatus,
  isDesktopCallMethod,
  parseDesktopCommand,
  resolveOpenSurface,
  DESKTOP_COMMAND_DEFAULT_TIMEOUT_MS,
  DESKTOP_COMMAND_MAX_TIMEOUT_MS,
  DESKTOP_COMMAND_PAYLOAD_MAX_BYTES,
  DESKTOP_COMMAND_PENDING_TTL_SECONDS,
  DESKTOP_COMMAND_SETTLEMENT_GRACE_SECONDS,
  DESKTOP_COMMAND_TERMINAL_TTL_SECONDS,
  DESKTOP_COMMAND_VERSION,
} from "@cohub/protocol/desktop-command";
export type {
  DesktopCommand,
  DesktopCommandDispatchedPayload,
  DesktopCommandError,
  DesktopFileTarget,
  DesktopCommandRecord,
  DesktopCommandStatus,
  DesktopOpenCommand,
  DesktopSurface,
  DesktopTarget,
  DesktopAppTarget,
  DesktopCall,
} from "@cohub/protocol/desktop-command";
export {
  buildAppSurfaceRequest,
  parseAppSurfaceReady,
  parseAppSurfaceResponse,
  APP_COMPOSER_CHIP_CONTENT_MAX_BYTES,
  APP_COMPOSER_CHIP_KEY_MAX_LENGTH,
  APP_COMPOSER_CHIP_LABEL_MAX_LENGTH,
  APP_SURFACE_READY_TIMEOUT_MS,
  APP_SURFACE_REQUEST_TIMEOUT_MS,
} from "@cohub/protocol/app-surface";
export type {
  AppComposerChip,
  AppSurfaceReadyMessage,
  AppSurfaceResponseMessage,
} from "@cohub/protocol/app-surface";
export type { AppCommerceCheckoutStatus, AppCommerceCreditConsumeResponse, AppCommerceCreditConsumeStatus, AppCommerceEntitlement, AppCommerceEntitlementsResponse, AppCommerceOrder, AppCommerceProductResolveResponse, AppCommercePurchaseResponse } from "./apis/app-commerce.js";
export type { AppRuntimeCheckoutState, AppRuntimeCheckoutStatus, AppRuntimeContext } from "./app-runtime.js";

// ── Legacy aliases ────────────────────────────────────────────────────────────
// The work-era names stay exported so existing SDK consumers keep compiling.
// Wire payloads are unchanged; only the names are deprecated. These aliases
// are removed in the next breaking SDK version.

// Classes and functions: deprecated aliases are defined next to their
// canonical implementations.
export { WorkCommerceApi } from "./apis/app-commerce.js";
export { WorkRealtimeApi, WorkRoom } from "./apis/app-realtime.js";
export { UiCommandsApi } from "./apis/desktop-commands.js";
export { WorkSurfaceApi } from "./app-surface.js";
export {
  AppRuntimeApi as WorkRuntimeApi,
  createAppRuntime as createWorkRuntime,
  resolveAppTransport as resolveWorkTransport,
  createSlugAppIdResolver as createSlugWorkIdResolver,
} from "./app-runtime.js";
export { createAppBridgeCore as createWorkBridgeCore } from "./app-bridge-core.js";
export {
  parseWorkRef,
  formatWorkRef,
  isWorkId,
  WorkRefParseError,
} from "./app-ref.js";

// Types: deprecated aliases defined beside the canonical shapes.
export type {
  ParsedWorkRef,
  WorkPublicRef,
} from "./app-ref.js";
export type {
  WorkAuthorizeResponse,
  WorkContent,
  WorkContentDownload,
  WorkCreateInput,
  WorkDetailResponse,
  WorkExtractedPageMeta,
  WorkGetResponse,
  WorkMeta,
  WorkPresentationMeta,
  WorkPromotionCreateInput,
  WorkPromotionEventResponse,
  WorkPromotionProvider,
  WorkPromotionProviderStatus,
  WorkPromotionRecord,
  WorkPromotionStatsResponse,
  WorkPublicOwnerRecord,
  WorkPublicSpaceRecord,
  WorkRecord,
  WorkResolveResponse,
  WorkSessionResponse,
  WorkStatus,
  WorkTargetType,
  WorkUpdateInput,
  WorkVersionRecord,
  WorkViewSource,
  WorkViewStatsResponse,
  WorkVisibility,
} from "./apis/apps.js";
export type {
  WorkCommerceCheckoutStatus,
  WorkCommerceCreditConsumeResponse,
  WorkCommerceCreditConsumeStatus,
  WorkCommerceEntitlement,
  WorkCommerceEntitlementsResponse,
  WorkCommerceOrder,
  WorkCommerceProductResolveResponse,
  WorkCommercePurchaseResponse,
} from "./apis/app-commerce.js";
export type {
  CreateUiCommandInput,
  WaitForUiCommandOptions,
  UiCommand,
  UiCommandError,
  UiCommandRecord,
  UiCommandStatus,
} from "./apis/desktop-commands.js";
export type {
  WorkRoomAdmissionResponse,
  WorkRoomCreateInput,
  WorkRoomEvent,
  WorkRoomEventMap,
  WorkRoomPublishResult,
  WorkRoomState,
} from "./apis/app-realtime.js";
export type {
  AppBridgeAuthorizationContext as WorkBridgeAuthorizationContext,
  AppBridgeCore as WorkBridgeCore,
  AppBridgeCoreConfig as WorkBridgeCoreConfig,
  AppBridgeCoreApp as WorkBridgeCoreWork,
  AppBridgeDialogState as WorkBridgeDialogState,
  AppAuthorizeRequest as WorkAuthorizeRequest,
  AppCheckoutStarted as WorkCheckoutStarted,
  AppPurchaseRequest as WorkPurchaseRequest,
  AppBridgeGetAccessToken as WorkBridgeGetAccessToken,
  AppBridgeGetViewerUuid as WorkBridgeGetViewerUuid,
  AppBridgeRequestSignIn as WorkBridgeRequestSignIn,
  AppPromotionAttributionContext as WorkPromotionAttributionContext,
} from "./app-bridge-core.js";
export type {
  AppIdResolver as WorkIdResolver,
  AppRuntimeInvocationContext as WorkRuntimeInvocationContext,
  AppRuntimeModeConfig as WorkRuntimeModeConfig,
  AppRuntimeRequestOptions as WorkRuntimeRequestOptions,
  AppRuntimeTransport as WorkRuntimeTransport,
  AppRuntimeCheckoutState as WorkRuntimeCheckoutState,
  AppRuntimeCheckoutStatus as WorkRuntimeCheckoutStatus,
  AppRuntimeContext as WorkRuntimeContext,
} from "./app-runtime.js";
export type { AppSurfaceHandler as WorkSurfaceHandler, AppSurfaceHandlerContext as WorkSurfaceHandlerContext } from "./app-surface.js";
export type {
  RealtimeAppRecord as RealtimeWorkRecord,
  RealtimeAppVersionRecord as RealtimeWorkVersionRecord,
  AppVersionPublishedEvent as WorkVersionPublishedEvent,
} from "@cohub/protocol/realtime";
export type {
  AppArtifactDescriptor as WorkArtifactDescriptor,
  AppArtifactDownloadDescriptor as WorkArtifactDownloadDescriptor,
  AppArtifactManifest as WorkArtifactManifest,
  AppArtifactManifestFile as WorkArtifactManifestFile,
  AppBoardArtifactManifest as WorkBoardArtifactManifest,
  AppBoardAsset as WorkBoardAsset,
  AppContentKind as WorkContentKind,
} from "@cohub/protocol";
export type { PublicUserWorkItem } from "./types.js";
