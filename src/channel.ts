/**
 * MAX channel plugin for OpenClaw.
 *
 * Supports two delivery modes:
 *  - Webhook (recommended for production): configure `channels.max.webhookUrl`
 *  - Long polling (default, works everywhere)
 *
 * MAX Bot API: https://dev.max.ru/docs-api
 */

import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendDm, sendToChat, sendDmWithImage, sendToChatWithImage, editMessage, deleteMessage, sendTypingAction, getUpdates, subscribeWebhook, deleteWebhook, getBotInfo, getUploadUrl, uploadFile, configureMaxTransport } from "./client.js";
import { getMaxRuntime } from "./runtime.js";
import { createWebhookHandler, handleUpdate } from "./webhook-handler.js";
import type { InboundImage } from "./webhook-handler.js";
import type { ResolvedMaxAccount } from "./types.js";

const CHANNEL_ID = "max";

/** Active typing-stop callbacks keyed by unique instance id — lets sendMedia stop all typing */
const activeTypingStops = new Map<string, () => void>();
let typingStopSeq = 0;

const MaxConfigSchema = buildChannelConfigSchema(
  z.object({
    token: z.string().optional().describe("MAX Bot API token (from business.max.ru)"),
    enabled: z.boolean().optional().default(true).describe("Enable or disable this channel"),
    dmPolicy: z.enum(["open", "allowlist", "closed"]).optional().default("allowlist").describe("Who can send DMs"),
    allowFrom: z.array(z.string()).optional().describe("Allowed MAX user IDs (when dmPolicy=allowlist)"),
    webhookUrl: z.string().optional().describe("Webhook URL for production mode (optional, uses long polling if not set)"),
    webhookSecret: z.string().optional().describe("Webhook secret for verifying MAX requests"),
  }).passthrough()
);

// Track active webhook route unregisters per account
const activeRouteUnregisters = new Map<string, () => void>();

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { onAbort?.(); resolve(); };
    if (!signal) return;
    if (signal.aborted) { done(); return; }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Minimum interval between streaming edits (ms) to avoid rate limits */
const STREAM_EDIT_INTERVAL_MS = 800;
const TYPING_INTERVAL_MS = 4000;
/** Leak guard only — reset on activity so long think/tool turns keep typing. */
const TYPING_SAFETY_MS = 30 * 60 * 1000;
const PLACEHOLDER_DELAY_MS = 500;
const STATUS_MAX_LINES = 6;
const STATUS_LINE_CHARS = 120;
const PLACEHOLDER_TEXT = "⏳ обрабатываю…";

/**
 * Send a reply to the user based on chat type.
 * Returns the message_id (for streaming edits).
 */
async function sendReply(
  account: ResolvedMaxAccount,
  chatId: string,
  chatType: string,
  text: string,
): Promise<string | null> {
  const numericId = parseInt(chatId, 10);
  if (isNaN(numericId)) return null;

  if (chatType === "direct") {
    return sendDm(account.token, numericId, text);
  } else {
    return sendToChat(account.token, numericId, text);
  }
}

function isSilentFinalText(text: unknown): boolean {
  const t = String(text ?? "").trim();
  return !t || t === "NO_REPLY" || t === "HEARTBEAT_OK";
}

function truncateStatus(text: unknown, max = STATUS_LINE_CHARS): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function toolStatusIcon(name: unknown): string {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("search") || n.includes("web") || n.includes("fetch")) return "🔎";
  if (n.includes("exec") || n.includes("bash") || n.includes("shell")) return "🛠️";
  if (n === "read" || n.includes("read_file") || n.endsWith(".read")) return "📖";
  if (n.includes("write") || n.includes("edit") || n.includes("apply_patch")) return "✍️";
  return "⚙️";
}

function shortToolHint(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  const preferred = rec.command ?? rec.cmd ?? rec.query ?? rec.url ?? rec.path ?? rec.file ?? rec.target;
  if (typeof preferred === "string" && preferred.trim()) return truncateStatus(preferred, 80);
  return "";
}

type StreamPhase = "idle" | "status" | "streaming" | "done";

/**
 * Create a streaming deliverer:
 * - onWorkStart / onStatus: visible activity before any answer tokens exist
 * - onPartialToken(text): called per streaming token → sends/edits message with cursor
 * - deliver(payload): called once at end with full text → final clean edit (no cursor)
 *
 * MAX Bot API typing (`POST /chats/{chatId}/actions`, action typing_on) is documented
 * for group chats and is ephemeral; DMs need an editable placeholder to stay alive.
 */
function createStreamingDeliver(
  account: ResolvedMaxAccount,
  chatId: string,
  dialogChatId: string,
  chatType: string,
  log?: any,
): {
  onPartialToken: (text: string) => Promise<void>;
  onWorkStart: () => Promise<void>;
  onThinking: () => Promise<void>;
  onToolStart: (payload: { name?: string; args?: unknown }) => Promise<void>;
  onItemEvent: (payload: {
    title?: string;
    summary?: string;
    progressText?: string;
    name?: string;
  }) => Promise<void>;
  onApprovalEvent: (payload: { phase?: string; title?: string }) => Promise<void>;
  deliver: (payload: { text?: string; body?: string }) => Promise<void>;
  finish: () => Promise<void>;
} {
  let messageId: string | null = null;
  let accumulated = "";
  let lastEditAt = 0;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;
  let phase: StreamPhase = "idle";
  let thinkingNoted = false;
  const progressLines: string[] = [];

  // Typing indicator — declared early so throttledEdit can reference it
  const numericDialogChatId = parseInt(dialogChatId, 10);
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  if (!isNaN(numericDialogChatId)) {
    sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    typingInterval = setInterval(() => {
      sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  // Unique key for this deliver instance (not chatId — concurrent messages share chatId)
  const instanceKey = String(++typingStopSeq);

  function armTypingSafety() {
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => stopTyping(), TYPING_SAFETY_MS);
  }

  function stopTyping() {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
    activeTypingStops.delete(instanceKey);
  }

  armTypingSafety();
  // Register so sendMedia can stop ALL active typing intervals
  activeTypingStops.set(instanceKey, stopTyping);

  async function throttledEdit(text: string) {
    if (!messageId) return;
    const elapsed = Date.now() - lastEditAt;
    if (pendingEdit) clearTimeout(pendingEdit);
    if (elapsed >= STREAM_EDIT_INTERVAL_MS) {
      await editMessage(account.token, messageId, text);
      lastEditAt = Date.now();
      // MAX clears typing on message edit — renew immediately after
      if (typingInterval !== null) {
        sendTypingAction(account.token, numericDialogChatId).catch(() => {});
      }
    } else {
      pendingEdit = setTimeout(async () => {
        if (messageId) {
          await editMessage(account.token, messageId, text).catch(() => {});
          lastEditAt = Date.now();
          if (typingInterval !== null) {
            sendTypingAction(account.token, numericDialogChatId).catch(() => {});
          }
        }
      }, STREAM_EDIT_INTERVAL_MS - elapsed) as unknown as ReturnType<typeof setTimeout>;
    }
  }

  // Promise to prevent race condition on first message creation
  let creationPromise: Promise<void> | null = null;

  async function ensureVisible(text: string) {
    if (!text) return;
    if (!creationPromise) {
      creationPromise = (async () => {
        messageId = await sendReply(account, chatId, chatType, text);
        lastEditAt = Date.now();
        log?.info?.(`[openclaw-max] Activity message mid=${messageId}`);
      })();
      await creationPromise;
      return;
    }
    await creationPromise;
    await throttledEdit(text);
  }

  function renderStatus(): string {
    const lines = [PLACEHOLDER_TEXT, ...progressLines.slice(-STATUS_MAX_LINES)];
    return lines.join("\n");
  }

  async function showStatus() {
    if (phase === "streaming" || phase === "done") return;
    phase = "status";
    armTypingSafety();
    await ensureVisible(renderStatus());
  }

  let placeholderTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (phase === "idle") showStatus().catch(() => {});
  }, PLACEHOLDER_DELAY_MS);

  function cancelPlaceholderTimer() {
    if (placeholderTimer) {
      clearTimeout(placeholderTimer);
      placeholderTimer = null;
    }
  }

  async function onWorkStart() {
    cancelPlaceholderTimer();
    if (phase === "idle" || phase === "status") await showStatus();
  }

  async function pushProgressLine(line: string) {
    const cleaned = truncateStatus(line);
    if (!cleaned) return;
    if (progressLines[progressLines.length - 1] === cleaned) return;
    progressLines.push(cleaned);
    if (progressLines.length > STATUS_MAX_LINES) progressLines.shift();
    await showStatus();
  }

  async function onThinking() {
    if (thinkingNoted) return;
    thinkingNoted = true;
    await pushProgressLine("💭 думаю…");
  }

  async function onToolStart(payload: { name?: string; args?: unknown }) {
    const name = typeof payload?.name === "string" ? payload.name.trim() : "";
    if (!name) return;
    const hint = shortToolHint(payload?.args);
    const line = hint
      ? `${toolStatusIcon(name)} ${name}: ${hint}`
      : `${toolStatusIcon(name)} ${name}`;
    await pushProgressLine(line);
  }

  async function onItemEvent(payload: {
    title?: string;
    summary?: string;
    progressText?: string;
    name?: string;
  }) {
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    const summary = typeof payload?.summary === "string" ? payload.summary.trim() : "";
    const progressText = typeof payload?.progressText === "string" ? payload.progressText.trim() : "";
    const name = typeof payload?.name === "string" ? payload.name.trim() : "";
    const detail = title || summary || progressText;
    if (!detail) return;
    const label = title || name || "шаг";
    const extra = summary && summary !== title ? summary : (!title && progressText ? progressText : "");
    await pushProgressLine(
      extra
        ? `${toolStatusIcon(name)} ${label}: ${truncateStatus(extra, 80)}`
        : `${toolStatusIcon(name)} ${label}`,
    );
  }

  async function onApprovalEvent(payload: { phase?: string; title?: string }) {
    if (payload?.phase && payload.phase !== "requested") return;
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    await pushProgressLine(
      title ? `⏳ жду подтверждение: ${truncateStatus(title, 80)}` : "⏳ жду подтверждение…",
    );
  }

  // Called for each streaming partial (text is CUMULATIVE — full text so far)
  async function onPartialToken(text: string) {
    if (!text) return;
    cancelPlaceholderTimer();
    phase = "streaming";
    armTypingSafety();
    // Keep typing indicator alive during streaming — stop only in deliver()
    accumulated = text; // SET not += (onPartialReply is cumulative)
    await ensureVisible(accumulated + " …");
  }

  // Called once at end with final authoritative text
  async function deliver(payload: { text?: string; body?: string }) {
    cancelPlaceholderTimer();
    stopTyping(); // Ensure typing stops even if no partial tokens came
    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }
    const rawText = payload?.text ?? payload?.body ?? accumulated;
    if (isSilentFinalText(rawText) && !accumulated) {
      if (messageId && (phase === "status" || phase === "idle")) {
        await deleteMessage(account.token, messageId);
        messageId = null;
        phase = "done";
      }
      return;
    }
    const finalText = isSilentFinalText(rawText) ? accumulated : rawText;
    if (!finalText) return;
    phase = "done";
    if (messageId) {
      // Edit existing streamed/status message — remove cursor, use final text
      await editMessage(account.token, messageId, finalText);
    } else {
      // No partial tokens came through — send fresh
      await sendReply(account, chatId, chatType, finalText);
    }
  }

  async function finish() {
    cancelPlaceholderTimer();
    stopTyping();
    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }
    if (messageId && (phase === "status" || phase === "idle")) {
      await deleteMessage(account.token, messageId).catch(() => {});
      messageId = null;
      phase = "done";
    } else if (phase === "streaming" && messageId && accumulated) {
      await editMessage(account.token, messageId, accumulated).catch(() => {});
      phase = "done";
    }
  }

  return { onPartialToken, onWorkStart, onThinking, onToolStart, onItemEvent, onApprovalEvent, deliver, finish };
}

/**
 * Dispatch an inbound message to the OpenClaw agent and send reply back.
 */
async function deliverMessage(
  {
    text,
    senderId,
    senderName,
    chatId,
    dialogChatId,
    chatType,
    messageId: _messageId,
    accountId,
    images,
  }: {
    text: string;
    senderId: string;
    senderName: string;
    chatId: string;
    dialogChatId: string;
    chatType: string;
    messageId: string; // bound as _messageId (unused but part of interface)
    accountId: string;
    images?: InboundImage[];
  },
  account: ResolvedMaxAccount,
  cfg: unknown,
  log?: any,
): Promise<void> {
  const rt = getMaxRuntime();
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: chatType === "direct" ? "direct" : "group", id: senderId },
  });
  const sessionKey = route.sessionKey;

  const msgCtx = rt.channel.reply.finalizeInboundContext({
    Body: text,
    RawBody: text,
    CommandBody: text,
    From: `max:${senderId}`,
    To: `max:${senderId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `max:${senderId}`,
    ChatType: chatType === "direct" ? "direct" : "group",
    SenderName: senderName,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: senderName || senderId,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const { onPartialToken, onWorkStart, onThinking, onToolStart, onItemEvent, onApprovalEvent, deliver, finish } =
    createStreamingDeliver(account, chatId, dialogChatId, chatType, log);

  try {
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: msgCtx,
      cfg,
      dispatcherOptions: {
        deliver,
        onReplyStart: () => {
          log?.info?.(`[openclaw-max] Agent reply started for ${senderName}`);
          return onWorkStart();
        },
      },
      replyOptions: {
        suppressDefaultToolProgressMessages: true,
        preserveProgressCallbackStartOrder: true,
        onPartialReply: async (payload: { text?: string }) => {
          if (payload?.text) await onPartialToken(payload.text);
        },
        onReasoningStream: async () => {
          await onThinking();
        },
        onToolStart: async (payload: { name?: string; args?: unknown }) => {
          await onToolStart(payload);
        },
        onItemEvent: async (payload: {
          title?: string;
          summary?: string;
          progressText?: string;
          name?: string;
        }) => {
          await onItemEvent(payload);
        },
        onApprovalEvent: async (payload: { phase?: string; title?: string }) => {
          await onApprovalEvent(payload);
        },
        images: images?.map(img => ({
          type: "image" as const,
          mimeType: img.mimeType,
          data: img.data,
        })),
      },
    });
  } finally {
    await finish();
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createMaxPlugin(): any {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "MAX",
      selectionLabel: "MAX (Bot API)",
      detailLabel: "MAX Bot",
      docsPath: "/channels/max",
      docsLabel: "max",
      blurb: "Connect OpenClaw to MAX messenger (max.ru) via Bot API.",
      order: 80,
    },

    capabilities: {
      chatTypes: ["direct" as const, "group" as const],
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    configSchema: MaxConfigSchema,

    config: {
      listAccountIds: (cfg: any) => listAccountIds(cfg),
      resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),
      defaultAccountId: (_cfg: any) => DEFAULT_ACCOUNT_ID,

      setAccountEnabled: ({ cfg, accountId, enabled }: any) => {
        const channelConfig = cfg?.channels?.[CHANNEL_ID] ?? {};
        if (accountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: { ...cfg.channels, [CHANNEL_ID]: { ...channelConfig, enabled } },
          };
        }
        return setAccountEnabledInConfigSection({
          cfg,
          sectionKey: `channels.${CHANNEL_ID}`,
          accountId,
          enabled,
        });
      },
    },

    pairing: {
      idLabel: "maxUserId",
      normalizeAllowEntry: (entry: string) => entry.replace(/^max:(?:user:)?/i, "").trim(),
      notifyApproval: async ({ cfg, id }: { cfg: any; id: string }) => {
        const account = resolveAccount(cfg);
        if (!account.token) return;
        const numericId = parseInt(id, 10);
        if (!isNaN(numericId)) {
          await sendDm(account.token, numericId, "✅ OpenClaw: your access has been approved.");
        }
      },
    },

    security: {
      resolveDmPolicy: ({ cfg, accountId, account: resolvedAccount }: any) => {
        const account: ResolvedMaxAccount = resolvedAccount ?? resolveAccount(cfg, accountId);
        return {
          policy: account.dmPolicy,
          allowFrom: account.allowFrom,
          policyPath: `channels.max.dmPolicy`,
          allowFromPath: `channels.max.allowFrom`,
          approveHint: "openclaw pairing approve max <code>",
        };
      },
    },

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4000,

      sendText: async ({ to, text, accountId, cfg }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) throw new Error("MAX token not configured");

        const numericId = parseInt(to.replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX user ID: ${to}`);

        const ok = await sendDm(account.token, numericId, text);
        if (!ok) throw new Error("Failed to send MAX message");
        return { channel: CHANNEL_ID, messageId: `max-${Date.now()}`, chatId: to };
      },

      sendMedia: async ({ to, buffer, mimeType, filename, caption, accountId, cfg, chatType }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) throw new Error("MAX token not configured");

        const numericId = parseInt(to.replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX user ID: ${to}`);

        // Determine media type
        const mediaType = mimeType?.startsWith("image/") ? "image"
          : mimeType?.startsWith("video/") ? "video"
          : mimeType?.startsWith("audio/") ? "audio"
          : "file";

        // Get upload URL
        const uploadUrl = await getUploadUrl(account.token, mediaType as "image" | "video" | "audio" | "file");
        if (!uploadUrl) throw new Error("Failed to get MAX upload URL");

        // Upload file
        const uploaded = await uploadFile(uploadUrl, buffer, mimeType ?? "application/octet-stream", filename ?? "file");
        if (!uploaded) throw new Error("Failed to upload file to MAX");

        // Send message with attachment
        const text = caption ?? "";
        let mid: string | null = null;
        if (mediaType === "image") {
          if (chatType === "direct" || !chatType) {
            mid = await sendDmWithImage(account.token, numericId, text, uploaded.token);
          } else {
            mid = await sendToChatWithImage(account.token, numericId, text, uploaded.token);
          }
        } else {
          // For non-image media, fall back to text with caption
          if (text) {
            mid = await sendDm(account.token, numericId, text);
          }
        }

        // Stop ALL active typing indicators — deliver() may not be called after sendMedia
        for (const stopFn of activeTypingStops.values()) stopFn();
        activeTypingStops.clear();

        return { channel: CHANNEL_ID, messageId: mid ?? `max-${Date.now()}`, chatId: to };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`[openclaw-max] Account ${accountId} disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (!account.token) {
          log?.warn?.(`[openclaw-max] Account ${accountId} missing token, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        // Configure the HTTP transport (Минцифры CA + optional proxy) before any
        // API call. Note: the transport is process-global, so with multiple
        // accounts the last-started account's proxy wins; the CA trust is shared.
        configureMaxTransport({ httpProxy: account.httpProxy });
        if (account.httpProxy) {
          log?.info?.(`[openclaw-max] Using HTTP proxy for MAX API traffic`);
        }

        // Verify token on startup
        try {
          const info = await getBotInfo(account.token);
          log?.info?.(`[openclaw-max] Connected as bot: ${info.name} (@${info.username})`);
        } catch (err) {
          log?.error?.(`[openclaw-max] Token verification failed: ${err instanceof Error ? err.message : err}`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (account.webhookUrl) {
          return startWebhookMode(ctx, account, cfg, log);
        } else {
          return startLongPollingMode(ctx, account, cfg, log);
        }
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`[openclaw-max] Account ${ctx.accountId} stopped`);
      },
    },

    heartbeat: {
      sendTyping: async ({ cfg, to, accountId }: { cfg?: any; to: string; accountId?: string }) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) return;
        const numericId = parseInt(String(to).replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) return;
        await sendTypingAction(account.token, numericId);
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### MAX Messenger Formatting",
        "MAX supports Markdown formatting:",
        "",
        "- **bold**: `**text**` or `__text__`",
        "- *italic*: `*text*` or `_text_`",
        "- ~~strikethrough~~: `~~text~~`",
        "- `inline code`: backtick",
        "- [links](url): `[display text](https://url)`",
        "",
        "Keep messages under 4000 characters.",
        "No emoji reactions, no message editing after send.",
      ],
    },
  };
}

// ─── Webhook mode ─────────────────────────────────────────────────────────────

async function startWebhookMode(ctx: any, account: ResolvedMaxAccount, _cfg: unknown, log: any) {
  log?.info?.(`[openclaw-max] Starting in webhook mode → ${account.webhookUrl}`);

  // Register webhook with MAX
  try {
    await subscribeWebhook(account.token, account.webhookUrl!, account.webhookSecret);
    log?.info?.(`[openclaw-max] Webhook registered: ${account.webhookUrl}`);
  } catch (err) {
    log?.error?.(`[openclaw-max] Failed to register webhook: ${err instanceof Error ? err.message : err}`);
    return waitUntilAbort(ctx.abortSignal);
  }

  const handler = createWebhookHandler({
    account,
    deliver: async (msg) => {
      const currentCfg = _cfg;
      await deliverMessage(msg, account, currentCfg, log);
      return null;
    },
    log,
  });

  const routeKey = `${account.accountId}:${account.webhookPath}`;
  const prev = activeRouteUnregisters.get(routeKey);
  if (prev) {
    log?.info?.(`[openclaw-max] Deregistering stale webhook route`);
    prev();
    activeRouteUnregisters.delete(routeKey);
  }

  const unregister = registerPluginHttpRoute({
    path: account.webhookPath,
    auth: "plugin",
    replaceExisting: true,
    pluginId: CHANNEL_ID,
    accountId: account.accountId,
    log: (msg: string) => log?.info?.(msg),
    handler,
  });
  activeRouteUnregisters.set(routeKey, unregister);
  log?.info?.(`[openclaw-max] Webhook route registered: ${account.webhookPath}`);

  return waitUntilAbort(ctx.abortSignal, async () => {
    log?.info?.(`[openclaw-max] Stopping webhook mode for account ${account.accountId}`);
    unregister?.();
    activeRouteUnregisters.delete(routeKey);
    try {
      await deleteWebhook(account.token);
    } catch {
      // best-effort cleanup
    }
  });
}

// ─── Long polling mode ────────────────────────────────────────────────────────

async function startLongPollingMode(ctx: any, account: ResolvedMaxAccount, _cfg: unknown, log: any) {
  log?.info?.(`[openclaw-max] Starting in long polling mode`);

  const signal: AbortSignal = ctx.abortSignal;
  let marker: number | null | undefined = undefined;
  let consecutiveErrors = 0;
  const MAX_ERRORS = 5;

  while (!signal?.aborted) {
    try {
      const result = await getUpdates(account.token, marker, 30, signal);
      consecutiveErrors = 0;

      if (result.updates.length > 0) {
        log?.info?.(`[openclaw-max] Received ${result.updates.length} update(s)`);
        const currentCfg = _cfg;

        for (const update of result.updates) {
          await handleUpdate(
            update,
            account,
            async (msg) => {
              await deliverMessage(msg, account, currentCfg, log);
              return null;
            },
            log,
          );
        }
      }

      // Advance marker
      if (result.marker != null) {
        marker = result.marker;
      }
    } catch (err) {
      if (signal?.aborted) break;
      consecutiveErrors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.warn?.(`[openclaw-max] Long polling error (${consecutiveErrors}/${MAX_ERRORS}): ${errMsg}`);

      if (consecutiveErrors >= MAX_ERRORS) {
        log?.error?.(`[openclaw-max] Too many consecutive errors, stopping long polling`);
        break;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delay = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), 30_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  log?.info?.(`[openclaw-max] Long polling stopped for account ${account.accountId}`);
}
