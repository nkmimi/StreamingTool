import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

/** Simple leveled logger. */
export const log = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: (...a) => { if (process.env.DEBUG) console.log('[debug]', ...a); },
};

/** Ensure a directory exists. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Sanitize a string for use as a filename. */
export function safeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

/** Sleep helper. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Locate an ffmpeg binary.
 * 1. FFMPEG env var
 * 2. Playwright's bundled ffmpeg under ms-playwright
 * 3. system PATH (`ffmpeg`)
 * Returns an absolute path or the bare name 'ffmpeg'.
 */
export function findFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;

  // 1. ffmpeg-static: a full build (concat + mpegts + mp4) shipped via npm.
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed */ }

  // 2. A real ffmpeg on PATH; Playwright's bundled build is reduced
  // (no concat support) and only used as a last resort.
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  const first = (onPath.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (first && fs.existsSync(first)) return first;

  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  roots.push(path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'));
  roots.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  roots.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'));

  const names = ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg.exe', 'ffmpeg'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith('ffmpeg')) continue;
      const dir = path.join(root, entry);
      for (const n of names) {
        const p = path.join(dir, n);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return 'ffmpeg'; // hope it's on PATH
}

/**
 * Parse an episode-selection spec into a sorted array of 1-based indices.
 *
 *   undefined / ''      -> [] (caller treats empty as "all")
 *   '5'                 -> [5]
 *   '1,3,7'             -> [1,3,7]
 *   '1-10'              -> [1..10]
 *   '1-5,8,12-15'       -> [1,2,3,4,5,8,12,13,14,15]
 *
 * `max` (when given) clamps/validates the range: out-of-bounds entries are
 * dropped with a warning. Returns a de-duplicated, ascending array.
 */
export function parseEpisodeSelection(spec, max = Infinity, emit = log.warn) {
  if (spec == null || spec === '') return [];
  const out = new Set();
  for (const rawPart of String(spec).split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10);
      let b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = parseInt(part, 10);
      if (Number.isFinite(n)) out.add(n);
      else emit(`Ignoring invalid episode spec: "${part}"`);
    }
  }
  let list = [...out].filter((n) => n >= 1);
  if (Number.isFinite(max)) {
    const dropped = list.filter((n) => n > max);
    if (dropped.length) emit(`Ignoring out-of-range episode(s): ${dropped.join(',')} (max ${max})`);
    list = list.filter((n) => n <= max);
  }
  return list.sort((a, b) => a - b);
}

/** Zero-pad an episode number to `width` digits (e.g. 3, 2 -> "03"). */
export function padEpisode(n, width) {
  return String(n).padStart(width, '0');
}

/** Run a child process, inheriting stdio. Returns exit code. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return r.status ?? 1;
}

/** Format bytes. */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)}${u[i]}`;
}
