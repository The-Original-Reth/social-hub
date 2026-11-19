import { config } from './config.js';
import { db } from './db.js';
import { publishPost, recoverInterrupted } from './publisher.js';

export function tick() {
  const due = db.prepare(`SELECT id FROM posts WHERE status='scheduled' AND scheduled_at <= ?`).all(Date.now());
  for (const { id } of due) {
    // Not awaited: a slow TikTok upload must not hold up other posts.
    publishPost(id).catch((err) => console.error('[scheduler] post', id, err));
  }
}

export function startScheduler() {
  recoverInterrupted();
  tick();
  setInterval(tick, config.schedulerIntervalMs).unref?.();
  console.log(`[scheduler] checking for due posts every ${config.schedulerIntervalMs / 1000}s`);
}
