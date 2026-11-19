import fs from 'node:fs';
import { config } from '../config.js';

const graph = (host = 'graph.facebook.com') => `https://${host}/${config.graphVersion}`;

export async function graphRequest(url, { method = 'POST', body } = {}, label = 'Facebook') {
  const res = await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error;
    throw new Error(`${label} API: ${e?.error_user_msg || e?.message || `${res.status} ${res.statusText}`}`);
  }
  return json;
}

export default {
  id: 'facebook',
  label: 'Facebook',
  captionLimit: 63206,

  async checkConfig() {
    const { pageId, pageToken } = config.facebook;
    if (!pageId || !pageToken) return { ok: false, message: 'Not connected. Log in with Facebook on the Accounts page.' };
    return { ok: true, message: config.facebookPageName ? `Page: ${config.facebookPageName}` : `Page ${pageId}` };
  },

  validate(ctx) {
    const errors = [];
    if (!ctx.mediaType && !ctx.caption.trim()) errors.push('A text-only post needs a caption.');
    if (ctx.caption.length > this.captionLimit) errors.push(`Caption is over ${this.captionLimit} characters.`);
    return errors;
  },

  async publish(ctx) {
    const { pageId, pageToken } = config.facebook;
    if (!ctx.mediaType) {
      const body = new URLSearchParams({ message: ctx.caption, access_token: pageToken });
      const r = await graphRequest(`${graph()}/${pageId}/feed`, { body });
      return { remoteId: r.id, url: `https://www.facebook.com/${r.id}` };
    }
    const form = new FormData();
    form.set('access_token', pageToken);
    form.set('source', await fs.openAsBlob(ctx.filePath, { type: ctx.mime }), 'upload');
    if (ctx.mediaType === 'image') {
      form.set('message', ctx.caption);
      const r = await graphRequest(`${graph()}/${pageId}/photos`, { body: form });
      const id = r.post_id || r.id;
      return { remoteId: id, url: `https://www.facebook.com/${id}` };
    }
    form.set('description', ctx.caption);
    const r = await graphRequest(`${graph('graph-video.facebook.com')}/${pageId}/videos`, { body: form });
    return { remoteId: r.id, url: `https://www.facebook.com/${pageId}/videos/${r.id}` };
  },
};
