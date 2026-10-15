import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, exec } from 'node:child_process';
import net from 'node:net';
import { log, ensureDir } from './util.js';

/**
 * Embedded Caddy streaming-server controller.
 *
 * Serves the download folder (default D:/Videos) over HTTP on the local
 * network, so finished downloads can be streamed to phones/TVs/etc.
 *
 * Configuration (all overridable via env):
 *   CADDY_BIN    path to the caddy binary
 *   CADDYFILE    path to the Caddyfile
 *   CADDY_ADDR   host:port the file server listens on (default :8000)
 *   CADDY_ROOT   document root advertised in the status (default D:/Videos)
 */

const DEFAULT_BIN = 'C:\\Software\\caddy\\caddy_windows_amd64.exe';
const DEFAULT_CADDYFILE = 'C:\\Users\\Guanyi Li\\caddy\\Caddyfile';

export const CADDY_BIN = process.env.CADDY_BIN || DEFAULT_BIN;
export const CADDYFILE = process.env.CADDYFILE || DEFAULT_CADDYFILE;
export const CADDY_ADDR = process.env.CADDY_ADDR || ':8000';
export const CADDY_ROOT = process.env.CADDY_ROOT || process.env.STREAMGRAB_OUT || 'D:/Videos';

/** True when the user pinned the address explicitly (no auto-fallback). */
const ADDR_PINNED = !!process.env.CADDY_ADDR;

/** Ports to try, in order, when :8000 is busy (only if not pinned). */
const FALLBACK_PORTS = [8001, 8080, 8888, 9000];

/** Parse ":8000" / "127.0.0.1:8000" / "8000" into a numeric port. */
function portOf(addr) {
  const m = String(addr).trim().match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 8000;
}

export const CADDY_PORT = portOf(CADDY_ADDR);
export const CADDY_URL = `http://127.0.0.1:${CADDY_PORT}`;

/**
 * Build the effective Caddy config path + URL for the current run.
 *
 * Normally we run the user's Caddyfile as-is. But if the preferred port is
 * occupied by a *non-Caddy* service and the user did not pin CADDY_ADDR, we
 * rewrite the site address to a free port into a temp Caddyfile so the server
 * still comes up. Returns { caddyfile, addr, port, url, generated }.
 */
async function resolveConfig() {
  const busy = async (port) => (await probeHttp(500, `http://127.0.0.1:${port}`)).statusCode != null;

  if (ADDR_PINNED || !(await busy(CADDY_PORT))) {
    return { caddyfile: CADDYFILE, addr: CADDY_ADDR, port: CADDY_PORT, url: CADDY_URL, generated: false };
  }

  for (const p of FALLBACK_PORTS) {
    if (await busy(p)) continue;
    const src = fs.readFileSync(CADDYFILE, 'utf8');
    const addr = `:${p}`;
    // Replace the site-address token for the busy site (e.g. ":8000").
    const rewritten = src.replace(new RegExp(`^:${CADDY_PORT}\\b`, 'm'), addr);
    const tmp = path.join(os.tmpdir(), `streamgrab-caddy-${p}.Caddyfile`);
    fs.writeFileSync(tmp, rewritten, 'utf8');
    pushLog(`[info] ${CADDY_ADDR} busy; using fallback ${addr} via ${tmp}`);
    return { caddyfile: tmp, addr, port: p, url: `http://127.0.0.1:${p}`, generated: true };
  }

  // Nothing free — fall back to the preferred address and let start() report it.
  return { caddyfile: CADDYFILE, addr: CADDY_ADDR, port: CADDY_PORT, url: CADDY_URL, generated: false };
}

/** Best-effort check: can we bind this port right now? */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, '0.0.0.0'); } catch { resolve(false); }
  });
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let startedAt = 0;
let lastExit = null;
/** Effective config chosen by resolveConfig() at start time. */
let effective = { caddyfile: CADDYFILE, addr: CADDY_ADDR, port: CADDY_PORT, url: CADDY_URL, generated: false };
const LOG_MAX = 400;
const logLines = [];

function pushLog(line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (!l) continue;
    logLines.push(l);
    if (logLines.length > LOG_MAX) logLines.shift();
  }
}

function caddyBinExists() {
  try { return fs.existsSync(CADDY_BIN); } catch { return false; }
}
function caddyfileExists() {
  try { return fs.existsSync(CADDYFILE); } catch { return false; }
}

/**
 * HTTP probe: is a *Caddy* server answering on the server URL?
 * Returns { up, server, statusCode } — `up` is true only when the
 * responder identifies itself as Caddy (Server header starts with "Caddy"),
 * so an unrelated service on the same port isn't mistaken for ours.
 */
function probeHttp(timeoutMs = 700, url = effective.url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const server = String(res.headers.server || '');
      res.resume();
      resolve({
        up: /^caddy/i.test(server),
        server: server || null,
        statusCode: res.statusCode ?? null,
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ up: false, server: null, statusCode: null, timeout: true }); });
    req.on('error', () => resolve({ up: false, server: null, statusCode: null }));
  });
}

/** True if we own a live child process. */
function ownsLiveChild() {
  return !!child && child.exitCode == null && !child.killed;
}

/**
 * Kill any process listening on CADDY_PORT (Windows: netstat+taskkill).
 * Only used as a fallback when we know we started the server.
 */
function killPortHolder() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    exec(`netstat -ano -p tcp | findstr :${CADDY_PORT}`, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      const pids = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      if (!pids.size) return resolve(false);
      let left = pids.size;
      let ok = false;
      for (const pid of pids) {
        exec(`taskkill /pid ${pid} /T /F`, (e) => {
          if (!e) ok = true;
          if (--left === 0) resolve(ok);
        });
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Current status snapshot. */
export async function status() {
  const owned = ownsLiveChild();
  const probe = await probeHttp();
  const running = owned || probe.up;
  // Something answers on our port but isn't Caddy → report the conflict.
  const conflict = !running && probe.statusCode != null
    ? { server: probe.server, statusCode: probe.statusCode }
    : null;
  return {
    running,
    owned,
    conflict,
    pid: owned ? child.pid : null,
    addr: effective.addr,
    url: effective.url,
    port: effective.port,
    generatedConfig: effective.generated,
    preferredAddr: CADDY_ADDR,
    root: CADDY_ROOT,
    caddyfile: effective.caddyfile,
    binary: CADDY_BIN,
    binaryExists: caddyBinExists(),
    caddyfileExists: caddyfileExists(),
    uptimeMs: owned && startedAt ? Date.now() - startedAt : 0,
    lastExit,
    recentLog: logLines.slice(-40),
  };
}

/**
 * Start the server. Throws if already running or the config/binary is missing.
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress]  Called with human-readable status lines
 *   as startup proceeds (config resolution, spawn, readiness polling).
 */
export async function start({ onProgress } = {}) {
  const say = (m) => { try { onProgress?.(m); } catch {} pushLog(m); };

  if (ownsLiveChild()) {
    say('Already running (managed by this process).');
    return { started: false, reason: 'already-running', status: await status() };
  }
  {
    say(`Resolving Caddy config (preferred ${CADDY_ADDR})…`);
    effective = await resolveConfig();
    if (effective.generated) say(`Preferred port busy — using fallback ${effective.addr}.`);
    const p = await probeHttp();
    if (p.up) {
      say(`A Caddy server is already listening on ${effective.url}.`);
      return { started: false, reason: 'already-listening', status: await status() };
    }
    // Port is taken by a non-Caddy service → if we couldn't find a fallback,
    // fail early with a clear message.
    if (p.statusCode != null) {
      throw new Error(
        `Port ${effective.port} is already in use by another service (Server: ${p.server || 'unknown'}). ` +
        `Stop it, or set CADDY_ADDR to a free port.`
      );
    }
  }
  if (!caddyBinExists()) throw new Error(`Caddy binary not found: ${CADDY_BIN}`);
  if (!fs.existsSync(effective.caddyfile)) throw new Error(`Caddyfile not found: ${effective.caddyfile}`);

  lastExit = null;
  logLines.length = 0;
  const args = ['run', '--config', effective.caddyfile, '--adapter', 'caddyfile'];
  say(`$ ${CADDY_BIN} ${args.join(' ')}`);

  child = spawn(CADDY_BIN, args, {
    cwd: path.dirname(effective.caddyfile),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedAt = Date.now();
  say(`Spawned Caddy (pid ${child.pid}). Waiting for it to answer on ${effective.url}…`);

  child.stdout.on('data', (d) => pushLog(d.toString()));
  child.stderr.on('data', (d) => pushLog(d.toString()));
  child.on('exit', (code, signal) => {
    lastExit = { code, signal, at: Date.now() };
    pushLog(`[exit] caddy stopped (code=${code}, signal=${signal})`);
    child = null;
    startedAt = 0;
  });
  child.on('error', (e) => pushLog(`[error] ${e.message}`));

  // Wait for it to answer (or die).
  const deadline = Date.now() + 6000;
  let lastTick = 0;
  while (Date.now() < deadline) {
    if ((await probeHttp(400)).up) {
      say(`Server is up at ${effective.url}.`);
      return { started: true, status: await status() };
    }
    if (!ownsLiveChild()) {
      throw new Error(`Caddy exited during startup:\n${logLines.slice(-10).join('\n')}`);
    }
    const waited = Date.now() - startedAt;
    if (waited - lastTick >= 1000) { lastTick = waited; say(`Still starting… (${(waited / 1000).toFixed(1)}s)`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  say('Server started but is slow to respond.');
  return { started: true, slow: true, status: await status() };
}

/** Stop the server. Only kills a port holder if we own the child. */
export async function stop({ onProgress } = {}) {
  const say = (m) => { try { onProgress?.(m); } catch {} pushLog(m); };

  if (!ownsLiveChild()) {
    const probe = await probeHttp();
    if (!probe.up) { say('Server is not running.'); return { stopped: false, reason: 'not-running', status: await status() };
    }
    // Something else owns the port — don't kill a process we didn't start.
    say('A Caddy server is running but was not started here; leaving it alone.');
    return { stopped: false, reason: 'not-owned', status: await status() };
  }

  const proc = child;
  const pid = proc.pid;
  say(`Stopping Caddy (pid ${pid})…`);
  const dead = new Promise((resolve) => proc.once('exit', () => resolve(true)));

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch (e) {
    pushLog(`[error] stop failed: ${e.message}`);
  }

  const timeout = new Promise((r) => setTimeout(() => r(false), 4000));
  const exited = await Promise.race([dead, timeout]);
  if (ownsLiveChild()) {
    say('Process did not exit in time; forcing…');
    try { proc.kill('SIGKILL'); } catch {}
    await Promise.race([dead, new Promise((r) => setTimeout(() => r(false), 2000))]);
  } else if (exited) {
    say('Caddy stopped.');
  }
  child = null;
  startedAt = 0;
  return { stopped: true, status: await status() };
}

/** Restart the server. */
export async function restart({ onProgress } = {}) {
  const say = (m) => { try { onProgress?.(m); } catch {} pushLog(m); };
  const wasRunning = ownsLiveChild() || (await probeHttp()).up;
  if (wasRunning) {
    say('Restart: stopping the current server first…');
    await stop({ onProgress });
  } else {
    say('Restart: server was not running; starting it now…');
  }
  // Give the OS a moment to release the port.
  say('Waiting for the port to be released…');
  await new Promise((r) => setTimeout(r, 500));
  const res = await start({ onProgress });
  return { ...res, restarted: wasRunning };
}

/** Dispatch an action string from the web UI. */
export async function action(name, opts = {}) {
  switch (name) {
    case 'start': return start(opts);
    case 'stop': return stop(opts);
    case 'restart': return restart(opts);
    case 'status': return { status: await status() };
    default: throw new Error(`Unknown server action: ${name}`);
  }
}

/** Kill the child on process exit (best effort). */
export function dispose() {
  if (ownsLiveChild()) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    } catch {}
  }
}
