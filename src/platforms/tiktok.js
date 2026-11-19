import fs from 'node:fs/promises';
import { config } from '../config.js';
import { kvGet, kvSet, kvDelete } from '../db.js';

const API = 'https://open.tiktokapis.com';
const TOKEN_KEY = 'tiktok_tokens';
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- OAuth ----------

export function authUrl(state) {
  const q = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    scope: 'user.info.basic,video.publish',
    response_type: 'code',
    redirect_uri: config.tiktok.redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`TikTok auth: ${json.error_description || json.error || res.statusText}`);
  const now = Date.now();
  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: now + json.expires_in * 1000,
    refresh_expires_at: now + json.refresh_expires_in * 1000,
    open_id: json.open_id,
    scope: json.scope,
    display_name: kvGet(TOKEN_KEY)?.display_name ?? null,
  };
  kvSet(TOKEN_KEY, tokens);
  return tokens;
}

export async function exchangeCode(code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: config.tiktok.redirectUri });
  try {
    const res = await fetch(`${API}/v2/user/info/?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const json = await res.json();
    if (json.data?.user?.display_name) kvSet(TOKEN_KEY, { ...tokens, display_name: json.data.user.display_name });
  } catch { /* display name is cosmetic */ }
}

export const disconnect = () => kvDelete(TOKEN_KEY);
export const account = () => kvGet(TOKEN_KEY);

async function accessToken() {
  const t = kvGet(TOKEN_KEY);
  if (!t) throw new Error('TikTok is not connected. Click "Connect TikTok".');
  if (Date.now() < t.expires_at - 5 * 60_000) return t.access_token;
  if (Date.now() > t.refresh_expires_at) throw new Error('TikTok login expired. Reconnect TikTok.');
  return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).access_token;
}

async function api(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.error && json.error.code !== 'ok')) {
    throw new Error(`TikTok API: ${json.error?.message || json.error?.code || res.statusText}`);
  }
  return json.data;
}

// TikTok chunk rules: 5–64 MB per chunk, final chunk may hold the remainder (up to 128 MB),
// files up to 64 MB go in a single chunk.
export function chunkPlan(size) {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

export default {
  id: 'tiktok',
  label: 'TikTok',
  captionLimit: 2200,

  async checkConfig() {
    const { clientKey, clientSecret } = config.tiktok;
    if (!clientKey || !clientSecret) return { ok: false, message: 'Add your TikTok app keys below, then connect.' };
    const t = kvGet(TOKEN_KEY);
    if (!t) return { ok: false, message: 'Not connected yet. Click "Connect TikTok".' };
    if (Date.now() > t.refresh_expires_at) return { ok: false, message: 'Login expired. Reconnect TikTok.' };
    return { ok: true, message: t.display_name ? `@${t.display_name}` : 'Connected' };
  },

  validate(ctx) {
    const errors = [];
    if (ctx.mediaType !== 'video') errors.push('Needs a video.');
    else if (!/^video\/(mp4|quicktime|webm)$/.test(ctx.mime)) errors.push('Video must be MP4, MOV or WebM.');
    if (ctx.caption.length > this.captionLimit) errors.push(`Caption is over ${this.captionLimit} characters.`);
    return errors;
  },

  async publish(ctx) {
    const token = await accessToken();
    const creator = await api('/v2/post/publish/creator_info/query/', token, {});
    const privacy = config.tiktok.privacyLevel;
    const allowed = creator.privacy_level_options || [];
    if (!allowed.includes(privacy)) {
      throw new Error(`TikTok privacy "${privacy}" is not allowed for this account. Allowed: ${allowed.join(', ') || 'none'}.`);
    }

    const size = ctx.size;
    const { chunkSize, count } = chunkPlan(size);
    const init = await api('/v2/post/publish/video/init/', token, {
      post_info: { title: ctx.caption, privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count },
    });

    const fh = await fs.open(ctx.filePath, 'r');
    try {
      for (let i = 0; i < count; i++) {
        const start = i * chunkSize;
        const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
        const buf = Buffer.alloc(end - start + 1);
        await fh.read(buf, 0, buf.length, start);
        const res = await fetch(init.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': ctx.mime, 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
          body: buf,
        });
        if (!res.ok) throw new Error(`TikTok upload failed on chunk ${i + 1}/${count}: ${res.status} ${await res.text()}`);
      }
    } finally {
      await fh.close();
    }

    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const s = await api('/v2/post/publish/status/fetch/', token, { publish_id: init.publish_id });
      if (s.status === 'PUBLISH_COMPLETE') {
        const postId = s.publicaly_available_post_id?.[0];
        return { remoteId: postId || init.publish_id };
      }
      if (s.status === 'FAILED') throw new Error(`TikTok rejected the video: ${s.fail_reason || 'unknown reason'}`);
    }
    return { remoteId: init.publish_id, note: 'Uploaded; TikTok was still processing after 10 minutes.' };
  },
};
