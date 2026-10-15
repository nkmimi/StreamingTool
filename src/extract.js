import { log } from './util.js';

/** Strip surrounding quotes from a config key captured by KEY. */
function stripKey(k) {
  return k.replace(/^["']|["']$/g, '');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Fetch a URL as text with browser-like headers. */
export async function fetchText(url, { referer, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      ...(referer ? { Referer: referer } : {}),
      ...headers,
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { body: await res.text(), finalUrl: res.url, headers: res.headers };
}

/**
 * Extract the inline MacCMS-style `var config = {...}` object from page HTML.
 * The object is JS, not strict JSON (single quotes, trailing commas, bare `cid`),
 * so we locate the `url: [...]` array and scalar keys with regex rather than eval.
 */
export function parsePageConfig(html) {
  // Find `var config = {` ... up to the first top-level `};` after it.
  const start = html.search(/var\s+config\s*=\s*\{/);
  if (start === -1) return null;

  // Grab a generous window and brace-match to find the object end.
  const open = html.indexOf('{', start);
  let depth = 0, end = -1, inStr = null;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const region = html.slice(open, end + 1);

  const cfg = {};
  // Scalars. Keys may be bare (key:), single-quoted ('key':) or
  // double-quoted ("key":) — the site mixes all three.
  const KEY = `["']?[A-Za-z_$][\\w$]*["']?`;
  for (const m of region.matchAll(new RegExp(`(${KEY})\\s*:\\s*'([^']*)'`, 'g'))) cfg[stripKey(m[1])] = m[2];
  for (const m of region.matchAll(new RegExp(`(${KEY})\\s*:\\s*"([^"]*)"`, 'g'))) cfg[stripKey(m[1])] = m[2];
  for (const m of region.matchAll(new RegExp(`(${KEY})\\s*:\\s*(\\d+)\\b`, 'g'))) cfg[stripKey(m[1])] = Number(m[2]);

  // The `url` array (may be `url: [...]` or `'url': [...]`).
  const um = region.match(/['"]?url['"]?\s*:\s*\[([\s\S]*?)\]/);
  if (um) {
    const urls = [...um[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    if (urls.length) cfg.url = urls;
  }
  return cfg;
}

/**
 * Tier-1 extraction: fetch the page and pull stream URLs from the inline config.
 * Returns { streams: string[], title, startkey } or null if not found.
 */
export async function extractFromPage(pageUrl) {
  log.info('Fetching page HTML…');
  const { body } = await fetchText(pageUrl);
  const cfg = parsePageConfig(body);
  if (!cfg || !cfg.url || !cfg.url.length) return null;

  const title = cfg.name || cfg.title || 'video';
  const startkey = Number.isInteger(cfg.startkey) ? cfg.startkey : 0;
  // Reorder so the configured startkey is first, keeping the rest as fallbacks.
  const streams = [...cfg.url.slice(startkey), ...cfg.url.slice(0, startkey)];
  log.info(`Found ${streams.length} stream candidate(s) in inline config (title: ${title})`);
  return { streams, title, startkey };
}
