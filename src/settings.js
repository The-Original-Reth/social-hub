// Settings saved from the website (Accounts page). A value saved here wins over the same setting in .env;
// clearing it falls back to .env again. Secrets are stored on the server only and never sent back to the browser.
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';

const KEY = 'settings';
const PRIVACY_LEVELS = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'];

// name -> { env: value from .env at startup, secret?, type? }
const e = process.env;
const FIELDS = {
  dryRun: { env: config.dryRun, type: 'bool' },
  metaAppId: { env: e.META_APP_ID || '' },
  metaAppSecret: { env: e.META_APP_SECRET || '', secret: true },
  metaConfigId: { env: e.META_LOGIN_CONFIG_ID || '' },
  facebookPageId: { env: config.facebook.pageId },
  facebookPageName: { env: '' },
  facebookPageToken: { env: config.facebook.pageToken, secret: true },
  instagramUserId: { env: config.instagram.userId },
  instagramUsername: { env: '' },
  tiktokClientKey: { env: config.tiktok.clientKey },
  tiktokClientSecret: { env: config.tiktok.clientSecret, secret: true },
  tiktokPrivacyLevel: { env: config.tiktok.privacyLevel, type: 'privacy' },
};
const envInstagramToken = e.INSTAGRAM_ACCESS_TOKEN || '';

const saved = () => kvGet(KEY) || {};

/** The value in effect for a setting: the website's if it has one, otherwise .env's. */
export function get(name) {
  const s = saved();
  return Object.hasOwn(s, name) && s[name] !== '' ? s[name] : FIELDS[name].env;
}

/** Copy the effective settings into `config`, which the publishers read each time they post. */
export function apply() {
  config.dryRun = get('dryRun');
  config.meta = { appId: get('metaAppId'), appSecret: get('metaAppSecret'), configId: get('metaConfigId') };
  config.facebook.pageId = get('facebookPageId');
  config.facebook.pageToken = get('facebookPageToken');
  config.facebookPageName = get('facebookPageName');
  config.instagram.userId = get('instagramUserId');
  config.instagramUsername = get('instagramUsername');
  // A Page token for the Page linked to the Instagram account works for Instagram too.
  const webPageToken = saved().facebookPageToken;
  config.instagram.token = webPageToken || envInstagramToken || config.facebook.pageToken;
  config.tiktok.clientKey = get('tiktokClientKey');
  config.tiktok.clientSecret = get('tiktokClientSecret');
  config.tiktok.privacyLevel = get('tiktokPrivacyLevel');
}

function clean(name, value) {
  const f = FIELDS[name];
  if (!f) throw Object.assign(new Error(`Unknown setting: ${name}`), { status: 400 });
  if (value === null) return null; // null = clear the website value
  if (f.type === 'bool') {
    if (typeof value !== 'boolean') throw Object.assign(new Error(`${name} must be true or false.`), { status: 400 });
    return value;
  }
  const v = String(value).trim();
  if (v.length > 2000) throw Object.assign(new Error(`${name} is too long.`), { status: 400 });
  if (f.type === 'privacy' && v && !PRIVACY_LEVELS.includes(v)) throw Object.assign(new Error('Unknown TikTok privacy level.'), { status: 400 });
  if (/Id$/.test(name) && v && !/^[\w.-]+$/.test(v)) throw Object.assign(new Error(`${name} has unexpected characters.`), { status: 400 });
  return v;
}

/** Save some settings. A secret sent as '' is left unchanged (the form leaves it blank); null clears any setting. */
export function update(patch) {
  const next = { ...saved() };
  for (const [name, raw] of Object.entries(patch || {})) {
    const v = clean(name, raw);
    if (v === null) { delete next[name]; continue; }
    if (FIELDS[name].secret && v === '') continue;
    next[name] = v;
  }
  kvSet(KEY, next);
  apply();
}

/** What the browser may see: plain values, and only whether each secret is set. */
export function publicView() {
  const s = saved();
  const out = {};
  for (const [name, f] of Object.entries(FIELDS)) {
    const fromWeb = Object.hasOwn(s, name) && s[name] !== '';
    const value = get(name);
    out[name] = f.secret
      ? { set: Boolean(value), source: fromWeb ? 'web' : value ? 'env' : '' }
      : { value, source: fromWeb ? 'web' : value !== '' && value !== undefined ? 'env' : '' };
  }
  out.privacyLevels = PRIVACY_LEVELS;
  out.metaRedirectUri = `${config.publicBaseUrl}/auth/meta/callback`;
  out.tiktokRedirectUri = config.tiktok.redirectUri;
  return out;
}
