import { createLogger } from "@cohub/infra/logging";
import * as Lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ContentBlock } from "@cohub/protocol/core";
import type { FeishuChannelConfig, GatewayInboundEvent, GatewayMediaItem } from "@cohub/protocol/gateway";
import type { PlannedGatewayOutboundCommand } from "@cohub/protocol/gateway";
import { UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import type { GatewayProvider } from "../base.js";
import { resolveChannelCommand } from "../../channel-commands.js";
import { publishInboundEvent, } from "../../bus.js";
import { getSpaceChannelConfig, getTurnMessageExternalRef, setTurnMessageExternalRef } from "../../redis.js";
import { buildFeishuDeliveryPlan } from "../../session-output-planner.js";
import {
  resolveReceiveIdType,
  buildFeishuBindingKey,
  filterFeishuProviderEvent,
  resolveFeishuMessageRelations,
} from "./utils.js";
import { parseFeishuMessageContent, type FeishuParsedMessageBlock } from "./parse.js";
import {
  FEISHU_INBOUND_IMAGE_MAX_BYTES,
  FEISHU_INBOUND_IMAGE_MAX_COUNT,
  readFeishuResourceBuffer,
} from "./media.js";
import { safeFetch } from "../../media/safe-fetch.js";
import { base64ToTempMediaFile, responseToTempMediaFile } from "../../media/temp-media-file.js";
import {
  ensureImageMediaType,
  ingestInboundMedia,
  type InboundDownloadedImage,
} from "../../media/inbound-attachments.js";
import { imageExtensionFromMimeType, sanitizeFilename } from "../../media/mime.js";
import {
  markChannelDegraded,
  markChannelError,
  markChannelReady
} from "../../channel-health.js";

const logger = createLogger({ serviceName: "cohub-gateway" });
const FEISHU_OUTBOUND_FILE_MAX_BYTES = UPLOAD_MAX_FILE_BYTES;
const LARGE_MEDIA_TIMEOUT_MS = 10 * 60 * 1000;
// Detect image MIME type from magic bytes (first 4 bytes)
function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "image/gif";
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return "image/webp";
  return null;
}

// Provider-level dedup for WS reconnect duplicate delivery
const messageDedup = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10000;
const FEISHU_DOC_URL_RE = /https?:\/\/[^\s<>'"]+\/(?:docx|wiki|docs)\/[A-Za-z0-9]+/g;
const FEISHU_DOC_MAX_PER_MESSAGE = 3;
const FEISHU_DOC_MAX_CHARS = 12_000;
const FEISHU_DOC_FETCH_TIMEOUT_MS = 10_000;
const FEISHU_WIKI_CHILD_MAX_COUNT = 5;
const FEISHU_WIKI_CHILD_MAX_CHARS = 4_000;
const FEISHU_TYPING_REACTION_EMOJI_TYPE = "Typing";

type FeishuDocumentRef = {
  url: string;
  type: "docx" | "wiki" | "docs";
  token: string;
};

type ResolvedFeishuDocumentRef = FeishuDocumentRef & {
  type: "docx";
  wiki?: {
    spaceId?: string;
    nodeToken?: string;
    title?: string;
    hasChild?: boolean;
  };
};

function dedupAndPurge(eventId: string): boolean {
  if (messageDedup.has(eventId)) return false;
  messageDedup.set(eventId, Date.now());
  if (messageDedup.size > DEDUP_MAX_ENTRIES) {
    const now = Date.now();
    for (const [id, ts] of messageDedup) {
      if (now - ts > DEDUP_TTL_MS) messageDedup.delete(id);
    }
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function cleanUrlCandidate(value: string) {
  return value.replace(/[),.。;；:：!！?？\]}]+$/g, "");
}

function getTextFromContentBlocks(blocks: ContentBlock[]) {
  return blocks
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function buildFeishuSourceChannel(input: {
  isDm: boolean;
  senderName?: string | null;
  senderId: string;
  chatName?: string | null;
  fallbackId: string;
}) {
  if (input.isDm) {
    return `feishu:dm:${input.senderName ?? input.senderId}`;
  }
  if (input.chatName) {
    return `feishu:group:${input.chatName}`;
  }
  return `feishu:${input.fallbackId}`;
}

function parseFeishuDocumentUrl(value: string): FeishuDocumentRef | null {
  let url: URL;
  try {
    url = new URL(cleanUrlCandidate(value));
  } catch {
    return null;
  }

  if (!/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/(docx|wiki|docs)\/([A-Za-z0-9]+)/);
  if (!match?.[1] || !match[2]) return null;
  const type = match[1] as "docx" | "wiki" | "docs";
  const token = match[2];
  return { url: `${url.origin}/${type}/${token}`, type, token };
}

export class FeishuProvider implements GatewayProvider {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private dispatcher: Lark.EventDispatcher;
  private channelId: string;
  private appId: string;
  private botOpenId?: string;
  private typingReactions = new Map<string, string>();

  constructor(
    channelId: string,
    credentials: { appId: string; appSecret: string; brand?: "feishu" | "lark" },
  ) {
    this.channelId = channelId;
    this.appId = credentials.appId;
    const domain = credentials.brand === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

    logger.info(`[Feishu:${channelId}] Creating Feishu client (domain=${domain})`);

    this.client = new Lark.Client({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    });

    this.dispatcher = new Lark.EventDispatcher({
      encryptKey: "",
      verificationToken: "",
    });

    this.wsClient = new Lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.setupListeners();

    logger.info(`[Feishu:${channelId}] Starting WebSocket connection...`);
    this.wsClient.start({ eventDispatcher: this.dispatcher }).catch((err) => {
      logger.error(`[Feishu:${channelId}] WS start failed:`, err);
      void markChannelError(channelId, err).catch(() => undefined);
    });

    // Probe bot identity
    this.probeBot();
  }

  private async probeBot() {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Lark SDK request method is not publicly typed
      const res = await (this.client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      if (res.code === 0 && res.bot?.open_id) {
        this.botOpenId = res.bot.open_id;
        logger.info(`[Feishu:${this.channelId}] ✓ Bot open_id: ${this.botOpenId}`);
        void markChannelReady(this.channelId, {
          meta: {
            botOpenId: this.botOpenId,
          },
        }).catch(() => undefined);
      } else {
        const detail = JSON.stringify(res).slice(0, 200);
        logger.warn(`[Feishu:${this.channelId}] Probe bot returned no open_id:`, detail);
        void markChannelDegraded(this.channelId, detail || "Feishu bot probe failed").catch(() => undefined);
      }
    } catch (err) {
      logger.error(`[Feishu:${this.channelId}] Probe bot failed:`, err);
      void markChannelDegraded(this.channelId, err).catch(() => undefined);
    }
  }

  private setupListeners() {
    this.dispatcher.register({
      "im.message.receive_v1": (data: unknown) => {
        this.handleMessageEvent(data).catch((err) => {
          logger.error(`[Feishu:${this.channelId}] Handle message error:`, err);
        });
      },
    });
  }

  private async handleMessageEvent(data: unknown) {
    const event = data as {
      event_id?: string;
      app_id?: string;
      sender?: { sender_id: { open_id?: string; user_id?: string } };
      message?: {
        message_id: string;
        chat_id: string;
        chat_type: "p2p" | "group";
        message_type: string;
        content: string;
        thread_id?: string;
        root_id?: string;
        parent_id?: string;
        create_time?: string;
        mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
      };
    };

    const eventId = event.event_id;
    if (!eventId) return;

    // App ownership check
    if (event.app_id && event.app_id !== this.appId) {
      return;
    }

    // Dedup
    if (!dedupAndPurge(eventId)) {
      logger.info(`[Feishu:${this.channelId}] Duplicate event ${eventId.slice(0, 8)}, skipping`);
      return;
    }

    const msg = event.message;
    if (!msg) return;

    // Expired message filter (5 min)
    if (msg.create_time) {
      const age = Date.now() - Number.parseInt(msg.create_time, 10) * 1000;
      if (age > 5 * 60 * 1000) {
        logger.info(`[Feishu:${this.channelId}] Expired message ${msg.message_id}, skipping`);
        return;
      }
    }

    const isDm = msg.chat_type === "p2p";

    // Group: skip if bot not mentioned (config-controlled)
    if (!isDm) {
      const config = await getSpaceChannelConfig<FeishuChannelConfig>(this.channelId);
      const requireMention = config?.inbound?.requireMentionInGroup ?? true;
      if (requireMention && this.botOpenId) {
        const hasMention = msg.mentions?.some((m) => m.id.open_id === this.botOpenId) ?? false;
        if (!hasMention) {
          logger.info(`[Feishu:${this.channelId}] Bot not mentioned in group ${msg.chat_id}, skipping`);
          return;
        }
      }
    }

    await this.addTypingReaction(msg.message_id);

    const parsedContent = parseFeishuMessageContent(msg);
    const textOnlyBlocks = parsedContent.blocks.map((block) => ({ type: "text", text: block.type === "text" ? block.text : block.fallbackText }) satisfies ContentBlock);
    const channelCommand = resolveChannelCommand(getTextFromContentBlocks(textOnlyBlocks), {
      leadingPrefixes: msg.mentions?.flatMap((mention) => [
        mention.key,
        mention.name ? `@${mention.name}` : "",
      ]) ?? [],
    });

    const {
      conversationThreadId,
      parentMessageId,
      rootMessageId,
      threadId,
    } = resolveFeishuMessageRelations(msg);
    const bindingKey = buildFeishuBindingKey(msg.chat_id, conversationThreadId);
    const senderId = event.sender?.sender_id?.open_id ?? "";
    const sourceChannel = buildFeishuSourceChannel({
      isDm,
      senderId,
      senderName: null,
      chatName: null,
      fallbackId: msg.chat_id,
    });

    const inboundEventBase = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      channelId: this.channelId,
      provider: "feishu" as const,
      externalChatId: msg.chat_id,
      externalMessageId: msg.message_id,
      bindingKey,
      binding: {
        key: bindingKey,
        parentKey: conversationThreadId ? buildFeishuBindingKey(msg.chat_id, null) : null,
      },
      conversation: {
        id: msg.chat_id,
        parentId: conversationThreadId ?? undefined,
        meta: {
          chatType: msg.chat_type,
          isDm,
          threadId: conversationThreadId,
          sourceChannel,
        },
      },
      message: {
        parentMessageId: parentMessageId ?? undefined,
        meta: {
          rootId: rootMessageId,
          threadId,
          messageType: msg.message_type,
        },
      },
      sender: {
        id: senderId,
        name: "", // Enriched later if needed
      },
      content: [] as ContentBlock[],
      providerEvent: filterFeishuProviderEvent(data),
      meta: {
        chatType: msg.chat_type,
        isDm,
        threadId,
        mentions: msg.mentions?.map((m) => ({ key: m.key, openId: m.id.open_id, name: m.name })) ?? null,
        sourceChannel,
      },
    };
    const draftEvent = channelCommand
      ? { ...inboundEventBase, eventType: "channel_command" as const, command: channelCommand }
      : { ...inboundEventBase, eventType: "message_create" as const };
    const contentBlocks = parsedContent.resources.length > 0
      ? await this.resolveParsedBlocks(parsedContent.blocks, msg.message_id, FEISHU_INBOUND_IMAGE_MAX_COUNT, draftEvent)
      : textOnlyBlocks;
    const enrichedContentBlocks = await this.expandFeishuDocumentLinks(contentBlocks);
    const inboundEvent: GatewayInboundEvent = {
      ...draftEvent,
      content: enrichedContentBlocks,
    };

    if (channelCommand) {
      logger.info(`[Feishu:${this.channelId}] → Inbound command: ${channelCommand.name} message=${msg.message_id}`);
      await publishInboundEvent(inboundEvent);
      return;
    }

    logger.info(
      `[Feishu:${this.channelId}] → Inbound: ${inboundEvent.externalMessageId.slice(0, 8)} chat=${msg.chat_id} type=${msg.chat_type}${threadId ? ` thread=${threadId}` : ""}`,
    );
    await publishInboundEvent(inboundEvent);
  }

  private async addTypingReaction(messageId: string) {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: {
            emoji_type: FEISHU_TYPING_REACTION_EMOJI_TYPE,
          },
        },
      });
      const reactionId = res.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(messageId, reactionId);
        logger.info(`[Feishu:${this.channelId}] ✓ Typing reaction added: ${messageId}`);
      }
    } catch (err) {
      logger.debug(`[Feishu:${this.channelId}] Failed to add typing reaction:`, err instanceof Error ? err.message : String(err));
    }
  }

  private async removeTypingReaction(messageId: string | null | undefined) {
    if (!messageId) return;
    const reactionId = this.typingReactions.get(messageId);
    if (!reactionId) return;
    this.typingReactions.delete(messageId);

    try {
      await this.client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
      logger.info(`[Feishu:${this.channelId}] ✓ Typing reaction removed: ${messageId}`);
    } catch (err) {
      logger.debug(`[Feishu:${this.channelId}] Failed to remove typing reaction:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Upload an image to Feishu and return the image_key.
  // Supports base64 and URL sources.
  private async uploadImage(
    imageSource: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string },
  ): Promise<string | null> {
    try {
      let buffer: Buffer;
      let fileName: string;

      if (imageSource.type === "base64") {
        buffer = Buffer.from(imageSource.data, "base64");
        const ext = imageSource.media_type.split("/")[1] ?? "png";
        fileName = `image.${ext}`;
      } else {
        // Fetch from URL
        const res = await fetch(imageSource.url);
        if (!res.ok) {
          logger.warn(`[Feishu:${this.channelId}] Failed to fetch image URL: ${imageSource.url} (${res.status})`);
          return null;
        }
        buffer = Buffer.from(await res.arrayBuffer());
        fileName = "image";
      }

      // biome-ignore lint/suspicious/noExplicitAny: Lark SDK upload API is not fully typed
      const uploadResult = await (this.client as any).request({
        method: "POST",
        url: "/open-apis/im/v1/images",
        data: {
          image_type: "message",
        },
        formData: {
          image: {
            value: buffer,
            options: { filename: fileName },
          },
        },
      });

      if (uploadResult.code === 0 && uploadResult.data?.image_key) {
        return uploadResult.data.image_key as string;
      }
      logger.warn(`[Feishu:${this.channelId}] Image upload failed:`, JSON.stringify(uploadResult).slice(0, 200));
      return null;
    } catch (err) {
      logger.warn(`[Feishu:${this.channelId}] Image upload error:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async uploadFile(item: GatewayMediaItem): Promise<{ fileKey: string; msgType: "file" | "audio" | "media" } | null> {
    let file: Awaited<ReturnType<typeof responseToTempMediaFile>> | null = null;
    try {
      let fileName = item.filename || "cohub-file";
      if (item.source.type === "base64") {
        file = await base64ToTempMediaFile(item.source.data, FEISHU_OUTBOUND_FILE_MAX_BYTES, "feishu-outbound-base64");
        const ext = item.source.media_type.split("/")[1] || "bin";
        if (!item.filename) fileName = `cohub-file.${ext}`;
      } else {
        const response = await safeFetch({
          url: item.source.url,
          label: "feishu outbound media",
          timeoutMs: LARGE_MEDIA_TIMEOUT_MS,
        });
        if (!response.ok) {
          logger.warn(`[Feishu:${this.channelId}] Failed to fetch media URL: ${item.source.url} (${response.status})`);
          return null;
        }
        file = await responseToTempMediaFile(response, FEISHU_OUTBOUND_FILE_MAX_BYTES, "feishu-outbound-media");
      }
      if (file.size === 0) return null;

      const fileType = item.kind === "video" ? "mp4" : item.kind === "voice" ? "opus" : "stream";
      const msgType = item.kind === "video" ? "media" : item.kind === "voice" ? "audio" : "file";
      // biome-ignore lint/suspicious/noExplicitAny: Lark SDK upload API is not fully typed
      const uploadResult = await (this.client as any).request({
        method: "POST",
        url: "/open-apis/im/v1/files",
        data: { file_type: fileType, file_name: fileName },
        formData: {
          file: {
            value: createReadStream(file.path),
            options: { filename: fileName, contentType: item.mediaType, knownLength: file.size },
          },
        },
      });

      if (uploadResult.code === 0 && uploadResult.data?.file_key) {
        return { fileKey: uploadResult.data.file_key as string, msgType };
      }
      logger.warn(`[Feishu:${this.channelId}] File upload failed:`, JSON.stringify(uploadResult).slice(0, 200));
      return null;
    } catch (err) {
      logger.warn(`[Feishu:${this.channelId}] File upload error:`, err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      await file?.cleanup();
    }
  }

  private async downloadInboundImage(imageKey: string, messageId: string): Promise<{ buffer: Buffer; mediaType: string } | null> {
    try {
      const res = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: "image" },
      });
      const buffer = await readFeishuResourceBuffer(res, { maxBytes: FEISHU_INBOUND_IMAGE_MAX_BYTES });
      if (!buffer || buffer.length === 0) {
        logger.warn(`[Feishu:${this.channelId}] Image download returned empty: ${imageKey}`);
        return null;
      }
      return {
        buffer,
        mediaType: ensureImageMediaType(buffer, detectMimeType(buffer) ?? "image/png"),
      };
    } catch (err) {
      logger.warn(`[Feishu:${this.channelId}] Failed to download image ${imageKey}:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async resolveParsedBlocks(
    blocks: FeishuParsedMessageBlock[],
    messageId: string,
    maxResources: number,
    eventBase: Omit<GatewayInboundEvent, "eventType" | "command" | "content"> & { eventType?: GatewayInboundEvent["eventType"]; command?: GatewayInboundEvent["command"] },
  ): Promise<ContentBlock[]> {
    type PendingImage = { slot: number; image: InboundDownloadedImage };
    const resolved: Array<ContentBlock | null> = [];
    const pendingImages: PendingImage[] = [];
    let resourceCount = 0;

    for (const block of blocks) {
      if (block.type === "text") {
        resolved.push({ type: "text", text: block.text });
        continue;
      }

      resourceCount += 1;
      if (resourceCount > maxResources) {
        resolved.push({ type: "text", text: `[image: ${block.resource.fileKey} skipped: too many images]` });
        continue;
      }

      if (block.resource.type !== "image") {
        resolved.push({ type: "text", text: block.fallbackText });
        continue;
      }

      const downloaded = await this.downloadInboundImage(block.resource.fileKey, messageId);
      if (!downloaded) {
        resolved.push({ type: "text", text: block.fallbackText, _meta: { source: "feishu", imageKey: block.resource.fileKey, reason: "download_failed" } });
        continue;
      }

      const image: InboundDownloadedImage = {
        id: `image-${pendingImages.length}`,
        buffer: downloaded.buffer,
        mediaType: downloaded.mediaType,
        filename: sanitizeFilename(`feishu-image-${pendingImages.length + 1}.${imageExtensionFromMimeType(downloaded.mediaType)}`),
        originalUrl: block.resource.fileKey,
      };
      pendingImages.push({ slot: resolved.length, image });
      resolved.push(null); // placeholder preserves original order
    }

    const trailing: ContentBlock[] = [];
    if (pendingImages.length > 0) {
      const event = {
        ...eventBase,
        eventType: eventBase.eventType ?? "message_create",
        content: resolved.filter((block): block is ContentBlock => block !== null),
      } as GatewayInboundEvent;
      const ingested = await ingestInboundMedia({
        event,
        source: "feishu",
        images: pendingImages.map((item) => item.image),
        label: `feishu:${this.channelId}`,
      });

      for (const item of pendingImages) {
        const imageBlock = ingested.imageBlocksById[item.image.id];
        resolved[item.slot] = imageBlock ?? {
          type: "text",
          text: "[Image upload failed]",
          _meta: { source: "feishu", originalUrl: item.image.originalUrl ?? null, reason: "upload_failed" },
        };
      }

      // Keep attachment reference text after ordered content (Images: and Files:).
      // Files: matters when durable image specialization demotes to sandbox path.
      for (const block of ingested.blocks) {
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          (block.text.startsWith("Images:") || block.text.startsWith("Files:"))
        ) {
          trailing.push(block);
        }
      }
    }

    return [...resolved.filter((block): block is ContentBlock => block !== null), ...trailing];
  }

  private findDocumentRefs(blocks: ContentBlock[]): FeishuDocumentRef[] {
    const refs: FeishuDocumentRef[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
      if (block.type !== "text") continue;
      for (const match of block.text.matchAll(FEISHU_DOC_URL_RE)) {
        const ref = parseFeishuDocumentUrl(match[0]);
        if (!ref || seen.has(ref.url)) continue;
        seen.add(ref.url);
        refs.push(ref);
        if (refs.length >= FEISHU_DOC_MAX_PER_MESSAGE) return refs;
      }
    }

    return refs;
  }

  private async resolveDocumentRef(ref: FeishuDocumentRef): Promise<ResolvedFeishuDocumentRef> {
    if (ref.type === "docx") return { ...ref, type: "docx" };
    if (ref.type === "docs") throw new Error("legacy /docs/ URLs are not supported");

    const res = await this.client.wiki.space.getNode({
      params: { token: ref.token },
    });
    if (res.code && res.code !== 0) throw new Error(res.msg ?? `Feishu wiki get_node failed with code ${res.code}`);
    const node = res.data?.node;
    const objToken = node?.obj_token;
    const objType = node?.obj_type;
    if (!objToken) throw new Error("failed to resolve wiki token");
    if (objType !== "docx") throw new Error(`wiki object type ${objType || "unknown"} is not supported`);
    return {
      ...ref,
      type: "docx",
      token: objToken,
      wiki: {
        spaceId: node?.space_id,
        nodeToken: node?.node_token,
        title: node?.title,
        hasChild: node?.has_child,
      },
    };
  }

  private async fetchDocxRawContent(documentId: string): Promise<string> {
    const res = await this.client.docx.document.rawContent({
      path: { document_id: documentId },
    });
    if (res.code && res.code !== 0) throw new Error(res.msg ?? `Feishu docx raw_content failed with code ${res.code}`);
    return res.data?.content ?? "";
  }

  private appendBoundedSection(sections: string[], heading: string, content: string, remainingChars: number): number {
    if (remainingChars <= 0) return 0;

    const normalized = content || "[empty document]";
    const sectionPrefix = `${heading}\n`;
    const available = Math.max(0, remainingChars - sectionPrefix.length);
    if (available <= 0) return 0;

    const page = normalized.slice(0, available);
    const more = normalized.length > page.length
      ? `\n\n[Truncated: showing ${page.length} of ${normalized.length} characters.]`
      : "";
    const section = `${sectionPrefix}${page}${more}`;
    sections.push(section);
    return section.length;
  }

  private async fetchWikiChildSections(ref: ResolvedFeishuDocumentRef, remainingChars: number): Promise<string[]> {
    const spaceId = ref.wiki?.spaceId;
    const parentNodeToken = ref.wiki?.nodeToken;
    if (!spaceId || !parentNodeToken || !ref.wiki?.hasChild || remainingChars <= 0) return [];

    const res = await this.client.wiki.spaceNode.list({
      path: { space_id: spaceId },
      params: {
        parent_node_token: parentNodeToken,
        page_size: FEISHU_WIKI_CHILD_MAX_COUNT,
      },
    });
    if (res.code && res.code !== 0) throw new Error(res.msg ?? `Feishu wiki spaceNode list failed with code ${res.code}`);

    const sections: string[] = [];
    let remaining = remainingChars;
    const children = res.data?.items ?? [];
    for (const child of children.slice(0, FEISHU_WIKI_CHILD_MAX_COUNT)) {
      const title = child.title || child.obj_token || "Untitled";
      if (child.obj_type !== "docx" || !child.obj_token) {
        const used = this.appendBoundedSection(
          sections,
          `Child document: ${title}`,
          `[Skipped unsupported wiki child type: ${child.obj_type || "unknown"}]`,
          remaining,
        );
        remaining -= used;
        continue;
      }

      const content = await this.fetchDocxRawContent(child.obj_token);
      const childContent = content.slice(0, FEISHU_WIKI_CHILD_MAX_CHARS);
      const used = this.appendBoundedSection(
        sections,
        `Child document: ${title}`,
        childContent || "[empty document]",
        remaining,
      );
      remaining -= used;
      if (remaining <= 0) break;
    }

    if (res.data?.has_more && remaining > 0) {
      this.appendBoundedSection(
        sections,
        "Additional wiki children",
        `[Not expanded: showing first ${FEISHU_WIKI_CHILD_MAX_COUNT} child documents.]`,
        remaining,
      );
    }

    return sections;
  }

  private async fetchDocumentContent(ref: FeishuDocumentRef): Promise<string> {
    if (ref.type === "docs") {
      return `Feishu document link: ${ref.url}\nLegacy /docs/ URLs are not supported. Please use a /docx/ or /wiki/ link.`;
    }

    const resolved = await this.resolveDocumentRef(ref);
    const sections: string[] = [`Feishu document link: ${ref.url}`];
    let used = sections[0]?.length ?? 0;
    const rootContent = await this.fetchDocxRawContent(resolved.token);

    used += this.appendBoundedSection(
      sections,
      resolved.wiki?.title ? `Document: ${resolved.wiki.title}` : "Document content",
      rootContent,
      FEISHU_DOC_MAX_CHARS - used,
    );

    const childSections = await this.fetchWikiChildSections(resolved, FEISHU_DOC_MAX_CHARS - used);
    sections.push(...childSections);
    return sections.join("\n\n");
  }

  private async expandFeishuDocumentLinks(blocks: ContentBlock[]): Promise<ContentBlock[]> {
    const refs = this.findDocumentRefs(blocks);
    if (refs.length === 0) return blocks;

    const docBlocks: ContentBlock[] = [];
    for (const ref of refs) {
      try {
        const text = await withTimeout(
          this.fetchDocumentContent(ref),
          FEISHU_DOC_FETCH_TIMEOUT_MS,
          `Feishu document fetch timed out after ${FEISHU_DOC_FETCH_TIMEOUT_MS}ms`,
        );
        docBlocks.push({ type: "text", text });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[Feishu:${this.channelId}] Failed to expand document ${ref.url}:`, message);
        docBlocks.push({ type: "text", text: `Feishu document link: ${ref.url}\n[Unable to fetch document content: ${message}]` });
      }
    }

    return [...blocks, ...docBlocks];
  }

  public async handleOutbound(cmd: PlannedGatewayOutboundCommand): Promise<{ success: boolean; error?: string; externalMessageId?: string }> {
    logger.info(`[Feishu:${this.channelId}] → Outbound to ${cmd.externalChatId}`, {
      contentPreview: cmd.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text?.slice(0, 30) : c.type)).join(", "),
      replyTo: cmd.replyToExternalMessageId?.slice(0, 8) || "none",
      source: typeof cmd.meta?.source === "string" ? cmd.meta.source : "unknown",
    });

    let replyToForTypingCleanup: string | null | undefined = cmd.replyToExternalMessageId;
    try {
      const config = await getSpaceChannelConfig<FeishuChannelConfig>(this.channelId);
      const plan = cmd.deliveryPlan?.adapter === "feishu"
        ? cmd.deliveryPlan
        : await buildFeishuDeliveryPlan(cmd, config);
      replyToForTypingCleanup = plan.replyToExternalMessageId;
      const msgType = plan.msgType;
      const content = plan.content;
      // Resolve image keys: pre-existing Feishu keys + uploaded images
      const imageKeys = plan.imageKeys;
      let uploadedImageKeys: string[] = [];
      if (plan.imagesToUpload && plan.imagesToUpload.length > 0) {
        uploadedImageKeys = (
          await Promise.all(
            plan.imagesToUpload.map((img) => this.uploadImage(img.source)),
          )
        ).filter((k): k is string => k !== null);
        if (uploadedImageKeys.length < plan.imagesToUpload.length) {
          logger.warn(`[Feishu:${this.channelId}] Only uploaded ${uploadedImageKeys.length}/${plan.imagesToUpload.length} images`);
        }
      }
      const allImageKeys = [...imageKeys, ...uploadedImageKeys];
      const extraMediaItems = (plan.mediaItems ?? []).filter((item) => item.kind !== "image");

      const editExternalMessageId = plan.preferredEditExternalMessageId?.trim();
      const turnAnchorMessageId = plan.turnAnchorMessageId?.trim();
      const cachedMessageId = turnAnchorMessageId
        ? await getTurnMessageExternalRef(this.channelId, turnAnchorMessageId).catch(() => null)
        : null;
      const targetMessageId = editExternalMessageId || cachedMessageId;

      if (targetMessageId) {
        if (plan.renderMode === "card") {
          await this.client.im.message.patch({
            path: { message_id: targetMessageId },
            data: { content },
          });
          logger.info(`[Feishu:${this.channelId}] ✓ Card patched: ${targetMessageId}`);
          await this.removeTypingReaction(replyToForTypingCleanup);
          return { success: true, externalMessageId: targetMessageId };
        }
        await this.client.im.message.update({
          path: { message_id: targetMessageId },
          data: { content, msg_type: "post" },
        });
        logger.info(`[Feishu:${this.channelId}] ✓ Post updated: ${targetMessageId}`);
        await this.removeTypingReaction(replyToForTypingCleanup);
        return { success: true, externalMessageId: targetMessageId };
      }

      const receiveIdType = resolveReceiveIdType(cmd.externalChatId);

      if (plan.replyToExternalMessageId) {
        const threadId = cmd.meta?.threadId as string | undefined;
        const replyResult = await this.client.im.message.reply({
          path: { message_id: plan.replyToExternalMessageId },
          data: {
            content,
            msg_type: msgType,
            reply_in_thread: !!threadId,
          },
        });
        const messageId = replyResult?.data?.message_id;
        if (turnAnchorMessageId && messageId) {
          await setTurnMessageExternalRef(this.channelId, turnAnchorMessageId, messageId).catch(() => {});
        }
        logger.info(`[Feishu:${this.channelId}] ✓ Reply sent: ${messageId}`);
        await this.removeTypingReaction(replyToForTypingCleanup);
        return { success: true, externalMessageId: messageId };
      }

      const createResult = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType as "chat_id" | "open_id" | "user_id" },
        data: {
          receive_id: cmd.externalChatId,
          msg_type: msgType,
          content,
        },
      });
      const messageId = createResult?.data?.message_id;
      if (turnAnchorMessageId && messageId) {
        await setTurnMessageExternalRef(this.channelId, turnAnchorMessageId, messageId).catch(() => {});
      }

      const mediaSendErrors: string[] = [];
      if (messageId) {
        for (const imgKey of allImageKeys) {
          try {
            await this.client.im.message.create({
              params: { receive_id_type: receiveIdType as "chat_id" | "open_id" | "user_id" },
              data: {
                receive_id: cmd.externalChatId,
                msg_type: "image",
                content: JSON.stringify({ image_key: imgKey }),
              },
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[Feishu:${this.channelId}] ✗ Failed to send image ${imgKey}:`, errMsg);
            mediaSendErrors.push(imgKey);
          }
        }

        for (const item of extraMediaItems) {
          const uploaded = await this.uploadFile(item);
          if (!uploaded) {
            mediaSendErrors.push(item.filename ?? item.kind);
            continue;
          }
          try {
            await this.client.im.message.create({
              params: { receive_id_type: receiveIdType as "chat_id" | "open_id" | "user_id" },
              data: {
                receive_id: cmd.externalChatId,
                msg_type: uploaded.msgType,
                content: JSON.stringify({ file_key: uploaded.fileKey }),
              },
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[Feishu:${this.channelId}] ✗ Failed to send media ${uploaded.fileKey}:`, errMsg);
            mediaSendErrors.push(uploaded.fileKey);
          }
        }
      }

      logger.info(`[Feishu:${this.channelId}] ✓ Message created: ${messageId}`);
      await this.removeTypingReaction(replyToForTypingCleanup);
      return { success: true, externalMessageId: messageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Feishu:${this.channelId}] ✗ Outbound failed:`, msg);
      if (err instanceof Error && err.stack) {
        logger.error(`[Feishu:${this.channelId}] Stack:`, err.stack.split("\n").slice(0, 3).join("\n"));
      }
      await this.removeTypingReaction(replyToForTypingCleanup);
      return { success: false, error: msg };
    }
  }

  public destroy() {
    logger.info(`[Feishu:${this.channelId}] Destroying Feishu client...`);
    try {
      this.wsClient.close({ force: true });
    } catch {
      // Ignore errors during close
    }
    logger.info(`[Feishu:${this.channelId}] Feishu client destroyed`);
  }
}
