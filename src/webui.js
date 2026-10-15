#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runDownload, DEFAULT_OUT } from './downloader.js';
import { DownloadControl } from './control.js';
import * as caddy from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
// LAN access is ON by default: bind to all interfaces but still only accept
// private/LAN source addresses (see isPrivateAddress). Set ALLOW_LAN=0 to
// restrict to this machine only (loopback).
const ALLOW_LAN = !/^(0|false|no|off)$/i.test(process.env.ALLOW_LAN || '');
const HOST = process.env.HOST || (ALLOW_LAN ? '0.0.0.0' : '127.0.0.1');

/** Short git commit hash of the running code (+ "-dirty" if uncommitted changes), or "unknown". */
function gitCommit() {
  const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const hash = git('rev-parse', '--short', 'HEAD');
    return git('status', '--porcelain') ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
}

/** One active job at a time; kept in memory. */
let currentJob = null;

/* ------------------------------------------------------------------ *
 * Local-network-only guard
 * ------------------------------------------------------------------ */

/** Normalize an IPv4-mapped IPv6 address (::ffff:1.2.3.4) to plain IPv4. */
function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

/** IPv4 string → 32-bit int, or null if not an IPv4 literal. */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** True for loopback / RFC1918 / link-local / CGNAT / ULA addresses. */
export function isPrivateAddress(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;

  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    // 0.0.0.0/8 ("this network"), 10/8, 127/8, 169.254/16, 172.16/12,
    // 192.168/16, 100.64/10 (CGNAT).
    const inRange = (base, bits) => (v4 & ~((1 << (32 - bits)) - 1)) >>> 0 === (ipv4ToInt(base) & ~((1 << (32 - bits)) - 1)) >>> 0;
    return (
      inRange('0.0.0.0', 8) ||
      inRange('10.0.0.0', 8) ||
      inRange('127.0.0.0', 8) ||
      inRange('169.254.0.0', 16) ||
      inRange('172.16.0.0', 12) ||
      inRange('192.168.0.0', 16) ||
      inRange('100.64.0.0', 10)
    );
  }

  const lower = ip.toLowerCase();
  // IPv6 loopback, link-local (fe80::/10), unique-local (fc00::/7).
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab]/.test(lower)) return true;   // fe80::/10
  if (/^f[cd]/.test(lower)) return true;      // fc00::/7
  return false;
}

/** Extract the client IP, honoring X-Forwarded-For only for local proxies. */
function clientIp(req) {
  const direct = req.socket?.remoteAddress || '';
  const directNorm = normalizeIp(direct);
  const xff = req.headers['x-forwarded-for'];
  // Trust XFF only when the direct peer is itself on the local network.
  if (xff && isPrivateAddress(directNorm)) {
    const first = String(xff).split(',')[0].trim();
    if (first) return normalizeIp(first);
  }
  return directNorm;
}

/** Broadcast a control-state change to the active job's SSE stream. */
function jobState(job) {
  if (!job) return 'idle';
  return job.control.cancelled ? 'cancelled' : job.control.paused ? 'paused' : 'running';
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * POST /api/download  →  text/event-stream of progress + final result
 * ------------------------------------------------------------------ */
async function handleDownload(req, res) {
  if (currentJob) {
    sendJson(res, 409, { error: 'A download is already running. Wait for it to finish.' });
    return;
  }

  let params;
  try {
    params = JSON.parse((await readBody(req)) || '{}');
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const url = String(params.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    sendJson(res, 400, { error: 'A valid http(s) URL is required' });
    return;
  }

  // Server-Sent Events stream.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const emit = (line) => {
    const msg = String(line ?? '');
    if (msg !== '') send('log', msg);
    else send('log', '');
  };

  // Heartbeat so proxies don't close idle connections during long remuxes.
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);

  // If the client disconnects, cancel the job so it doesn't run orphaned.
  req.on('close', () => {
    if (currentJob && currentJob.res === res) currentJob.control.cancel();
  });

  const control = new DownloadControl();
  const job = { url, startedAt: Date.now(), control, res, send };
  currentJob = job;
  const onState = () => send('state', { state: jobState(job) });

  try {
    const opts = {
      url,
      out: params.out ? String(params.out) : DEFAULT_OUT,
      episodes: params.episodes ? String(params.episodes) : null,
      concurrency: Math.max(1, Math.min(32, parseInt(params.concurrency, 10) || 8)),
      headed: !!params.headed,
      forceSniff: !!params.forceSniff,
      noRemux: !!params.noRemux,
      keepSegments: !!params.keepSegments,
      list: !!params.list,
      control,
      emit,
    };
    onState();
    const result = await runDownload(opts);
    if (result.listOnly) {
      send('result', {
        listOnly: true,
        title: result.title,
        total: result.total,
        outDir: result.outDir,
        width: result.width,
        episodes: result.all,
      });
    } else {
      send('result', {
        listOnly: false,
        title: result.title,
        outDir: result.outDir,
        episodes: result.episodes,
        ok: result.ok,
        failed: result.failed,
        cancelled: result.cancelled,
        remaining: result.remaining,
        outPaths: result.outPaths,
      });
    }
    send('done', { ok: true });
  } catch (e) {
    if (e.cancelled || control.cancelled) {
      send('log', '[warn] Download cancelled.');
      send('done', { ok: false, cancelled: true });
    } else {
      send('log', `[error] ${e.message}`);
      send('result', { error: e.message });
      send('done', { ok: false });
    }
  } finally {
    clearInterval(hb);
    if (currentJob === job) currentJob = null;
    res.end();
  }
}

/* ------------------------------------------------------------------ *
 * POST /api/control  { action: 'pause' | 'resume' | 'cancel' }
 * ------------------------------------------------------------------ */
async function handleControl(req, res) {
  if (!currentJob) { sendJson(res, 409, { error: 'No active download.' }); return; }
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }

  const action = String(body.action || '');
  const c = currentJob.control;
  let changed = false;
  if (action === 'pause') changed = c.pause();
  else if (action === 'resume') changed = c.resume();
  else if (action === 'cancel') changed = c.cancel();
  else { sendJson(res, 400, { error: `Unknown action: ${action}` }); return; }

  const state = jobState(currentJob);
  currentJob.send('state', { state });
  sendJson(res, 200, { ok: true, changed, state });
}

/* ------------------------------------------------------------------ *
 * GET /api/status
 * ------------------------------------------------------------------ */
function handleStatus(res) {
  sendJson(res, 200, {
    busy: !!currentJob,
    state: jobState(currentJob),
    job: currentJob ? { url: currentJob.url, startedAt: currentJob.startedAt } : null,
    cwd: process.cwd(),
    defaultOut: path.resolve(DEFAULT_OUT),
  });
}

/* ------------------------------------------------------------------ *
 * /api/server  →  control the embedded Caddy streaming server
 * ------------------------------------------------------------------ */

/**
 * GET  /api/server  →  current server state (JSON).
 * POST /api/server  →  run an action, streaming progress as text/event-stream.
 *
 * The POST stream emits:
 *   event: log     data: "<progress line>"
 *   event: status  data: { ...status }        (final state after the action)
 *   event: result  data: { ok, action, result }
 *   event: done    data: { ok }               (sentinel; always last)
 * An error is reported as `event: error` followed by `event: done {ok:false}`.
 */
async function handleServer(req, res) {
  if (req.method === 'GET') {
    try {
      sendJson(res, 200, { ok: true, status: await caddy.status() });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }

  const action = String(body.action || 'status');

  // SSE stream so the UI can show progress while Caddy starts/stops.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);

  // Coalesce pushLog lines that the controller emits internally into `log` events.
  const onProgress = (line) => send('log', String(line ?? ''));

  try {
    const result = await caddy.action(action, { onProgress });
    const status = await caddy.status();
    send('result', { ok: true, action, result });
    send('status', status);
    send('done', { ok: true });
  } catch (e) {
    send('log', `[error] ${e.message}`);
    send('error', { error: e.message });
    try { send('status', await caddy.status()); } catch {}
    send('done', { ok: false });
  } finally {
    clearInterval(hb);
    res.end();
  }
}

/* ------------------------------------------------------------------ *
 * GET /  →  the UI
 * ------------------------------------------------------------------ */
const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StreamGrab</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background: #0f1115; color: #e6e6e6; }
  header { padding: 16px 24px; border-bottom: 1px solid #232733; display: flex;
           align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .badge { font-size: 12px; color: #8b93a7; }
  main { max-width: 900px; margin: 0 auto; padding: 24px; }
  label { display: block; font-size: 12px; color: #9aa3b8; margin: 14px 0 6px; }
  input, select { width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #2b3140; background: #171a21; color: #e6e6e6; font-size: 14px; }
  input:focus, select:focus { outline: none; border-color: #4c7dff; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > div { flex: 1 1 160px; }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 14px; color: #c7cddb; }
  .check input { width: auto; }
  .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
  button { padding: 10px 18px; border-radius: 8px; border: 1px solid #2b3140;
    background: #1d2230; color: #e6e6e6; font-size: 14px; cursor: pointer; }
  button.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; font-weight: 600; }
  button.danger { background: #3a1d20; border-color: #7a2b31; color: #ff9aa2; }
  button.warn { background: #3a311d; border-color: #7a6a2b; color: #ffe29a; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .status.running { color: #7fd1a0; }
  .status.paused { color: #ffe29a; }
  .status.cancelled { color: #ff9aa2; }
  pre#log { margin-top: 24px; background: #0b0d12; border: 1px solid #232733; border-radius: 10px;
    padding: 14px; height: 340px; overflow: auto; font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace;
    white-space: pre-wrap; word-break: break-all; }
  .status { font-size: 12px; color: #8b93a7; margin-left: auto; }
  .hint { font-size: 12px; color: #6f778a; margin-top: 6px; }
  fieldset { border: 1px solid #232733; border-radius: 10px; padding: 14px 16px 18px; margin: 24px 0 0; }
  legend { padding: 0 8px; font-size: 12px; color: #9aa3b8; text-transform: uppercase; letter-spacing: .06em; }
  .srv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #6f778a; flex: 0 0 auto; }
  .dot.up { background: #7fd1a0; box-shadow: 0 0 8px #7fd1a0; }
  .dot.down { background: #6f778a; }
  .srv-url { font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #8fb6ff; text-decoration: none; }
  .srv-url:hover { text-decoration: underline; }
  pre#srvlog { margin-top: 12px; background: #0b0d12; border: 1px solid #232733; border-radius: 10px;
    padding: 12px; max-height: 180px; overflow: auto; font: 11px/1.6 ui-monospace, Menlo, Consolas, monospace;
    white-space: pre-wrap; word-break: break-all; color: #9aa3b8; }
</style>
</head>
<body>
<header>
  <h1>StreamGrab</h1>
  <span class="badge">HLS → MP4, driven by Playwright</span>
  <span class="badge" id="build">build —</span>
  <span class="status" id="status">idle</span>
</header>
<main>
  <label for="url">Video / episode page URL</label>
  <input id="url" placeholder="https://www.aiyingshi.tv/play/106159-0-1.html">

  <label for="out">Output folder</label>
  <input id="out" placeholder="D:/Videos  (or another absolute path)">
  <div class="hint">Leave blank to use the default <code>D:/Videos</code> folder.</div>

  <div class="row">
    <div>
      <label for="episodes">Episodes</label>
      <input id="episodes" placeholder="all  |  1-10  |  1,3,7  |  1-5,8,12-15">
    </div>
    <div>
      <label for="concurrency">Concurrency</label>
      <input id="concurrency" type="number" min="1" max="32" value="8">
    </div>
  </div>

  <label class="check"><input type="checkbox" id="headed"> Show browser when sniffing (--headed)</label>
  <label class="check"><input type="checkbox" id="forceSniff"> Force sniffing (skip inline config)</label>
  <label class="check"><input type="checkbox" id="keepSegments"> Keep temp segments</label>

  <div class="actions">
    <button class="primary" id="go">Download</button>
    <button id="list">List episodes only</button>
    <button class="warn" id="pause" disabled>Pause</button>
    <button class="warn" id="resume" disabled>Resume</button>
    <button class="danger" id="cancel" disabled>Cancel</button>
    <button id="clear">Clear log</button>
  </div>

  <pre id="log"></pre>

  <fieldset>
    <legend>Streaming Server (Caddy)</legend>
    <div class="srv-head">
      <span class="dot down" id="srvdot"></span>
      <span id="srvstate">unknown</span>
      <a class="srv-url" id="srvurl" href="#" target="_blank" style="display:none"></a>
      <span class="status" id="srvmeta"></span>
    </div>
    <div class="hint" id="srvhint">Serves the output folder over HTTP on your local network.</div>
    <div class="actions">
      <button class="primary" id="srvstart">Start</button>
      <button class="warn" id="srvstop">Stop</button>
      <button id="srvrestart">Restart</button>
      <button id="srvrefresh">Refresh</button>
    </div>
    <pre id="srvlog"></pre>
  </fieldset>
</main>

<script>
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const statusEl = $('status');
// Build marker: lets you confirm which UI revision the browser actually loaded.
const BUILD = '2026-10-15.1';
$('build').textContent = 'build ' + BUILD;
console.log('[StreamGrab] UI build', BUILD);
let running = false;

function append(line) {
  logEl.textContent += (logEl.textContent ? '\\n' : '') + line;
  logEl.scrollTop = logEl.scrollHeight;
}
function setRunning(v) {
  running = v;
  $('go').disabled = v;
  $('list').disabled = v;
  $('clear').disabled = false;
  if (!v) setState('idle');
}

/** Reflect the job control state on the buttons + status label. */
function setState(state) {
  statusEl.textContent = state;
  statusEl.className = 'status ' + state;
  const active = state === 'running' || state === 'paused';
  $('pause').disabled = !(state === 'running');
  $('resume').disabled = !(state === 'paused');
  $('cancel').disabled = !active;
  $('go').disabled = active;
  $('list').disabled = active;
}

async function control(action) {
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { append('[error] ' + (j.error || ('HTTP ' + res.status))); return; }
    if (j.state) setState(j.state);
    if (action === 'pause') append('[pause] Requested pause; finishing in-flight segments…');
    else if (action === 'resume') append('[resume] Resuming…');
    else if (action === 'cancel') append('[cancel] Cancelling…');
  } catch (e) {
    append('[error] ' + e.message);
  }
}

async function start(listOnly) {
  if (running) return;
  const url = $('url').value.trim();
  if (!url) { append('[error] Please enter a URL'); return; }
  if (!listOnly) logEl.textContent = '';

  const payload = {
    url,
    out: $('out').value.trim() || undefined,
    episodes: $('episodes').value.trim() || undefined,
    concurrency: parseInt($('concurrency').value, 10) || 8,
    headed: $('headed').checked,
    forceSniff: $('forceSniff').checked,
    keepSegments: $('keepSegments').checked,
    list: !!listOnly,
  };

  setRunning(true);
  setState('running');
  append(listOnly ? '> listing episodes…' : '> starting download…');

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      append('[error] ' + (j.error || ('HTTP ' + res.status)));
      setRunning(false);
      return;
    }
    await consumeSSE(res);
  } catch (e) {
    append('[error] ' + e.message);
  } finally {
    setRunning(false);
  }
}

async function consumeSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\\n\\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = 'message', data = '';
      for (const line of raw.split('\\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      if (event === 'log') append(parsed);
      else if (event === 'state') setState(parsed.state);
      else if (event === 'result') onResult(parsed);
    }
  }
}

function onResult(r) {
  if (r.error) { append('[error] ' + r.error); return; }
  if (r.listOnly) {
    append('');
    append(r.title + ' — ' + r.episodes.length + ' episode(s)' + (r.total ? ' (badge: ' + r.total + ')' : ''));
    for (const e of r.episodes) append('  ' + String(e.index).padStart(r.width, '0') + '  ' + e.url);
    return;
  }
  append('');
  if (r.cancelled) {
    append('Cancelled. ' + r.ok + '/' + r.episodes + ' episode(s) completed. → ' + r.outDir);
    if (r.remaining && r.remaining.length) {
      append('Not downloaded: ' + r.remaining.join(', '));
      append('Tip: re-run with episodes "' + r.remaining.join(',') + '" to resume (finished files are skipped on disk).');
    }
    return;
  }
  append('Done. ' + r.ok + '/' + r.episodes + ' episode(s) succeeded. → ' + r.outDir);
  if (r.failed && r.failed.length) append('Failed: ' + r.failed.join(', '));
}

$('go').addEventListener('click', () => start(false));
$('list').addEventListener('click', () => start(true));
$('pause').addEventListener('click', () => control('pause'));
$('resume').addEventListener('click', () => control('resume'));
$('cancel').addEventListener('click', () => control('cancel'));
$('clear').addEventListener('click', () => { logEl.textContent = ''; });
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(false); });

/* ---------------- Streaming server (Caddy) panel ---------------- */
const srvLog = $('srvlog');
let srvBusy = false;
// Last known server state, so button enabling can react to it.
let srvStatus = null;

function srvAppend(line) {
  srvLog.textContent += (srvLog.textContent ? '\\n' : '') + line;
  srvLog.scrollTop = srvLog.scrollHeight;
}

/**
 * Set the busy (in-flight action) flag and re-derive which buttons are
 * usable. While busy, every action button is disabled; otherwise the
 * available actions depend on whether the server is currently running.
 */
function srvSetBusy(v) {
  srvBusy = v;
  srvApplyButtons();
}

/**
 * Enable/disable the server buttons from the current state:
 *   - busy               → all disabled
 *   - running (any owner) → Start disabled, Stop/Restart enabled
 *   - stopped             → Start enabled, Stop disabled, Restart disabled
 * Refresh is always enabled unless busy.
 */
function srvApplyButtons() {
  const running = !!(srvStatus && srvStatus.running);
  const busy = srvBusy;
  $('srvstart').disabled = busy || running;
  $('srvstop').disabled = busy || !running || !srvStatus.owned;
  $('srvrestart').disabled = busy || !running;
  $('srvrefresh').disabled = busy;
  $('srvstart').title = running ? 'Server is already running' : '';
  $('srvstop').title = (!running ? 'Server is not running'
    : (!srvStatus.owned ? 'Server was not started here; cannot stop it' : ''));
}

function renderServer(st) {
  if (st) srvStatus = st;
  const dot = $('srvdot');
  const urlEl = $('srvurl');
  const meta = $('srvmeta');
  const hint = $('srvhint');
  const running = !!(st && st.running);
  dot.className = 'dot ' + (running ? 'up' : 'down');
  $('srvstate').textContent = running
    ? (st.owned ? 'running (managed here)' : 'running (external)')
    : 'stopped';
  if (st && st.url) {
    urlEl.textContent = st.url;
    urlEl.href = st.url;
    urlEl.style.display = '';
  } else {
    urlEl.style.display = 'none';
  }
  if (st) {
    const bits = [];
    if (st.addr) bits.push('addr ' + st.addr);
    if (st.port) bits.push('port ' + st.port);
    if (st.owned) bits.push('pid ' + st.pid);
    if (st.root) bits.push('root ' + st.root);
    meta.textContent = bits.join('  ·  ');
    if (st.generatedConfig) hint.textContent = 'Using a generated Caddyfile (preferred port was busy).';
    else if (st.binaryExists === false) hint.textContent = 'Caddy binary not found at the configured path.';
    else if (st.caddyfileExists === false) hint.textContent = 'Caddyfile not found at the configured path.';
    else hint.textContent = 'Serves the output folder over HTTP on your local network.';
  }
  // NOTE: don't clobber the live progress log here — only seed it when empty.
  if (st && st.recentLog && st.recentLog.length && !srvLog.textContent) {
    srvLog.textContent = st.recentLog.join('\\n');
    srvLog.scrollTop = srvLog.scrollHeight;
  }
  srvApplyButtons();
}

async function srvRefresh() {
  try {
    const res = await fetch('/api/server');
    const j = await res.json();
    if (j.status) renderServer(j.status);
  } catch (e) { srvAppend('[error] ' + e.message); }
}

/** Consume the action's SSE stream, appending progress lines live. */
async function srvConsumeSSE(res, action) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finalStatus = null;
  let result = null;
  let errored = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\\n\\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = 'message', data = '';
      for (const line of raw.split('\\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      if (event === 'log') srvAppend(parsed);
      else if (event === 'status') finalStatus = parsed;
      else if (event === 'result') result = parsed;
      else if (event === 'error') { errored = true; }
    }
  }

  if (result && result.ok) {
    const r = result.result || {};
    if (action === 'start' && r.started) srvAppend('[ok] server started' + (r.slow ? ' (slow to respond)' : ''));
    else if (action === 'start' && r.reason) srvAppend('[info] not started: ' + r.reason);
    else if (action === 'stop') srvAppend(r.stopped ? '[ok] server stopped' : '[info] not stopped: ' + (r.reason || 'not running'));
    else if (action === 'restart' && r.started) srvAppend('[ok] server restarted');
    else if (action === 'restart' && r.reason) srvAppend('[info] not restarted: ' + r.reason);
  } else if (!errored) {
    srvAppend('[warn] action finished without a result');
  }

  if (finalStatus) renderServer(finalStatus);
  else await srvRefresh();
  return !errored;
}

async function srvAction(action) {
  if (srvBusy) return;
  srvSetBusy(true);
  srvAppend('> server ' + action + '…');
  try {
    const res = await fetch('/api/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      srvAppend('[error] ' + (j.error || ('HTTP ' + res.status)));
      await srvRefresh();
      return;
    }
    await srvConsumeSSE(res, action);
  } catch (e) {
    srvAppend('[error] ' + e.message);
    await srvRefresh().catch(() => {});
  } finally {
    srvSetBusy(false);
  }
}

$('srvstart').addEventListener('click', () => srvAction('start'));
$('srvstop').addEventListener('click', () => srvAction('stop'));
$('srvrestart').addEventListener('click', () => srvAction('restart'));
$('srvrefresh').addEventListener('click', () => { srvLog.textContent = ''; srvRefresh(); });

// Buttons start disabled until the first status arrives.
srvApplyButtons();
srvRefresh();
// Keep the panel in sync if the server is started/stopped elsewhere.
setInterval(() => { if (!srvBusy) srvRefresh(); }, 5000);

// Safety net: if a status fetch never lands (e.g. an old cached page talking
// to a newer server), surface it instead of leaving buttons looking inert.
setTimeout(() => {
  if (!srvStatus) {
    srvAppend('[warn] No server status received yet — if buttons look wrong, hard-reload (Ctrl+F5).');
  }
}, 6000);
</script>
</body>
</html>
`;

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  // Local-network-only: reject anything that isn't a private/loopback source.
  const ip = clientIp(req);
  if (!isPrivateAddress(ip)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: this tool is restricted to the local network.\n');
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      // Never let the browser cache the UI: the page embeds its own JS, and a
      // stale copy silently breaks button behavior after an upgrade.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(PAGE);
    } else if (req.method === 'GET' && u.pathname === '/api/status') {
      handleStatus(res);
    } else if (req.method === 'POST' && u.pathname === '/api/download') {
      await handleDownload(req, res);
    } else if (req.method === 'POST' && u.pathname === '/api/control') {
      await handleControl(req, res);
    } else if ((req.method === 'GET' || req.method === 'POST') && u.pathname === '/api/server') {
      await handleServer(req, res);
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else try { res.end(); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`StreamGrab web UI → http://${shown}:${PORT}`);
  console.log(`Commit: ${gitCommit()}`);
  if (ALLOW_LAN) {
    console.log(`LAN access ENABLED (bound to 0.0.0.0). Only private/LAN addresses may connect.`);
  } else {
    console.log(`Local-only (loopback). Set ALLOW_LAN=1 to allow other devices on your LAN.`);
  }
  console.log(`Working dir: ${process.cwd()}`);
  console.log(`Default output: ${path.resolve(DEFAULT_OUT)}`);
});

// Reap the Caddy child (if we started one) on shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { caddy.dispose(); } catch {}
    process.exit(0);
  });
}
process.on('exit', () => { try { caddy.dispose(); } catch {} });
