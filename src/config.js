import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const e = process.env;
const port = Number(e.PORT || 3000);
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const dataDir = path.resolve(e.DATA_DIR || path.join(root, 'data'));
const publicBaseUrl = (e.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  root,
  port,
  host: e.HOST || '127.0.0.1',
  publicBaseUrl,
  adminUser: e.ADMIN_USER || 'admin',
  adminPassword: e.ADMIN_PASSWORD || '',
  // Dry run is ON unless explicitly turned off, so nothing is posted by accident.
  dryRun: e.DRY_RUN === undefined ? true : truthy(e.DRY_RUN),
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  schedulerIntervalMs: Number(e.SCHEDULER_INTERVAL_MS || 20000),
  maxUploadBytes: Number(e.MAX_UPLOAD_MB || 1024) * 1024 * 1024,
  graphVersion: e.META_GRAPH_VERSION || 'v23.0',
  facebook: {
    pageId: e.FACEBOOK_PAGE_ID || '',
    pageToken: e.FACEBOOK_PAGE_ACCESS_TOKEN || '',
  },
  instagram: {
    userId: e.INSTAGRAM_USER_ID || '',
    // A Page access token for the Page linked to the IG account works here.
    token: e.INSTAGRAM_ACCESS_TOKEN || e.FACEBOOK_PAGE_ACCESS_TOKEN || '',
  },
  tiktok: {
    clientKey: e.TIKTOK_CLIENT_KEY || '',
    clientSecret: e.TIKTOK_CLIENT_SECRET || '',
    redirectUri: e.TIKTOK_REDIRECT_URI || `${publicBaseUrl}/auth/tiktok/callback`,
    // Unaudited TikTok apps may only post as SELF_ONLY (private).
    privacyLevel: e.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY',
  },
};

export const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u);
