// Public Terms of Service and Privacy Policy pages (/terms.md, /privacy.md) for app review sites like
// TikTok and Meta. The documents live on GitHub; this server passes them through: it fetches the current
// file from GitHub (at most every 5 minutes) and shows it as a readable page.
// If GitHub can't be reached, it falls back to the last copy it fetched, then to the copy built into
// this server, so the links keep working.
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { config } from './config.js';

const REPO = 'https://github.com/The-Original-Reth/social-hub/blob/main';
const RAW = 'https://raw.githubusercontent.com/The-Original-Reth/social-hub/main';
const REFRESH_MS = 5 * 60_000;

export const LEGAL_PAGES = {
  '/terms.md': { file: 'TERMS.md', title: 'Terms of Service' },
  '/privacy.md': { file: 'PRIVACY.md', title: 'Privacy Policy' },
};

const cache = new Map(); // file -> { markdown, fetchedAt }

async function current(file) {
  const hit = cache.get(file);
  if (hit && Date.now() - hit.fetchedAt < REFRESH_MS) return hit.markdown;
  try {
    const res = await fetch(`${RAW}/${file}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const markdown = await res.text();
    cache.set(file, { markdown, fetchedAt: Date.now() });
    return markdown;
  } catch (err) {
    console.warn(`[legal] couldn't fetch ${file} from GitHub (${err.message}); using ${hit ? 'the last fetched' : 'the built-in'} copy`);
    if (hit) { hit.fetchedAt = Date.now() - REFRESH_MS + 60_000; return hit.markdown; } // retry in a minute
    return fs.readFileSync(path.join(config.root, file), 'utf8');
  }
}

function page(title, file, markdown) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Social Hub ${title}</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --bg: #ffffff; --link: #0969da; --code: #f6f8fa; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --bg: #0d1117; --link: #4493f8; --code: #151b23; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.9em; line-height: 1.25; margin: 0 0 .4em; }
  h2 { font-size: 1.3em; margin: 1.8em 0 .5em; padding-bottom: .25em; border-bottom: 1px solid var(--border); }
  a { color: var(--link); }
  code { background: var(--code); padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; vertical-align: top; }
  th { background: var(--code); }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: .9em; }
</style></head>
<body><main>
${marked.parse(markdown)}
<footer>Source: <a href="${REPO}/${file}">${REPO.replace('https://', '')}/${file}</a>, where its full change history is available.</footer>
</main></body></html>`;
}

export async function legalPage(req, res) {
  const { file, title } = LEGAL_PAGES[req.path];
  try {
    res.type('html').set('Cache-Control', 'public, max-age=300').send(page(title, file, await current(file)));
  } catch {
    res.redirect(302, `${REPO}/${file}`);
  }
}
