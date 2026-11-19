import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.uploadsDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'social.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caption TEXT NOT NULL DEFAULT '',
  caption_overrides TEXT NOT NULL DEFAULT '{}',
  media_file TEXT,
  media_type TEXT,
  media_mime TEXT,
  media_size INTEGER,
  media_original_name TEXT,
  scheduled_at INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS post_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  remote_id TEXT,
  remote_url TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  UNIQUE(post_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (
  file TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  original_name TEXT,
  created_at INTEGER NOT NULL
);
`);

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

function hydrate(row) {
  if (!row) return null;
  const targets = db.prepare('SELECT * FROM post_targets WHERE post_id = ? ORDER BY id').all(row.id);
  return {
    ...row,
    caption_overrides: parse(row.caption_overrides, {}),
    media_url: row.media_file ? `/media/${row.media_file}` : null,
    targets,
    platforms: targets.map((t) => t.platform),
  };
}

export const getPost = (id) => hydrate(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));

export function listPosts() {
  return db.prepare(`SELECT * FROM posts ORDER BY COALESCE(scheduled_at, updated_at) DESC LIMIT 500`).all().map(hydrate);
}

export function insertPost(p) {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO posts (caption, caption_overrides, media_file, media_type, media_mime, media_size,
    media_original_name, scheduled_at, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    p.caption, JSON.stringify(p.caption_overrides || {}), p.media_file ?? null, p.media_type ?? null, p.media_mime ?? null,
    p.media_size ?? null, p.media_original_name ?? null, p.scheduled_at ?? null, p.status, now, now);
  const id = Number(r.lastInsertRowid);
  setTargets(id, p.platforms);
  return getPost(id);
}

export function updatePost(id, p) {
  db.prepare(`UPDATE posts SET caption=?, caption_overrides=?, media_file=?, media_type=?, media_mime=?, media_size=?,
    media_original_name=?, scheduled_at=?, status=?, updated_at=? WHERE id=?`).run(
    p.caption, JSON.stringify(p.caption_overrides || {}), p.media_file ?? null, p.media_type ?? null, p.media_mime ?? null,
    p.media_size ?? null, p.media_original_name ?? null, p.scheduled_at ?? null, p.status, Date.now(), id);
  setTargets(id, p.platforms);
  return getPost(id);
}

function setTargets(postId, platforms) {
  const existing = db.prepare('SELECT platform FROM post_targets WHERE post_id = ?').all(postId).map((r) => r.platform);
  for (const pl of existing) if (!platforms.includes(pl)) {
    db.prepare(`DELETE FROM post_targets WHERE post_id = ? AND platform = ? AND status != 'published'`).run(postId, pl);
  }
  for (const pl of platforms) {
    db.prepare('INSERT OR IGNORE INTO post_targets (post_id, platform) VALUES (?, ?)').run(postId, pl);
  }
}

export const deletePost = (id) => db.prepare('DELETE FROM posts WHERE id = ?').run(id);

export const kvGet = (key) => parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value, null);
export const kvSet = (key, value) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
export const kvDelete = (key) => db.prepare('DELETE FROM kv WHERE key = ?').run(key);

export const mediaInUse = (file) => db.prepare('SELECT COUNT(*) AS n FROM posts WHERE media_file = ?').get(file).n > 0;

const mediaRow = (m) => m && { ...m, url: `/media/${m.file}`, used_by: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE media_file = ?').get(m.file).n };
export const listMedia = () => db.prepare('SELECT * FROM media ORDER BY created_at DESC').all().map(mediaRow);
export const getMedia = (file) => mediaRow(db.prepare('SELECT * FROM media WHERE file = ?').get(file));
export const insertMedia = (m) =>
  db.prepare('INSERT INTO media (file, type, mime, size, original_name, created_at) VALUES (?,?,?,?,?,?)')
    .run(m.file, m.type, m.mime, m.size, m.original_name ?? null, Date.now());
export const deleteMedia = (file) => db.prepare('DELETE FROM media WHERE file = ?').run(file);
