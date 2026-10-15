import { log } from './util.js';

/**
 * A cooperative control channel for a running download job.
 *
 *  - `pause()` / `resume()` toggle a gate that workers await between steps,
 *    so in-flight segment fetches finish before the job halts. Because
 *    already-downloaded segments are skipped on disk, resuming is seamless.
 *  - `cancel()` sets an AbortSignal that is checked in hot loops and passed to
 *    `fetch`, so network activity stops immediately and the job throws.
 */
export class DownloadControl {
  constructor() {
    this._paused = false;
    this._cancelled = false;
    this._abort = new AbortController();
    this._resolvers = [];
  }

  get signal() { return this._abort.signal; }
  get paused() { return this._paused; }
  get cancelled() { return this._cancelled; }

  /** Throw a standard error if the job has been cancelled. */
  throwIfCancelled() {
    if (this._cancelled) {
      const e = new Error('cancelled');
      e.cancelled = true;
      throw e;
    }
  }

  /** Block while paused (no-op when running). Resolves early on cancel. */
  async gate() {
    this.throwIfCancelled();
    while (this._paused && !this._cancelled) {
      await new Promise((resolve) => this._resolvers.push(resolve));
    }
    this.throwIfCancelled();
  }

  pause() {
    if (this._cancelled || this._paused) return false;
    this._paused = true;
    return true;
  }

  resume() {
    if (!this._paused) return false;
    this._paused = false;
    const rs = this._resolvers;
    this._resolvers = [];
    for (const r of rs) r();
    return true;
  }

  cancel() {
    if (this._cancelled) return false;
    this._cancelled = true;
    this._paused = false;
    try { this._abort.abort(); } catch {}
    const rs = this._resolvers;
    this._resolvers = [];
    for (const r of rs) r();
    return true;
  }
}
