// Connecting Facebook + Instagram from the website: log in with Facebook (or paste a user token),
// pick a Page, and we keep that Page's never-expiring token plus its linked Instagram account.
import { config } from './config.js';
import { kvGet, kvSet, kvDelete } from './db.js';
import * as settings from './settings.js';

const PENDING = 'meta_pending_pages';
export const SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management';
const graph = () => `https://graph.facebook.com/${config.graphVersion}`;
export const redirectUri = () => `${config.publicBaseUrl}/auth/meta/callback`;

async function get(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`Facebook: ${json.error?.error_user_msg || json.error?.message || res.statusText}`);
  return json;
}

function needApp() {
  const { appId, appSecret } = config.meta;
  if (!appId || !appSecret) throw Object.assign(new Error('Save your Meta App ID and App Secret first.'), { status: 400 });
  return { appId, appSecret };
}

export function authUrl(state) {
  const { appId } = needApp();
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri(), state, response_type: 'code' });
  // "Facebook Login for Business" apps use a configuration ID instead of a scope list.
  if (config.meta.configId) q.set('config_id', config.meta.configId);
  else q.set('scope', SCOPES);
  return `https://www.facebook.com/${config.graphVersion}/dialog/oauth?${q}`;
}

async function longLived(userToken) {
  const { appId, appSecret } = needApp();
  const q = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: userToken });
  return (await get(`${graph()}/oauth/access_token?${q}`)).access_token;
}

/** Find the Pages this user manages and remember them (with tokens) until one is chosen. */
async function loadPages(longUserToken) {
  const fields = 'id,name,access_token,instagram_business_account{id,username}';
  const r = await get(`${graph()}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(longUserToken)}`);
  const pages = (r.data || []).map((p) => ({
    id: p.id, name: p.name, token: p.access_token,
    ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null,
  }));
  if (!pages.length) throw new Error('Facebook returned no Pages. When logging in, make sure you choose your Page and allow all permissions.');
  kvSet(PENDING, { pages, at: Date.now() });
  return pendingPages();
}

export async function fromUserToken(userToken) {
  if (!userToken || !String(userToken).trim()) throw Object.assign(new Error('Paste a user access token.'), { status: 400 });
  return loadPages(await longLived(String(userToken).trim()));
}

export async function fromCode(code) {
  const { appId, appSecret } = needApp();
  const q = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri(), code });
  const short = (await get(`${graph()}/oauth/access_token?${q}`)).access_token;
  return loadPages(await longLived(short));
}

/** Pages waiting to be chosen, without their tokens. Expires after 30 minutes. */
export function pendingPages() {
  const p = kvGet(PENDING);
  if (!p || Date.now() - p.at > 30 * 60_000) return [];
  return p.pages.map(({ id, name, ig }) => ({ id, name, ig }));
}

export function choosePage(pageId) {
  const p = kvGet(PENDING);
  const page = p && Date.now() - p.at <= 30 * 60_000 && p.pages.find((x) => x.id === String(pageId));
  if (!page) throw Object.assign(new Error('That Page is no longer available. Log in with Facebook again.'), { status: 400 });
  settings.update({
    facebookPageId: page.id, facebookPageName: page.name, facebookPageToken: page.token,
    instagramUserId: page.ig?.id ?? null, instagramUsername: page.ig?.username ?? null,
  });
  kvDelete(PENDING);
  return { page: page.name, instagram: page.ig?.username || null };
}

export function disconnect() {
  kvDelete(PENDING);
  settings.update({ facebookPageId: null, facebookPageName: null, facebookPageToken: null, instagramUserId: null, instagramUsername: null });
}
