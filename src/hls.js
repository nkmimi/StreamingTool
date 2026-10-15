import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { log, sleep, ensureDir } from './util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Resolve a possibly-relative URL against a base. */
function resolve(base, ref) {
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

/** Minimal attribute-list parser for #EXT-X-* tags. */
function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** Fetch with retry/backoff. Returns a Buffer. */
async function fetchBuffer(url, headers, { retries = 4, what = 'resource', signal, control } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (control) { control.throwIfCancelled(); await control.gate(); }
      const res = await fetch(url, { headers, redirect: 'follow', signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const wait = Math.min(8000, 500 * 2 ** attempt);
        log.warn(`${what} failed (${e.message}); retry ${attempt + 1}/${retries} in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`${what} failed after ${retries} retries: ${lastErr?.message}`);
}

/**
 * Fetch and parse an m3u8. If it's a master playlist, pick the best variant.
 * Returns { url, text, isMaster }.
 */
export async function loadPlaylist(url, headers, { signal, control } = {}) {
  const buf = await fetchBuffer(url, headers, { what: 'playlist', signal, control });
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (!isMaster) return { url, text, isMaster: false };

  // Parse variants (STREAM-INF followed by a URI line).
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseAttrs(lines[i].slice(lines[i].indexOf(':') + 1));
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith('#')) {
        variants.push({
          bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
          resolution: attrs.RESOLUTION || '',
          url: resolve(url, uri),
        });
      }
    }
  }
  if (!variants.length) return { url, text, isMaster: true, variants };

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  const best = variants[0];
  log.info(`Master playlist: ${variants.length} variant(s); picking ${best.bandwidth}bps ${best.resolution}`);
  const buf2 = await fetchBuffer(best.url, headers, { what: 'variant playlist', signal, control });
  return { url: best.url, text: buf2.toString('utf8'), isMaster: true, variants, chosen: best };
}

/**
 * Parse a media playlist into { segments, key, map, targetDuration }.
 * `segments` = [{ url, duration, seq }]
 * `key` = { method, uri, iv } | null
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let key = null;
  let map = null;
  let duration = 0;
  let seq = 0;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY')) {
      const a = parseAttrs(line.slice(line.indexOf(':') + 1));
      if (a.METHOD && a.METHOD !== 'NONE') {
        key = {
          method: a.METHOD,
          uri: a.URI ? resolve(baseUrl, a.URI) : null,
          iv: a.IV ? Buffer.from(a.IV.replace(/^0x/i, ''), 'hex') : null,
        };
      } else {
        key = null;
      }
    } else if (line.startsWith('#EXT-X-MAP')) {
      const a = parseAttrs(line.slice(line.indexOf(':') + 1));
      if (a.URI) map = { uri: resolve(baseUrl, a.URI) };
    } else if (line.startsWith('#EXTINF')) {
      duration = parseFloat(line.slice(line.indexOf(':') + 1)) || 0;
    } else if (!line.startsWith('#')) {
      segments.push({ url: resolve(baseUrl, line), duration, seq: mediaSequence + segments.length });
      duration = 0;
    }
  }
  return { segments, key, map };
}

/** Decrypt an AES-128-CBC segment using the playlist key. */
function decryptSegment(data, keyInfo, seq, keyCache) {
  const keyBuf = keyCache.get(keyInfo.uri);
  const iv = keyInfo.iv || (() => {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(seq >>> 0, 12);
    return b;
  })();
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Download all segments of a media playlist into `dir` (as segment-00000.ts …).
 * Returns { files, encrypted }.
 */
export async function downloadSegments(playlist, headers, dir, { concurrency = 8, onProgress, signal, control } = {}) {
  ensureDir(dir);
  const { segments, key } = playlist;
  if (!segments.length) throw new Error('No segments found in playlist');
  log.info(`Downloading ${segments.length} segment(s), concurrency=${concurrency}${key ? ', encrypted' : ''}`);

  const keyCache = new Map();
  if (key) {
    if (!key.uri) throw new Error('Encrypted stream but no key URI');
    const kb = await fetchBuffer(key.uri, headers, { what: 'decryption key', signal, control });
    keyCache.set(key.uri, kb);
  }

  const files = new Array(segments.length);
  let done = 0;
  const total = segments.length;

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= segments.length) return;
      if (control) { control.throwIfCancelled(); await control.gate(); }
      const seg = segments[i];
      const file = path.join(dir, `segment-${String(i).padStart(5, '0')}.ts`);
      if (fs.existsSync(file) && fs.statSync(file).size > 0) {
        files[i] = file;
        done++;
        continue;
      }
      let data = await fetchBuffer(seg.url, headers, { what: `segment ${i}`, signal, control });
      if (key) data = decryptSegment(data, key, seg.seq, keyCache);
      fs.writeFileSync(file, data);
      files[i] = file;
      done++;
      if (done % 20 === 0 || done === total) {
        if (onProgress) onProgress(done, total);
        else log.info(`  ${done}/${total} segments`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));
  return { files, encrypted: !!key };
}
