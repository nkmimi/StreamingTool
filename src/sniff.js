import { chromium } from 'playwright';
import { log } from './util.js';

const STREAM_RE = /\.(m3u8|mpd|mp4)(\?|#|$)/i;
const AD_RE = /(doubleclick|googlesyndication|google-analytics|adsystem|popads|propeller|onclickads|adnxs|taboola)/i;

/**
 * Tier-2 fallback: open the page in Chromium, let the player start, and capture
 * every media request (m3u8/mp4) along with the headers used. Returns
 * { streams: string[], headers } or null.
 */
export async function sniffStream(pageUrl, { headed = false, timeout = 45000 } = {}) {
  log.info('Falling back to Playwright network sniffing…');
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });

  const found = [];
  const seen = new Set();
  let headerSample = null;

  // Block ad domains and close popups to avoid interference.
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (AD_RE.test(u)) return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });
  context.on('page', (p) => {
    // Auto-close popups opened by the page.
    if (p !== context.pages()[0]) p.close().catch(() => {});
  });

  context.on('request', (req) => {
    const u = req.url();
    if (!STREAM_RE.test(u)) return;
    if (u.includes('.ts')) return; // ignore segments; we want the playlist/file
    if (seen.has(u)) return;
    seen.add(u);
    found.push(u);
    if (!headerSample) {
      const h = req.headers();
      headerSample = {
        Referer: h['referer'] || pageUrl,
        'User-Agent': h['user-agent'] || undefined,
        Cookie: h['cookie'] || undefined,
        Origin: h['origin'] || undefined,
      };
      log.info('Captured stream URL:', u);
    }
  });

  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });
    // Try to click common play buttons / the video element to trigger loading.
    await page.waitForTimeout(2500);
    for (const sel of ['.yzmplayer-bezel', '.yzmplayer-play-icon', 'video', '#clickdiv', '.play-btn']) {
      const el = await page.$(sel);
      if (el) { await el.click({ timeout: 2000 }).catch(() => {}); break; }
    }

    const deadline = Date.now() + timeout;
    while (!found.length && Date.now() < deadline) await page.waitForTimeout(500);
  } catch (e) {
    log.warn('Sniff navigation issue:', e.message);
  } finally {
    await browser.close().catch(() => {});
  }

  if (!found.length) return null;
  return { streams: found, headers: headerSample || { Referer: pageUrl } };
}
