import { config, isLocalUrl } from '../config.js';
import { graphRequest } from './facebook.js';

const graph = () => `https://graph.facebook.com/${config.graphVersion}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ig = (url, opts) => graphRequest(url, opts, 'Instagram');

export default {
  id: 'instagram',
  label: 'Instagram',
  captionLimit: 2200,

  async checkConfig() {
    const { userId, token } = config.instagram;
    if (!userId || !token) return { ok: false, message: 'Not connected. Choose a Facebook Page that has an Instagram business or creator account linked.' };
    if (isLocalUrl(config.publicBaseUrl)) {
      return { ok: false, message: 'Instagram downloads media from a public https address. Set up the Cloudflare Tunnel first (see the README).' };
    }
    return { ok: true, message: config.instagramUsername ? `@${config.instagramUsername}` : `IG user ${userId}` };
  },

  validate(ctx) {
    const errors = [];
    if (!ctx.mediaType) errors.push('Needs a photo or video.');
    if (ctx.mediaType === 'image' && ctx.mime !== 'image/jpeg') errors.push('Photos must be JPEG.');
    if (ctx.caption.length > this.captionLimit) errors.push(`Caption is over ${this.captionLimit} characters.`);
    if ((ctx.caption.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) errors.push('No more than 30 hashtags.');
    return errors;
  },

  async publish(ctx) {
    const { userId, token } = config.instagram;
    const params = { caption: ctx.caption, access_token: token };
    if (ctx.mediaType === 'image') params.image_url = ctx.mediaUrl;
    else Object.assign(params, { media_type: 'REELS', video_url: ctx.mediaUrl, share_to_feed: 'true' });

    const container = await ig(`${graph()}/${userId}/media`, { body: new URLSearchParams(params) });

    // Wait for Instagram to download and process the media (videos can take minutes).
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const s = await ig(`${graph()}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`, { method: 'GET' });
      if (s.status_code === 'FINISHED') break;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram processing failed: ${s.status || s.status_code}`);
      if (Date.now() > deadline) throw new Error('Instagram took more than 10 minutes to process the media.');
      await sleep(5000);
    }

    const pub = await ig(`${graph()}/${userId}/media_publish`, {
      body: new URLSearchParams({ creation_id: container.id, access_token: token }),
    });
    let url = null;
    try {
      const m = await ig(`${graph()}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(token)}`, { method: 'GET' });
      url = m.permalink || null;
    } catch { /* permalink is nice-to-have */ }
    return { remoteId: pub.id, url };
  },
};
