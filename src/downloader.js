import path from 'node:path';
import fs from 'node:fs';
import { log, ensureDir, parseEpisodeSelection, padEpisode, fmtBytes } from './util.js';
import { discoverSeries } from './series.js';
import { extractFromPage } from './extract.js';
import { sniffStream } from './sniff.js';
import { loadPlaylist, parseMediaPlaylist, downloadSegments } from './hls.js';
import { remux } from './remux.js';

/** Default output folder when none is specified. */
export const DEFAULT_OUT = process.env.STREAMGRAB_OUT || 'D:/Videos';

/** Adapt an `emit(line)` callback into a {info,warn,error} logger. */
function makeLogger(emit) {
  return {
    info: (m) => emit(m),
    warn: (m) => emit(`[warn] ${m}`),
    error: (m) => emit(`[error] ${m}`),
  };
}

/**
 * Probe candidate stream URLs until one yields a valid playlist.
 */
export async function pickStream(streams, headers, emit = log.info, control = null) {
  for (let i = 0; i < streams.length; i++) {
    const url = streams[i];
    try {
      const pl = await loadPlaylist(url, headers, { signal: control?.signal, control });
      emit(`Using stream #${i}: ${url}`);
      return { url, playlist: pl };
    } catch (e) {
      emit(`Candidate #${i} failed: ${e.message}`);
    }
  }
  throw new Error('No working stream found among candidates');
}

/** Resolve stream candidates for one episode page (inline config, then sniff). */
export async function resolveStreams(episodeUrl, opts = {}, emit = log.info) {
  let streams = null;
  let headers = { Referer: episodeUrl };

  if (!opts.forceSniff) {
    try {
      const r = await extractFromPage(episodeUrl);
      if (r) { streams = r.streams; headers = { Referer: episodeUrl }; }
    } catch (e) {
      emit(`Inline extraction failed: ${e.message}`);
    }
  }
  if (!streams) {
    const r = await sniffStream(episodeUrl, { headed: opts.headed });
    if (!r) throw new Error('Could not find any stream (inline config + sniffing both failed)');
    streams = r.streams;
    headers = r.headers || headers;
  }
  return { streams, headers };
}

/** Download a single episode to `series.dir`. Returns the final file path. */
export async function downloadEpisode(ep, { series, opts, tmpBase }, emit = log.info) {
  const control = opts.control;
  if (control) { control.throwIfCancelled(); await control.gate(); }
  const { streams, headers } = await resolveStreams(ep.url, opts, emit);
  const { playlist } = await pickStream(streams, headers, emit, control);
  const media = parseMediaPlaylist(playlist.text, playlist.url || ep.url);
  emit(`Episode ${ep.index}: playlist has ${media.segments.length} segment(s)${media.key ? ' (AES-128 encrypted)' : ''}`);
  if (!media.segments.length) throw new Error(`Episode ${ep.index}: playlist contained no segments`);

  const workDir = path.resolve(tmpBase, `ep${padEpisode(ep.index, 2)}`);
  ensureDir(workDir);
  const { files } = await downloadSegments(media, headers, workDir, {
    concurrency: opts.concurrency,
    signal: control?.signal,
    control,
    onProgress: (done, total) => {
      if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
        emit(`  ${done}/${total} segments`);
      }
    },
  });

  // A cancel during the final remux can't be undone cheaply, but check anyway.
  if (control) control.throwIfCancelled();

  const outPath = path.resolve(series.dir, `${series.title}-第${padEpisode(ep.index, series.width)}集.mp4`);
  const result = remux(files, outPath, { useFfmpeg: !opts.noRemux, log: makeLogger(emit) });
  const size = fs.existsSync(result.outPath) ? fs.statSync(result.outPath).size : 0;
  emit(`✔ Episode ${ep.index} → ${result.outPath} (${fmtBytes(size)})`);

  if (!opts.keepSegments) fs.rmSync(workDir, { recursive: true, force: true });
  return result.outPath;
}

/**
 * Full pipeline: discover the series, resolve an episode selection, then
 * download each selected episode sequentially.
 *
 * @param {object} params
 * @param {string} params.url            Episode/page URL (series entry point).
 * @param {string} [params.out]          Base output dir (default: ./output).
 * @param {string} [params.episodes]     Selection spec, e.g. '1-10' / '1,3,7'.
 * @param {number} [params.concurrency]  Parallel segment downloads.
 * @param {boolean} [params.list]        Only discover + return metadata.
 * @param {function} [params.emit]       Progress callback (defaults to console).
 * @returns {Promise<object>} summary { title, outDir, episodes, ok, failed, outPaths }
 */
export async function runDownload(params) {
  const {
    url,
    out = DEFAULT_OUT,
    episodes = null,
    concurrency = 8,
    headed = false,
    forceSniff = false,
    noRemux = false,
    keepSegments = false,
    workDir = null,
    list = false,
    control = null,
    emit = () => {},
  } = params;

  emit(`Target: ${url}`);

  // ---- 1. Discover the series (title + episodes) -------------------------
  const info = await discoverSeries(url, emit);
  const all = info.episodes;
  const maxEp = all[all.length - 1]?.index ?? 1;
  const width = String(maxEp).length;

  const baseDir = path.resolve(out);
  const seriesDir = path.join(baseDir, info.title);
  const tmpBase = path.resolve(workDir || path.join(seriesDir, '.tmp'));

  if (list) {
    return { title: info.title, total: info.total, outDir: seriesDir, all, width, listOnly: true };
  }

  // ---- 2. Resolve selection ---------------------------------------------
  let indices = parseEpisodeSelection(episodes, maxEp, emit);
  if (!indices.length) indices = all.map((e) => e.index);
  const byIndex = new Map(all.map((e) => [e.index, e]));
  const selected = indices.map((i) => byIndex.get(i)).filter(Boolean);
  if (!selected.length) throw new Error('No valid episodes selected');

  emit(`Downloading ${selected.length} episode(s) of "${info.title}" → ${seriesDir}`);
  ensureDir(seriesDir);

  // ---- 3. Download each episode sequentially ----------------------------
  const series = { title: info.title, dir: seriesDir, width };
  const opts = { concurrency, headed, forceSniff, noRemux, keepSegments, control };
  const ok = [];
  const failed = [];
  const remaining = [];
  let cancelled = false;
  for (const ep of selected) {
    try {
      const p = await downloadEpisode(ep, { series, opts, tmpBase }, emit);
      ok.push(p);
    } catch (e) {
      if (e.cancelled || control?.cancelled) {
        cancelled = true;
        remaining.push(ep.index);
        for (const later of selected) {
          if (later.index > ep.index) remaining.push(later.index);
        }
        emit(`Cancelled during episode ${ep.index}.`);
        break;
      }
      emit(`Episode ${ep.index} failed: ${e.message}`);
      failed.push(ep.index);
    }
  }

  // ---- 4. Summary --------------------------------------------------------
  emit('');
  emit(`Done. ${ok.length}/${selected.length} episode(s) succeeded.`);
  if (failed.length) emit(`Failed episode(s): ${failed.join(', ')}`);
  if (!keepSegments && fs.existsSync(tmpBase)) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }

  return {
    title: info.title,
    outDir: seriesDir,
    episodes: selected.length,
    ok: ok.length,
    failed,
    cancelled,
    remaining,
    outPaths: ok,
    listOnly: false,
  };
}
