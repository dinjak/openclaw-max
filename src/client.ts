/**
 * MAX Bot API HTTP client.
 * https://platform-api2.max.ru
 *
 * The MAX Bot API moved off platform-api.max.ru (decommissioned 2026-07-19) to
 * platform-api2.max.ru, whose TLS chain is anchored on the Russian Trusted Root
 * CA (Минцифры) — absent from Node's bundled CA store. We therefore route every
 * request through a dedicated undici dispatcher that trusts that CA in addition
 * to the platform defaults, and optionally through an HTTP(S) proxy.
 */

import tls from "node:tls";
// Import fetch from undici too (not Node's global): the global fetch uses Node's
// built-in undici copy, which rejects a dispatcher built by this (possibly
// different) undici version with UND_ERR_INVALID_ARG. Same-package fetch+Agent
// are guaranteed compatible.
import { fetch, FormData, Agent, ProxyAgent, type Dispatcher } from "undici";
import type { MaxUpdatesResponse } from "./types.js";
import { RUSSIAN_TRUSTED_CA } from "./max-ca.js";

const MAX_API = "https://platform-api2.max.ru";
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_SEC = 30;

// ─── TLS / proxy transport ────────────────────────────────────────────────────

// Trust the Минцифры CA on top of the default root store.
const MAX_CA: string[] = [RUSSIAN_TRUSTED_CA, ...tls.rootCertificates];

let dispatcher: Dispatcher = new Agent({ connect: { ca: MAX_CA } });

/**
 * (Re)configure the HTTP transport for MAX API calls.
 * Call once at channel startup. When `httpProxy` is set, requests are tunnelled
 * through it (fixes GitHub issue #1); the Минцифры CA is trusted either way.
 */
export function configureMaxTransport(opts?: { httpProxy?: string }): void {
  const proxy = opts?.httpProxy?.trim();
  dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, connect: { ca: MAX_CA } })
    : new Agent({ connect: { ca: MAX_CA } });
}

// ─── Low-level fetch helper ───────────────────────────────────────────────────

async function maxRequest<T>(
  token: string,
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  params?: Record<string, string | number>,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${MAX_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: token,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      dispatcher,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MAX API ${method} ${path} → ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a text message to a MAX user (DM).
 * Returns the message_id for later editing (streaming), or null on failure.
 */
export async function sendDm(token: string, userId: number, text: string): Promise<string | null> {
  try {
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { user_id: userId }, { text, format: "markdown" }
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendDm error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Send a text message to a MAX chat.
 * Returns the message_id for later editing (streaming), or null on failure.
 */
export async function sendToChat(token: string, chatId: number, text: string): Promise<string | null> {
  try {
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { chat_id: chatId }, { text, format: "markdown" }
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendToChat error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Edit an existing message (for streaming updates).
 * PUT /messages?message_id={id}
 */
export async function editMessage(token: string, messageId: string, text: string): Promise<boolean> {
  try {
    await maxRequest(token, "PUT", "/messages", { message_id: messageId }, { text, format: "markdown" });
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] editMessage error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Delete a bot-sent message (placeholder cleanup on silent/NO_REPLY turns).
 * DELETE /messages?message_id={id}
 */
export async function deleteMessage(token: string, messageId: string): Promise<boolean> {
  try {
    await maxRequest(token, "DELETE", "/messages", { message_id: messageId });
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] deleteMessage error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Send typing indicator to a chat.
 * action: "typing_on" | "typing_off" | "sending_photo" | "sending_video" | "sending_audio"
 */
export async function sendTypingAction(
  token: string,
  chatId: number,
  action: "typing_on" | "typing_off" = "typing_on",
): Promise<void> {
  try {
    await maxRequest(token, "POST", `/chats/${chatId}/actions`, {}, { action });
  } catch {
    // Typing is best-effort, never throw
  }
}

/**
 * Long-poll for new updates.
 * Returns updates + next marker.
 */
export async function getUpdates(
  token: string,
  marker?: number | null,
  timeoutSec = LONG_POLL_TIMEOUT_SEC,
  signal?: AbortSignal,
): Promise<MaxUpdatesResponse> {
  const params: Record<string, string | number> = { timeout: timeoutSec, limit: 100 };
  if (marker != null) params.marker = marker;

  const url = new URL(`${MAX_API}/updates`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  // Combine external abort signal with our timeout
  const combinedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 10) * 1000)])
    : AbortSignal.timeout((timeoutSec + 10) * 1000);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: token },
      signal: combinedSignal,
      dispatcher,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET /updates → ${res.status}: ${text}`);
    }
    return (await res.json()) as MaxUpdatesResponse;
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
      return { updates: [], marker };
    }
    throw err;
  }
}

/**
 * Register a webhook URL with MAX.
 */
export async function subscribeWebhook(
  token: string,
  webhookUrl: string,
  secret?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    url: webhookUrl,
    update_types: ["message_created", "bot_started", "message_callback"],
  };
  if (secret) body.secret = secret;

  await maxRequest(token, "POST", "/subscriptions", undefined, body);
}

/**
 * Remove active webhook subscription (switches back to long polling).
 */
export async function deleteWebhook(token: string): Promise<void> {
  await maxRequest(token, "DELETE", "/subscriptions", undefined, {});
}

/**
 * Get bot info (used to verify token on startup).
 */
export async function getBotInfo(token: string): Promise<{ name: string; username: string }> {
  return maxRequest(token, "GET", "/me");
}

export interface DownloadedBytes {
  buf: Buffer;
  contentType?: string;
  filename?: string;
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = header.match(/filename\*=(?:UTF-8''|)([^;]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      // fall through to filename=
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1]?.trim() || undefined;
}

/**
 * Скачать файл по URL вместе с Content-Type и именем из Content-Disposition.
 */
export async function downloadFileMeta(token: string, url: string): Promise<DownloadedBytes | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: token },
      dispatcher,
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return {
      buf,
      contentType: res.headers.get("content-type") ?? undefined,
      filename: filenameFromDisposition(res.headers.get("content-disposition")),
    };
  } catch {
    return null;
  }
}

/**
 * Скачать файл по URL.
 */
export async function downloadFile(token: string, url: string): Promise<Buffer | null> {
  const got = await downloadFileMeta(token, url);
  return got?.buf ?? null;
}

/**
 * Получить файл по токену вложения: GET /files/{fileToken}.
 * Официальная schema 0.0.33 этот метод не перечисляет (в отличие от GET /videos/{token}),
 * но TamTam/MAX Bot API исторически отдаёт JSON `{ url, filename }` либо сами байты.
 * Нужен, когда у forwarded file нет payload.url — только payload.token.
 */
export async function getFileByToken(
  token: string,
  fileToken: string,
): Promise<{ url?: string; filename?: string; buf?: Buffer; contentType?: string } | null> {
  const url = `${MAX_API}/files/${encodeURIComponent(fileToken)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: token },
      signal: controller.signal,
      dispatcher,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    const filename = filenameFromDisposition(res.headers.get("content-disposition"));
    const buf = Buffer.from(await res.arrayBuffer());
    const looksJson =
      contentType.includes("json") ||
      (buf.length > 0 && buf[0] === 0x7b);
    if (looksJson) {
      try {
        const json = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        const fileUrl =
          (typeof json.url === "string" && json.url) ||
          (typeof json.download_url === "string" && json.download_url) ||
          undefined;
        const name =
          (typeof json.filename === "string" && json.filename) ||
          (typeof json.name === "string" && json.name) ||
          filename;
        if (fileUrl || json.token || json.filename) {
          return { url: fileUrl, filename: name, contentType };
        }
      } catch {
        // not API metadata — treat body as the file
      }
      return { buf, contentType, filename };
    }
    return { buf, contentType, filename };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PREFERRED_VIDEO_KEYS = [
  "mp4_1080",
  "mp4_720",
  "mp4_480",
  "mp4_360",
  "mp4_240",
  "mp4_144",
];

/**
 * Прямая ссылка на видео: GET /videos/{videoToken} (официальный MAX Bot API).
 */
export async function getVideoDownloadUrl(token: string, videoToken: string): Promise<string | null> {
  try {
    const info = await maxRequest<{ urls?: Record<string, unknown> }>(
      token,
      "GET",
      `/videos/${encodeURIComponent(videoToken)}`,
    );
    const urls = info?.urls;
    if (!urls || typeof urls !== "object") return null;
    for (const key of PREFERRED_VIDEO_KEYS) {
      const value = urls[key];
      if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    }
    for (const value of Object.values(urls)) {
      if (typeof value === "string" && /^https?:\/\//i.test(value) && !value.includes(".m3u8")) {
        return value;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Получить URL для загрузки медиафайла.
 * type передаётся как query param.
 */
export async function getUploadUrl(token: string, type: "image" | "video" | "audio" | "file"): Promise<string | null> {
  try {
    const res = await maxRequest<{ url: string }>(token, "POST", "/uploads", { type });
    return res?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Загрузить файл по upload URL (multipart/form-data).
 * Возвращает { token } из ответа или null.
 */
export async function uploadFile(uploadUrl: string, buffer: Buffer, mimeType: string, filename: string): Promise<{ token: string } | null> {
  try {
    const form = new FormData();
    form.append("data", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
    const res = await fetch(uploadUrl, {
      method: "POST",
      body: form,
      dispatcher,
    });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    // Direct token at top level
    if (typeof json.token === "string") return { token: json.token };
    // Photos response: { photos: { <key>: { token: string } } }
    if (json.photos && typeof json.photos === "object") {
      const firstVal = Object.values(json.photos as Record<string, unknown>)[0] as Record<string, unknown> | undefined;
      if (firstVal && typeof firstVal.token === "string") return { token: firstVal.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Отправить сообщение с изображением в DM.
 */
export async function sendDmWithImage(token: string, userId: number, text: string, imageToken: string): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      attachments: [{ type: "image", payload: { token: imageToken } }],
    };
    if (text) body.text = text;
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { user_id: userId }, body
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendDmWithImage error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Отправить сообщение с изображением в чат.
 */
export async function sendToChatWithImage(token: string, chatId: number, text: string, imageToken: string): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      attachments: [{ type: "image", payload: { token: imageToken } }],
    };
    if (text) body.text = text;
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { chat_id: chatId }, body
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendToChatWithImage error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
