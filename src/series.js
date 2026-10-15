import { log, safeName } from './util.js';
import { fetchText } from './extract.js';

/**
 * Parse a MacCMS-style episode page HTML into { title, total, episodes }.
 *
 * - title: drama name (from .player-container .title, fallback to <title>).
 * - episodes: [{ index, url }] sorted ascending, absolutized against the page.
 * - total: episode count from the "47集全"/"更新至47集" badge, if found.
 */
export function parseSeries(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const abs = (href) => {
    try { return new URL(href, pageUrl).toString(); } catch { return href; }
  };

  // ---- Title -------------------------------------------------------------
  let title = null;
  const pc = html.indexOf('player-container');
  if (pc !== -1) {
    const slice = html.slice(pc, pc + 4000);
    const m = slice.match(/<div[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([^<]+)<\/div>/);
    if (m) title = m[1].trim();
  }
  if (!title) {
    const t = html.match(/<title>([^<]*)<\/title>/);
    if (t) title = t[1].replace(/\s*第\s*\d+\s*集.*$/, '').trim();
  }
  title = safeName(title || 'video');

  // ---- Episode count badge (optional; used to sanity-check) --------------;
  let total = null;
  const badge = html.match(/(\d+)\s*集全/) || html.match(/更新至\s*(\d+)\s*集/);
  if (badge) total = parseInt(badge[1], 10);

  // ---- Episode anchors ---------------------------------------------------
  // Collect ALL anchors whose class contains "box-anthology-item" (the first
  // container only shows 18 inline; the full list appears later on the page).
  const episodes = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*class="[^"]*\bbox-anthology-item\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const tag = m[0];
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    // Episode number: prefer the <span class="box-stage">NN</span>, else the
    // -<n>.html suffix of the href.
    let num = null;
    const stage = m[1].match(/box-stage[^>]*>\s*(\d+)\s*</);
    if (stage) num = parseInt(stage[1], 10);
    if (num == null) {
      const hm = href.match(/-(\d+)\.html(?:$|[?#])/);
      if (hm) num = parseInt(hm[1], 10);
    }
    if (num == null) continue;
    const url = abs(href);
    if (seen.has(num)) continue;
    seen.add(num);
    episodes.push({ index: num, url });
  }

  episodes.sort((a, b) => a.index - b.index);
  return { title, total, episodes };
}

/**
 * Fetch a page and discover its series metadata.
 * Returns { title, total, episodes }.
 */
export async function discoverSeries(pageUrl, emit = log.info) {
  emit('Fetching page to discover episodes…');
  const { body } = await fetchText(pageUrl);
  const info = parseSeries(body, pageUrl);
  if (!info.episodes.length) {
    // Fall back: the requested page itself is the only known episode.
    emit('No episode list found; falling back to the single page URL.');
    info.episodes = [{ index: 1, url: pageUrl }];
  }
  if (info.total && info.total !== info.episodes.length) {
    emit(`Badge says ${info.total} episodes, found ${info.episodes.length} links.`);
  }
  emit(`Series: ${info.title} — ${info.episodes.length} episode(s)`);
  return info;
}
