import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { log, findFfmpeg, ensureDir } from './util.js';

/**
 * Check whether a given ffmpeg binary can concatenate MPEG-TS via the
 * `concat` demuxer or protocol. Playwright's bundled ffmpeg is a *reduced*
 * build (WebM/VP8 only) that supports neither, so we must probe, not assume.
 */
function ffmpegCanConcat(ffmpeg) {
  const v = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  if (v.status !== 0) return false;
  const demux = spawnSync(ffmpeg, ['-hide_banner', '-demuxers'], { encoding: 'utf8' });
  const protos = spawnSync(ffmpeg, ['-hide_banner', '-protocols'], { encoding: 'utf8' });
  const hasConcatDemuxer = /\bconcat\b/.test(demux.stdout || '');
  const hasConcatProto = /\bconcat\b/.test(protos.stdout || '');
  // Also require mpegts demuxing (obviously needed for .ts input).
  const hasMpegts = /\bmpegts\b/.test(demux.stdout || '');
  return (hasConcatDemuxer || hasConcatProto) && hasMpegts;
}

/**
 * Concatenate downloaded .ts segments into a single file.
 *
 * - If a *capable* ffmpeg is found: remux to MP4 (`-c copy`).
 * - Otherwise: binary-concatenate the segments into one `.ts`. MPEG-TS is a
 *   streaming container, so a simple concat yields a valid, seekable file
 *   playable in VLC/mpv/PotPlayer (just not `.mp4`).
 *
 * Returns { outPath, remuxed, container }.
 */
export function remux(files, outPath, { useFfmpeg = true, log: lg = log } = {}) {
  ensureDir(path.dirname(outPath));

  if (useFfmpeg) {
    const ffmpeg = findFfmpeg();
    if (ffmpegCanConcat(ffmpeg)) {
      lg.info(`Remuxing to MP4 with ffmpeg (${ffmpeg})…`);
      // Use the concat *demuxer* with a list file: more tolerant of odd
      // segment boundaries than the concat: protocol, and it lets us pass
      // error-tolerance flags so one truncated segment doesn't abort the job.
      const listFile = path.join(path.dirname(outPath), `.concat-${Date.now()}.txt`);
      // The concat demuxer resolves relative paths against the *list file's*
      // own directory, not the process CWD — so entries must be absolute
      // (forward slashes are safest; ffmpeg accepts them on Windows too).
      const absList = files.map((f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(listFile, absList);
      try {
        const r = spawnSync(ffmpeg, [
          '-hide_banner', '-loglevel', 'warning',
          '-fflags', '+genpts+discardcorrupt',
          '-err_detect', 'ignore_err',
          '-f', 'concat', '-safe', '0',
          '-i', listFile,
          '-c', 'copy',
          '-bsf:a', 'aac_adtstoasc',
          '-movflags', '+faststart',
          '-y', outPath,
        ], { stdio: 'inherit' });
        if (r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          return { outPath, remuxed: true, container: 'mp4' };
        }
      } finally {
        try { fs.rmSync(listFile, { force: true }); } catch {}
      }
      lg.warn('ffmpeg remux failed; falling back to raw .ts concat');
    } else {
      lg.warn('No capable ffmpeg found (Playwright\'s bundled build cannot concat).');
    }
  }

  // Fallback: binary concat into a single .ts. Change the extension so the
  // file isn't mislabeled as .mp4.
  const tsOut = /\.mp4$/i.test(outPath) ? outPath.replace(/\.mp4$/i, '.ts') : outPath + '.ts';
  lg.info(`Writing single .ts (${files.length} segments)…`);
  const fd = fs.openSync(tsOut, 'w');
  try {
    for (const f of files) fs.writeSync(fd, fs.readFileSync(f));
  } finally {
    fs.closeSync(fd);
  }
  return { outPath: tsOut, remuxed: false, container: 'ts' };
}
