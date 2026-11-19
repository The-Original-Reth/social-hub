import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, isLocalUrl } from './config.js';
import * as store from './db.js';
import { platforms } from './platforms/index.js';
import * as tiktok from './platforms/tiktok.js';
import { validatePost } from './publisher.js';
import { startScheduler, tick } from './scheduler.js';
import * as settings from './settings.js';
import * as meta from './meta.js';

settings.apply();

const app = express();
app.disable('x-powered-by');

// ---------- Home network only ----------
// Requests from the internet arrive through the Cloudflare Tunnel. They may only reach what the networks
// themselves need: uploaded media (Instagram downloads it) and the login return pages (TikTok, Facebook).
// Everything else, including the website, only works on the home network.
const INTERNET_ALLOWED = /^\/(media\/[^/]+|healthz|auth\/(tiktok|meta)\/callback)$/;
const publicHost = isLocalUrl(config.publicBaseUrl) ? null : new URL(config.publicBaseUrl).hostname;
const fromInternet = (req) => Boolean(req.get('cf-ray') || req.get('cf-connecting-ip') || (publicHost && req.hostname === publicHost));
app.use((req, res, next) => {
  if (fromInternet(req) && !INTERNET_ALLOWED.test(req.path)) return res.status(404).type('text').send('Not found');
  next();
});

// Health check for Docker; no auth so the container healthcheck can reach it.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Uploaded media must be public: Instagram's servers download it from PUBLIC_BASE_URL.
// File names are random UUIDs, so they cannot be guessed.
app.use('/media', express.static(config.uploadsDir, { fallthrough: false, maxAge: '1h' }));

// ---------- Basic auth for everything else ----------
const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// Login return pages can't ask for the password (they're opened on the public address).
// They're protected instead by the one-time "state" value created when you clicked Connect.
const OAUTH_CALLBACK = /^\/auth\/(tiktok|meta)\/callback$/;
// Where to send you back after a login: the home-network address you started from.
const homeOrigin = (req) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  return isLocalUrl(origin) ? origin : '';
};
const backHome = (res, saved, message) =>
  res.redirect(`${saved?.home || ''}/?notice=${encodeURIComponent(message)}#accounts`);

app.use((req, res, next) => {
  if (!config.adminPassword || OAUTH_CALLBACK.test(req.path)) return next();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(user, config.adminUser) && safeEqual(rest.join(':'), config.adminPassword)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Social Hub"').status(401).send('Authentication required');
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(config.root, 'public')));

// ---------- Status ----------
app.get('/api/status', async (_req, res) => {
  const list = [];
  for (const p of Object.values(platforms)) {
    const c = await p.checkConfig();
    list.push({ id: p.id, label: p.label, captionLimit: p.captionLimit, ready: c.ok, message: c.message });
  }
  res.json({
    dryRun: config.dryRun,
    publicBaseUrl: config.publicBaseUrl,
    publicUrlIsLocal: isLocalUrl(config.publicBaseUrl),
    tiktokConfigured: Boolean(config.tiktok.clientKey && config.tiktok.clientSecret),
    metaConfigured: Boolean(config.meta.appId && config.meta.appSecret),
    metaPendingPages: meta.pendingPages(),
    settings: settings.publicView(),
    platforms: list,
  });
});

// ---------- Settings (Accounts page) ----------
app.put('/api/settings', (req, res) => {
  try {
    settings.update(req.body);
    res.json(settings.publicView());
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// ---------- Media library ----------
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + (EXT[file.mimetype] || '')),
  }),
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => cb(EXT[file.mimetype] ? null : new Error(`Unsupported file type ${file.mimetype}`), Boolean(EXT[file.mimetype])),
});

app.get('/api/media', (_req, res) => res.json(store.listMedia()));

app.post('/api/media', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const f = req.file;
  store.insertMedia({ file: f.filename, type: f.mimetype.split('/')[0], mime: f.mimetype, size: f.size, original_name: f.originalname });
  res.status(201).json(store.getMedia(f.filename));
});

app.delete('/api/media/:file', (req, res) => {
  const m = store.getMedia(req.params.file);
  if (!m) return res.status(404).json({ error: 'Not found.' });
  if (m.used_by > 0) return res.status(409).json({ error: `Used by ${m.used_by} post(s). Delete or change those posts first.` });
  store.deleteMedia(m.file);
  fs.rm(path.join(config.uploadsDir, m.file), { force: true }, () => {});
  res.status(204).end();
});

// ---------- Posts ----------
const EDITABLE = new Set(['draft', 'pending_approval', 'scheduled', 'failed', 'partial']);
const MINUTE = 60_000;

function buildPost(body) {
  const ids = Array.isArray(body.platforms) ? body.platforms.filter((p) => platforms[p]) : [];
  const overrides = {};
  for (const id of ids) if (typeof body.caption_overrides?.[id] === 'string') overrides[id] = body.caption_overrides[id];
  let media = {};
  if (body.media_file) {
    const m = store.getMedia(body.media_file);
    if (!m) throw Object.assign(new Error('That media file no longer exists.'), { status: 400 });
    media = { media_file: m.file, media_type: m.type, media_mime: m.mime, media_size: m.size, media_original_name: m.original_name };
  }
  const at = body.scheduled_at ? Number(body.scheduled_at) : null;
  return { caption: String(body.caption ?? ''), caption_overrides: overrides, platforms: ids, scheduled_at: Number.isFinite(at) ? at : null, ...media };
}

/** Maps a composer action to a status, checking the post can actually go out. */
function applyAction(post, action) {
  if (action === 'draft') return { ...post, status: 'draft' };
  const errors = validatePost(post);
  if (errors.length) throw Object.assign(new Error(errors.join('\n')), { status: 422, errors });
  if (action === 'now') return { ...post, status: 'scheduled', scheduled_at: Date.now() };
  if (!post.scheduled_at) throw Object.assign(new Error('Pick a date and time.'), { status: 422 });
  if (post.scheduled_at < Date.now() - MINUTE) throw Object.assign(new Error('That time is in the past.'), { status: 422 });
  if (action === 'submit') return { ...post, status: 'pending_approval' };
  if (action === 'schedule') return { ...post, status: 'scheduled' };
  throw Object.assign(new Error(`Unknown action "${action}".`), { status: 400 });
}

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (err) {
    res.status(err.status || 500).json({ error: err.message, errors: err.errors });
  }
};
const loadPost = (req) => {
  const post = store.getPost(Number(req.params.id));
  if (!post) throw Object.assign(new Error('Post not found.'), { status: 404 });
  return post;
};

app.get('/api/posts', (_req, res) => res.json(store.listPosts()));
app.get('/api/posts/:id', wrap((req, res) => res.json(loadPost(req))));

app.post('/api/posts', wrap((req, res) => {
  const post = store.insertPost(applyAction(buildPost(req.body), req.body.action || 'draft'));
  if (post.status === 'scheduled') tick();
  res.status(201).json(post);
}));

app.put('/api/posts/:id', wrap((req, res) => {
  const existing = loadPost(req);
  if (!EDITABLE.has(existing.status)) throw Object.assign(new Error(`A ${existing.status} post can't be edited.`), { status: 409 });
  const post = store.updatePost(existing.id, applyAction(buildPost(req.body), req.body.action || 'draft'));
  if (post.status === 'scheduled') tick();
  res.json(post);
}));

function transition(from, fn) {
  return wrap((req, res) => {
    const post = loadPost(req);
    if (!from.includes(post.status)) throw Object.assign(new Error(`Not allowed while the post is ${post.status}.`), { status: 409 });
    res.json(fn(post) ?? store.getPost(post.id));
  });
}

app.post('/api/posts/:id/approve', transition(['pending_approval'], (post) => {
  const errors = validatePost(post);
  if (errors.length) throw Object.assign(new Error(errors.join('\n')), { status: 422 });
  const at = !post.scheduled_at || post.scheduled_at < Date.now() ? Date.now() : post.scheduled_at;
  store.updatePost(post.id, { ...post, scheduled_at: at, status: 'scheduled' });
  tick();
}));

app.post('/api/posts/:id/reject', transition(['pending_approval', 'scheduled'], (post) => {
  store.updatePost(post.id, { ...post, status: 'draft' });
}));

app.post('/api/posts/:id/publish-now', transition(['draft', 'pending_approval', 'scheduled'], (post) => {
  store.updatePost(post.id, applyAction(post, 'now'));
  tick();
}));

app.post('/api/posts/:id/retry', transition(['failed', 'partial'], (post) => {
  store.db.prepare(`UPDATE post_targets SET status='pending', error=NULL WHERE post_id=? AND status='failed'`).run(post.id);
  store.db.prepare(`UPDATE posts SET status='scheduled', scheduled_at=?, updated_at=? WHERE id=?`).run(Date.now(), Date.now(), post.id);
  tick();
}));

app.post('/api/posts/:id/duplicate', wrap((req, res) => {
  const post = loadPost(req);
  res.status(201).json(store.insertPost({ ...post, scheduled_at: null, status: 'draft' }));
}));

app.delete('/api/posts/:id', wrap((req, res) => {
  const post = loadPost(req);
  if (post.status === 'publishing') throw Object.assign(new Error('Wait for publishing to finish.'), { status: 409 });
  store.deletePost(post.id);
  res.status(204).end();
}));

// ---------- TikTok OAuth ----------
app.get('/auth/tiktok', (req, res) => {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret) return backHome(res, { home: homeOrigin(req) }, 'Save your TikTok Client key and Client secret first.');
  const state = crypto.randomBytes(16).toString('hex');
  store.kvSet('tiktok_oauth_state', { state, at: Date.now(), home: homeOrigin(req) });
  res.redirect(tiktok.authUrl(state));
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const saved = store.kvGet('tiktok_oauth_state');
  if (!saved || saved.state !== req.query.state || Date.now() - saved.at > 15 * MINUTE) {
    return res.status(400).type('text').send('This TikTok login expired or did not match. Start again from Social Hub on your home network.');
  }
  store.kvDelete('tiktok_oauth_state');
  if (req.query.error) return backHome(res, saved, `TikTok: ${req.query.error_description || req.query.error}`);
  try {
    await tiktok.exchangeCode(String(req.query.code));
    backHome(res, saved, 'TikTok connected.');
  } catch (err) {
    backHome(res, saved, err.message);
  }
});

// ---------- Facebook + Instagram ----------
app.get('/auth/meta', (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    const url = meta.authUrl(state);
    store.kvSet('meta_oauth_state', { state, at: Date.now(), home: homeOrigin(req) });
    res.redirect(url);
  } catch (err) { backHome(res, { home: homeOrigin(req) }, err.message); }
});

app.get('/auth/meta/callback', async (req, res) => {
  const saved = store.kvGet('meta_oauth_state');
  if (!saved || saved.state !== req.query.state || Date.now() - saved.at > 15 * MINUTE) {
    return res.status(400).type('text').send('This Facebook login expired or did not match. Start again from Social Hub on your home network.');
  }
  store.kvDelete('meta_oauth_state');
  if (req.query.error) return backHome(res, saved, `Facebook: ${req.query.error_description || req.query.error_reason || req.query.error}`);
  try {
    await meta.fromCode(String(req.query.code));
    backHome(res, saved, 'Facebook login worked. Choose your Page on the Accounts page.');
  } catch (err) {
    backHome(res, saved, err.message);
  }
});

app.post('/api/meta/token', async (req, res) => {
  try { res.json({ pages: await meta.fromUserToken(req.body?.userToken) }); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});
app.post('/api/meta/choose', wrap((req, res) => res.json(meta.choosePage(req.body?.pageId))));
app.post('/api/meta/disconnect', wrap((_req, res) => { meta.disconnect(); res.status(204).end(); }));

app.post('/api/tiktok/disconnect', (_req, res) => { tiktok.disconnect(); res.status(204).end(); });

// ---------- Errors ----------
app.use((err, _req, res, _next) => {
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 400;
  res.status(status).json({ error: err.message });
});

app.listen(config.port, config.host, () => {
  console.log(`Social Hub listening on http://${config.host}:${config.port}`);
  console.log(`Public URL: ${config.publicBaseUrl}${config.dryRun ? '  |  DRY RUN: nothing will really be posted' : ''}`);
  if (!config.adminPassword) console.warn('WARNING: ADMIN_PASSWORD is not set. Anyone who can reach this server can post as you.');
  startScheduler();
});
