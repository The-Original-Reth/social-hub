import path from 'node:path';
import { config } from './config.js';
import { db, getPost } from './db.js';
import { platforms } from './platforms/index.js';

const log = (...a) => console.log(new Date().toISOString(), '[publisher]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function captionFor(post, platform) {
  const o = post.caption_overrides?.[platform];
  return o && o.trim() ? o : post.caption;
}

export function contextFor(post, platform) {
  return {
    caption: captionFor(post, platform),
    mediaType: post.media_type,
    mime: post.media_mime,
    size: post.media_size,
    filePath: post.media_file ? path.join(config.uploadsDir, post.media_file) : null,
    mediaUrl: post.media_file ? `${config.publicBaseUrl}/media/${post.media_file}` : null,
  };
}

/** Returns a list of human-readable problems that would stop this post from publishing. */
export function validatePost(post) {
  const errors = [];
  if (!post.platforms.length) errors.push('Pick at least one platform.');
  for (const id of post.platforms) {
    const p = platforms[id];
    if (!p) { errors.push(`Unknown platform "${id}".`); continue; }
    for (const msg of p.validate(contextFor(post, id))) errors.push(`${p.label}: ${msg}`);
  }
  return errors;
}

export function computeStatus(targets) {
  if (!targets.length) return 'failed';
  const done = targets.filter((t) => t.status === 'published').length;
  if (done === targets.length) return 'published';
  if (done > 0) return 'partial';
  return 'failed';
}

async function publishTarget(post, target) {
  const platform = platforms[target.platform];
  db.prepare(`UPDATE post_targets SET status='publishing', attempts=attempts+1, error=NULL WHERE id=?`).run(target.id);
  try {
    const ctx = contextFor(post, target.platform);
    const problems = platform.validate(ctx);
    if (problems.length) throw new Error(problems.join(' '));
    let result;
    if (config.dryRun) {
      await sleep(800);
      result = { remoteId: `dryrun-${target.platform}-${Date.now()}`, url: null };
      log(`DRY RUN: would post #${post.id} to ${platform.label}`);
    } else {
      const cfg = await platform.checkConfig();
      if (!cfg.ok) throw new Error(cfg.message);
      result = await platform.publish(ctx);
      log(`posted #${post.id} to ${platform.label}: ${result.remoteId}`);
    }
    db.prepare(`UPDATE post_targets SET status='published', remote_id=?, remote_url=?, error=?, published_at=? WHERE id=?`)
      .run(String(result.remoteId ?? ''), result.url ?? null, result.note ?? null, Date.now(), target.id);
  } catch (err) {
    log(`failed #${post.id} on ${platform?.label ?? target.platform}: ${err.message}`);
    db.prepare(`UPDATE post_targets SET status='failed', error=? WHERE id=?`).run(String(err.message).slice(0, 2000), target.id);
  }
}

export async function publishPost(id) {
  // Atomically claim the post so it is never published twice.
  const claim = db.prepare(`UPDATE posts SET status='publishing', updated_at=? WHERE id=? AND status='scheduled'`).run(Date.now(), id);
  if (claim.changes === 0) return;
  const post = getPost(id);
  const todo = post.targets.filter((t) => t.status === 'pending' || t.status === 'failed');
  await Promise.allSettled(todo.map((t) => publishTarget(post, t)));
  const targets = db.prepare('SELECT * FROM post_targets WHERE post_id = ?').all(id);
  db.prepare('UPDATE posts SET status=?, updated_at=? WHERE id=?').run(computeStatus(targets), Date.now(), id);
}

/** A crash mid-publish leaves an unknown state, so mark it failed instead of silently re-posting. */
export function recoverInterrupted() {
  const stuck = db.prepare(`SELECT id FROM posts WHERE status='publishing'`).all();
  for (const { id } of stuck) {
    db.prepare(`UPDATE post_targets SET status='failed', error='Interrupted by a server restart. Check the platform before retrying.'
      WHERE post_id=? AND status='publishing'`).run(id);
    const targets = db.prepare('SELECT * FROM post_targets WHERE post_id = ?').all(id);
    db.prepare('UPDATE posts SET status=? WHERE id=?').run(computeStatus(targets), id);
  }
  if (stuck.length) log(`recovered ${stuck.length} interrupted post(s)`);
}
