// @ts-nocheck
/* patched copy of dist webhook-handler.js — do not tsc-overwrite without this marker */
/**
 * Inbound webhook handler for MAX Bot API events.
 * Patched locally:
 *  - unwrap forwarded messages from link.message (body.text is empty)
 *  - pull screenshots from PHOTO/_type, payload.ls, photos, previewData
 *  - save inbound images to ~/.openclaw/media/inbound so view_image sees THIS file
 * Marker: openclaw-max-forward-unwrap
 * Marker: openclaw-max-forward-images
 * Marker: openclaw-max-save-inbound
 *
 * Source: @olegbalbekov/openclaw-max dist/src/webhook-handler.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadFile } from "./client.js";
const MAX_BODY_BYTES = 1_048_576; // 1 MB
const IMAGE_KINDS = new Set(["image", "photo", "sticker"]);
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
function isImageAttach(a) {
    const kind = attachKind(a);
    if (IMAGE_KINDS.has(kind))
        return true;
    const name = String(a?.payload?.filename || a?.payload?.name || a?.fileName || a?.name || "").toLowerCase();
    return kind === "file" && /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name);
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
    return `kind=${attachKind(a) || "-"} keys=${keys || "-"} payloadKeys=${pkeys} hasUrl=${Boolean(imageUrlFromAttach(a))} hasPreview=${Boolean(previewImageFromAttach(a))}`;
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
        const type = attachKind(a) || "file";
        const name = a?.payload?.filename || a?.payload?.name || a?.fileName || a?.name || type;
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
export function createWebhookHandler(deps) {
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
export async function handleUpdate(update, account, deliver, log) {
    const msg = extractMessage(update);
    if (!msg)
        return;
    const inbound = resolveInbound(msg);
    const imageAttachments = inbound.attachments.filter(isImageAttach);
    if (!inbound.text && imageAttachments.length === 0) {
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
    let text = inbound.text;
    if (savedPaths.length) {
        const lines = savedPaths.map((p) => `[image: ${p}]`);
        text = text ? `${text}\n${lines.join("\n")}` : lines.join("\n");
    }
    log?.info(`[openclaw-max] Message from ${senderName} (${senderId}): ${text.slice(0, 80)} media=${imageAttachments.length} url=${media.urlCount} preview=${media.previewCount} downloaded=${media.images.length} saved=${savedPaths.length}`);
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
