// @ts-nocheck
/* patched copy of dist webhook-handler.js — do not tsc-overwrite without this marker */
/**
 * Inbound webhook handler for MAX Bot API events.
 * Patched locally:
 *  - unwrap forwarded messages from link.message (body.text is empty)
 *  - pull screenshots from PHOTO/_type, payload.ls, photos, previewData
 *  - save inbound images to ~/.openclaw/media/inbound so view_image sees THIS file
 *  - download non-image attachments (file/audio/video) to the same inbound dir
 * Marker: openclaw-max-forward-unwrap
 * Marker: openclaw-max-forward-images
 * Marker: openclaw-max-save-inbound
 * Marker: openclaw-max-save-inbound-files
 *
 * Source: @olegbalbekov/openclaw-max dist/src/webhook-handler.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadFile, downloadFileMeta, getFileByToken, getVideoDownloadUrl } from "./client.js";
const MAX_BODY_BYTES = 1_048_576; // 1 MB
const IMAGE_KINDS = new Set(["image", "photo", "sticker"]);
const FILE_KINDS = new Set(["file", "audio", "video", "document"]);
const MIME_EXT = {
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/gzip": "gz",
    "application/json": "json",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt",
    "text/csv": "csv",
    "text/html": "html",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
};
export interface InboundImage {
    data: string;
    mimeType: string;
}
export interface WebhookDeliverMsg {
    text: string;
    senderId: string;
    senderName: string;
    chatId: string;
    dialogChatId: string;
    chatType: "direct" | "chat" | "channel";
    messageId: string;
    accountId: string;
    images?: InboundImage[];
}
function respondJson(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}
function respondOk(res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
}
async function readBody(req) {
    return new Promise((resolve) => {
        let data = "";
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                req.destroy();
                resolve(null);
                return;
            }
            data += chunk.toString("utf8");
        });
        req.on("end", () => resolve(data));
        req.on("error", () => resolve(null));
    });
}
function validateSecret(req, secret) {
    if (!secret)
        return true;
    const header = req.headers["x-max-bot-api-secret"];
    return header === secret;
}
function detectMimeType(buf) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
        return "image/png";
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
        return "image/jpeg";
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
        return "image/webp";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
        return "image/gif";
    return "image/jpeg";
}
function extractMessage(update) {
    if (update.update_type === "message_created") {
        return update.message ?? null;
    }
    return null;
}
function resolveChatType(msg) {
    const t = msg.recipient?.chat_type;
    if (t === "dialog")
        return "direct";
    if (t === "channel")
        return "channel";
    return "chat";
}
function asList(value) {
    return Array.isArray(value) ? value : [];
}
function collectAttachments(...objs) {
    const out = [];
    for (const obj of objs) {
        if (!obj || typeof obj !== "object")
            continue;
        out.push(...asList(obj.attachments));
        out.push(...asList(obj.attaches));
    }
    return out;
}
function attachKind(a) {
    return String(a?._type || a?.type || "").toLowerCase();
}
function attachFilename(a) {
    const payload = a?.payload && typeof a.payload === "object" ? a.payload : {};
    return String(a?.filename || payload.filename || payload.name || payload.fileName ||
        a?.fileName || a?.name || payload.file_name || "").trim();
}
function isImageAttach(a) {
    const kind = attachKind(a);
    if (IMAGE_KINDS.has(kind))
        return true;
    const name = attachFilename(a).toLowerCase();
    return kind === "file" && /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name);
}
function isFileLikeAttach(a) {
    return FILE_KINDS.has(attachKind(a)) && !isImageAttach(a);
}
function attachToken(a) {
    const payload = a?.payload && typeof a.payload === "object" ? a.payload : {};
    const value = payload.token || a?.token || payload.file_token || a?.file_token;
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function mediaUrlFromAttach(att) {
    const payload = att?.payload && typeof att.payload === "object" ? att.payload : {};
    for (const src of [payload, att]) {
        if (!src || typeof src !== "object")
            continue;
        for (const key of ["url", "fileUrl", "file_url", "downloadUrl", "download_url"]) {
            const url = httpUrl(src[key]);
            if (url)
                return url;
        }
    }
    return null;
}
function httpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
}
function sizedUrl(obj) {
    const url = httpUrl(obj?.url);
    if (!url)
        return null;
    const w = Number(obj.width ?? obj.w ?? 0);
    const h = Number(obj.height ?? obj.h ?? 0);
    return { url, area: Math.max(0, w) * Math.max(0, h) };
}
function lsUrls(src) {
    const urls = [];
    for (const item of asList(src?.ls)) {
        if (typeof item === "string" && httpUrl(item))
            urls.push(item);
        else if (item && httpUrl(item.url))
            urls.push(item.url);
    }
    return urls;
}
function imageUrlFromAttach(att) {
    const payload = att?.payload && typeof att.payload === "object" ? att.payload : {};
    const sized = [];
    const ls = [];
    const explicit = [];
    for (const src of [payload, att]) {
        if (!src || typeof src !== "object")
            continue;
        for (const key of ["url", "photoUrl", "photo_url", "image_url", "fileUrl", "file_url"]) {
            const url = httpUrl(src[key]);
            if (url)
                explicit.push(url);
        }
        ls.push(...lsUrls(src));
        for (const item of [...asList(src.photo), ...asList(src.photos), ...asList(src.sizes)]) {
            const got = sizedUrl(item) || (typeof item === "string" && httpUrl(item) ? { url: item, area: 0 } : null);
            if (got)
                sized.push(got);
        }
        if (src.photos && typeof src.photos === "object" && !Array.isArray(src.photos)) {
            for (const val of Object.values(src.photos)) {
                const got = sizedUrl(val) || (httpUrl(val?.url) ? { url: val.url, area: 0 } : null);
                if (got)
                    sized.push(got);
            }
        }
    }
    sized.sort((a, b) => b.area - a.area);
    if (sized.length && sized[0].area > 0)
        return sized[0].url;
    if (ls.length)
        return ls[ls.length - 1];
    return explicit[0] || sized[0]?.url || null;
}
function previewImageFromAttach(att) {
    const raw = att?.previewData || att?.preview_data || att?.payload?.previewData || att?.payload?.preview_data;
    if (typeof raw !== "string" || raw.length < 64)
        return null;
    let mime = "image/jpeg";
    let b64 = raw;
    const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (match) {
        mime = match[1];
        b64 = match[2];
    }
    try {
        const buf = Buffer.from(b64, "base64");
        if (buf.length < 32)
            return null;
        return { data: buf.toString("base64"), mimeType: detectMimeType(buf) || mime };
    }
    catch {
        return null;
    }
}
function attachDebug(a) {
    const payload = a?.payload && typeof a.payload === "object" ? a.payload : null;
    const keys = Object.keys(a || {}).join(",");
    const pkeys = payload ? Object.keys(payload).join(",") : "-";
    return `kind=${attachKind(a) || "-"} keys=${keys || "-"} payloadKeys=${pkeys} filename=${attachFilename(a) || "-"} hasToken=${Boolean(attachToken(a))} hasUrl=${Boolean(imageUrlFromAttach(a) || mediaUrlFromAttach(a))} hasPreview=${Boolean(previewImageFromAttach(a))}`;
}
function linkedBody(link) {
    const inner = link?.message;
    if (!inner || typeof inner !== "object")
        return { text: "", attachments: [] };
    return {
        text: String(inner.body?.text ?? inner.text ?? "").trim(),
        attachments: collectAttachments(inner, inner.body),
    };
}
function attachmentSummary(atts) {
    const parts = [];
    for (const a of asList(atts)) {
        if (isImageAttach(a)) {
            parts.push("[image]");
            continue;
        }
        // file/audio/video placeholders are replaced after download with [file: <abs path>]
        if (isFileLikeAttach(a))
            continue;
        const type = attachKind(a) || "file";
        const name = attachFilename(a) || type;
        parts.push(`[${type}: ${name}]`);
    }
    return parts.length ? parts.join(" ") : "";
}
function resolveInbound(msg) {
    const ownText = String(msg.body?.text ?? "").trim();
    const ownAtts = collectAttachments(msg, msg.body);
    const link = msg.link;
    const linkType = String(link?.type ?? "").toLowerCase();
    const linked = linkedBody(link);
    let text = ownText;
    let attachments = ownAtts.slice();
    if (linkType === "forward") {
        const fromName = link?.sender?.name || link?.chat_name || link?.chatName || "";
        const prefix = fromName ? `[Переслано от ${fromName}]` : "[Переслано]";
        if (linked.text) {
            text = ownText ? `${ownText}\n\n${prefix}\n${linked.text}` : `${prefix}\n${linked.text}`;
        }
        else if (!ownText) {
            text = prefix;
        }
        if (linked.attachments.length)
            attachments = attachments.concat(linked.attachments);
    }
    const extra = attachmentSummary(attachments);
    if (extra)
        text = text ? `${text}\n${extra}` : extra;
    return { text: text.trim(), attachments };
}
function inboundMediaDir() {
    const home = process.env.HOME || os.homedir() || "/root";
    return path.join(home, ".openclaw", "media", "inbound");
}
function extForMime(mime) {
    if (mime === "image/png")
        return "png";
    if (mime === "image/webp")
        return "webp";
    if (mime === "image/gif")
        return "gif";
    return "jpg";
}
function saveInboundImages(buffers, messageId, log) {
    const paths = [];
    if (!buffers.length)
        return paths;
    const dir = inboundMediaDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch (err) {
        log?.warn(`[openclaw-max] inbound dir: ${err instanceof Error ? err.message : String(err)}`);
        return paths;
    }
    const safe = String(messageId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
    buffers.forEach((item, index) => {
        const file = path.join(dir, `max-${safe}-${index}.${extForMime(item.mimeType)}`);
        try {
            fs.writeFileSync(file, item.buf);
            paths.push(file);
        }
        catch (err) {
            log?.warn(`[openclaw-max] save image failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    return paths;
}
function sanitizeFileName(name) {
    const base = path.basename(String(name || "file")).replace(/[/\\]/g, "");
    const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
    return cleaned || "file";
}
function defaultExtForKind(kind) {
    if (kind === "video")
        return "mp4";
    if (kind === "audio")
        return "mp3";
    return "bin";
}
function extensionFor(name, contentType, kind) {
    const fromName = path.extname(name || "").replace(/^\./, "").toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(fromName))
        return fromName;
    const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (MIME_EXT[mime])
        return MIME_EXT[mime];
    return defaultExtForKind(kind);
}
function saveInboundFile(buf, messageId, index, preferredName, contentType, kind, log) {
    const dir = inboundMediaDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch (err) {
        log?.warn(`[openclaw-max] inbound dir: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    const safeMid = String(messageId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
    const safeName = sanitizeFileName(preferredName);
    const ext = extensionFor(safeName, contentType, kind);
    const stem = safeName.replace(/\.[a-z0-9]{1,8}$/i, "") || "file";
    const file = path.resolve(path.join(dir, `max-${safeMid}-file-${index}-${stem}.${ext}`));
    try {
        fs.writeFileSync(file, buf);
        return file;
    }
    catch (err) {
        log?.warn(`[openclaw-max] save file failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
async function resolveFileBytes(att, token, log) {
    const kind = attachKind(att) || "file";
    let url = mediaUrlFromAttach(att);
    let filename = attachFilename(att) || undefined;
    let contentType;
    let buf;
    const fileToken = attachToken(att);
    if (kind === "video" && fileToken) {
        const videoUrl = await getVideoDownloadUrl(token, fileToken);
        if (videoUrl)
            url = videoUrl;
        else
            log?.warn(`[openclaw-max] video url lookup failed ${attachDebug(att)}`);
    }
    if (!url && fileToken) {
        const resolved = await getFileByToken(token, fileToken);
        if (resolved?.buf) {
            buf = resolved.buf;
            contentType = resolved.contentType;
        }
        if (resolved?.url)
            url = resolved.url;
        if (resolved?.filename)
            filename = filename || resolved.filename;
        if (!resolved)
            log?.warn(`[openclaw-max] GET /files/{token} failed ${attachDebug(att)}`);
    }
    if (!buf && url) {
        const got = await downloadFileMeta(token, url);
        if (got) {
            buf = got.buf;
            contentType = contentType || got.contentType;
            filename = filename || got.filename;
        }
        else {
            log?.warn(`[openclaw-max] file download failed host=${safeHost(url)}`);
        }
    }
    if (!buf || !buf.length)
        return null;
    return { buf, filename, contentType, kind };
}
async function downloadAndSaveFiles(atts, token, messageId, log) {
    const lines = [];
    let saved = 0;
    let failed = 0;
    let index = 0;
    for (const att of asList(atts)) {
        try {
            const got = await resolveFileBytes(att, token, log);
            if (!got) {
                failed += 1;
                lines.push("[file: не удалось скачать]");
                log?.warn(`[openclaw-max] file skipped ${attachDebug(att)}`);
                continue;
            }
            const preferred = got.filename || "file";
            const filePath = saveInboundFile(got.buf, messageId, index, preferred, got.contentType, got.kind, log);
            index += 1;
            if (!filePath) {
                failed += 1;
                lines.push("[file: не удалось скачать]");
                continue;
            }
            saved += 1;
            lines.push(`[file: ${filePath}]`);
        }
        catch (err) {
            failed += 1;
            lines.push("[file: не удалось скачать]");
            log?.warn(`[openclaw-max] file error: ${err instanceof Error ? err.message : String(err)} ${attachDebug(att)}`);
        }
    }
    return { lines, saved, failed };
}
async function downloadImages(atts, token, log) {
    const images = [];
    const buffers = [];
    let urlCount = 0;
    let previewCount = 0;
    for (const att of asList(atts).filter(isImageAttach)) {
        const url = imageUrlFromAttach(att);
        if (url) {
            urlCount += 1;
            const buf = await downloadFile(token, url);
            if (buf && buf.length >= 32) {
                const mimeType = detectMimeType(buf);
                images.push({ data: buf.toString("base64"), mimeType });
                buffers.push({ buf, mimeType });
                continue;
            }
            log?.warn(`[openclaw-max] image download failed host=${safeHost(url)}`);
        }
        const preview = previewImageFromAttach(att);
        if (preview) {
            previewCount += 1;
            images.push(preview);
            buffers.push({ buf: Buffer.from(preview.data, "base64"), mimeType: preview.mimeType });
            continue;
        }
        log?.warn(`[openclaw-max] image skipped ${attachDebug(att)}`);
    }
    return { images, buffers, urlCount, previewCount };
}
function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return "-";
    }
}
export function createWebhookHandler(deps: {
    account: { token: string; webhookSecret?: string; accountId: string };
    deliver: (msg: WebhookDeliverMsg) => Promise<string | null>;
    log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}) {
    const { account, deliver, log } = deps;
    return async (req, res) => {
        if (req.method !== "POST") {
            respondJson(res, 405, { error: "Method not allowed" });
            return;
        }
        if (!validateSecret(req, account.webhookSecret)) {
            log?.warn("[openclaw-max] Webhook secret mismatch — rejecting request");
            respondJson(res, 401, { error: "Invalid secret" });
            return;
        }
        const body = await readBody(req);
        if (body === null) {
            respondJson(res, 400, { error: "Invalid body" });
            return;
        }
        let update;
        try {
            update = JSON.parse(body);
        }
        catch {
            respondJson(res, 400, { error: "Invalid JSON" });
            return;
        }
        respondOk(res);
        await handleUpdate(update, account, deliver, log);
    };
}
export async function handleUpdate(
    update,
    account,
    deliver: (msg: WebhookDeliverMsg) => Promise<string | null>,
    log,
) {
    const msg = extractMessage(update);
    if (!msg)
        return;
    const inbound = resolveInbound(msg);
    const imageAttachments = inbound.attachments.filter(isImageAttach);
    const fileAttachments = inbound.attachments.filter(isFileLikeAttach);
    if (!inbound.text && imageAttachments.length === 0 && fileAttachments.length === 0) {
        log?.info(`[openclaw-max] skip empty update link=${msg.link?.type ?? "-"} mid=${msg.body?.mid ?? "-"}`);
        return;
    }
    const sender = msg.sender;
    if (!sender)
        return;
    if (sender.is_bot)
        return;
    const chatType = resolveChatType(msg);
    const dialogChatId = String(msg.recipient?.chat_id ?? sender.user_id);
    const chatId = chatType === "direct"
        ? String(sender.user_id)
        : dialogChatId;
    const senderId = String(sender.user_id);
    const senderName = sender.name || sender.username || senderId;
    const messageId = msg.body?.mid ?? `max-${msg.timestamp}`;
    if (chatType === "direct") {
        const allowed = checkDmPolicy(senderId, account);
        if (!allowed) {
            log?.warn(`[openclaw-max] DM from ${senderName} (${senderId}) rejected by policy`);
            return;
        }
    }
    const media = await downloadImages(imageAttachments, account.token, log);
    const savedPaths = saveInboundImages(media.buffers, messageId, log);
    const files = await downloadAndSaveFiles(fileAttachments, account.token, messageId, log);
    let text = inbound.text;
    if (savedPaths.length) {
        const lines = savedPaths.map((p) => `[image: ${p}]`);
        text = text ? `${text}\n${lines.join("\n")}` : lines.join("\n");
    }
    if (files.lines.length) {
        text = text ? `${text}\n${files.lines.join("\n")}` : files.lines.join("\n");
    }
    log?.info(`[openclaw-max] Message from ${senderName} (${senderId}): ${text.slice(0, 80)} media=${imageAttachments.length} url=${media.urlCount} preview=${media.previewCount} downloaded=${media.images.length} saved=${savedPaths.length} files=${fileAttachments.length} fileSaved=${files.saved} fileFailed=${files.failed}`);
    try {
        await deliver({
            text,
            senderId,
            senderName,
            chatId,
            dialogChatId,
            chatType,
            messageId,
            accountId: account.accountId,
            images: media.images.length > 0 ? media.images : undefined,
        });
    }
    catch (err) {
        log?.error(`[openclaw-max] Deliver error: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function checkDmPolicy(userId, account) {
    const policy = account.dmPolicy;
    if (policy === "disabled")
        return false;
    if (policy === "open")
        return true;
    if (policy === "allowlist" || policy === "pairing") {
        return account.allowFrom.includes(userId) || account.allowFrom.includes(`max:${userId}`);
    }
    return false;
}
