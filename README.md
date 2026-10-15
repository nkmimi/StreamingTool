# Streaming Tool — Technical Design

A Node.js CLI that downloads a video from a given web page URL (e.g.
`https://www.aiyingshi.tv/play/106159-0-1.html`) and saves it to local disk.
It uses **Playwright** to resolve the stream source, then downloads the HLS
playlist directly with `fetch` and remuxes with **ffmpeg**.

---

## 1. Purpose

Given a page URL, the tool:

1. Finds the underlying media stream (HLS `.m3u8`, or `.mp4`).
2. Resolves the best playable variant.
3. Downloads all segments concurrently (with resume + retry).
4. Decrypts AES-128 segments if needed.
5. Remuxes the result to a single `.mp4` (or falls back to a single `.ts`).

---

## 2. Architecture

```
src/index.js     CLI entry / orchestration
src/extract.js   Tier 1: parse inline `var config = {…}` from page HTML
src/sniff.js     Tier 2: Playwright network sniffing for .m3u8/.mp4
src/hls.js       Playlist fetch/parse, AES-128 decrypt, concurrent segment download
src/remux.js     ffmpeg remux → mp4, fallback binary concat → .ts
src/util.js      logger, fs helpers, ffmpeg discovery, safeName
```

| Module       | Responsibility                                                       |
| ------------ | -------------------------------------------------------------------- |
| `index.js`   | Argument parsing, pipeline orchestration, cleanup.                   |
| `extract.js` | Tier-1 extraction from inline page config (no browser needed).       |
| `sniff.js`   | Tier-2 fallback: drive Chromium and capture media requests.          |
| `hls.js`     | Fetch/parse playlists, download + decrypt segments.                  |
| `remux.js`   | Concatenate segments; remux to MP4 via ffmpeg if capable.            |
| `util.js`    | Logging, `ensureDir`, `safeName`, `findFfmpeg`, misc helpers.        |
| `control.js` | Pause / resume / cancel channel shared across the download pipeline. |
| `webui.js`   | Local-network-only web UI with SSE progress + control buttons.       |

> **Network policy:** the web UI is **local-network only**. It binds all
> interfaces by default (set `ALLOW_LAN=0` for loopback-only). Every request is
> checked against the source IP — loopback and private ranges (RFC1918,
> link-local, CGNAT, IPv6 ULA) are allowed, anything else gets **HTTP 403**.

---

## 3. Pipeline

```
url ──▶ [1] resolve candidates ──▶ [2] load playlist ──▶ [3] download segments ──▶ [4] remux
             │                            │                      │                    │
       Tier1: inline config         master→best variant     concurrency N,       ffmpeg -c copy
       Tier2: Playwright sniff      (else media playlist)   retry/backoff,       → .mp4
                                    AES-128 key fetch       skip existing        else concat → .ts
```

### Step 1 — Resolve stream candidates

**Tier 1 — Inline config (`extract.js`)**
- Plain `fetch` of the HTML (no browser).
- Brace-match the inline `var config = { … }` object (MacCMS-style).
- Regex out the `url: [...]` array, plus `name`/`title` and `startkey`.
- Reorders candidates so the configured `startkey` entry comes first.

**Tier 2 — Playwright sniffing (`sniff.js`)**
- Launches Chromium (headless by default, `--headed` to watch).
- Blocks ad domains (`doubleclick`, `googlesyndication`, `propeller`, …) and
auto-closes popups.
- Clicks common play buttons, waits for the player to start.
- Captures the first `.m3u8`/`.mp4` request together with its headers
(`Referer`, `Cookie`, `User-Agent`, `Origin`).

### Step 2 — Load playlist (`hls.js` → `loadPlaylist`)

- Fetch the m3u8.
- If it is a **master** playlist (`#EXT-X-STREAM-INF`), parse variants,
sort by bandwidth, pick the best, and re-fetch it.
- `pickStream()` probes the candidate list in order and returns the first
that yields a valid playlist.

### Step 3 — Parse + download (`hls.js` → `parseMediaPlaylist`, `downloadSegments`)

- Parse `#EXTINF` segments, `#EXT-X-KEY` (AES-128 key/IV), `#EXT-X-MAP`.
- N concurrent workers pull segments into
`D:/Videos/.tmp/<title>/segment-00000.ts`.
- Retry with exponential backoff; skip already-downloaded files (resume).
- AES-128-CBC decryption per segment when a key is present.

### Step 4 — Remux (`remux.js` → `remux`)

- Probe ffmpeg for `concat` + `mpegts` support.
- If capable:
  `-i concat:<files> -c copy -bsf:a aac_adtstoasc -movflags +faststart out.mp4`.
- Otherwise binary-concatenate all segments into a single `.ts`.

---

## 4. CLI

```
node src/index.js <pageUrl> [options]

Options:
  -o, --out <file>        Output file (default: D:/Videos/<title>.mp4)
  -c, --concurrency <n>   Parallel segment downloads (default 8)
      --headed            Show the browser when sniffing
      --force-sniff       Skip inline-config extraction, always use Playwright
      --no-remux          Keep raw .ts concat instead of remuxing to mp4
      --keep-segments     Do not delete the temp segment folder
      --work-dir <dir>    Where to store temp segments

Examples:
  node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html
  node src/index.js <url> -o myvideo.mp4 -c 12 --headed
```

---

## 5. Output layout

```
D:/Videos/
├── <title>.mp4          Final file (or <title>.ts on fallback)
└── .tmp/
    └── <title>/
        ├── segment-00000.ts
        ├── segment-00001.ts
        └── …
```

Temp segments are deleted after a successful run unless `--keep-segments`
is passed.

---

## 6. Dependencies

| Package        | Use                                    |
| -------------- | -------------------------------------- |
| `playwright`   | Tier-2 sniffing (bundled Chromium).    |
| `m3u8-parser`  | (available) HLS parsing support.       |
| `cli-progress` | (available) progress bars.             |

ffmpeg is discovered via (in order): `FFMPEG` env var → system `PATH` →
Playwright's bundled build under `ms-playwright`.

---

## 7. Verification status

Validated end-to-end against `https://www.aiyingshi.tv/play/106159-0-1.html`:

- **Series discovery** — title `兰香如故`, 47 episodes found (matches the
  "47集全" badge).
- **Tier-1 extraction** — 47 `.m3u8` candidates parsed from the inline
  `var config` object; episode playlist loads with a `Referer` header.
- **Segments** — first 3 fetched concurrently, all valid MPEG-TS
  (sync byte `0x47`, 2–3.5 MB each).
- **Remux** — `ffmpeg-static` build (has `concat` + `mpegts` + `libx264`)
  concatenates segments into a playable `.mp4`.
- **Server controller** — port-conflict fallback works (busy `:8000` → `:8001`).
- **Server panel buttons** — enable/disable live from server state; the
  action's progress streams into the panel below the buttons.

### Streaming-server panel (web UI)

The **Streaming Server (Caddy)** panel keeps its buttons in sync with the
actual server state and streams the action's progress live:

- **Button state follows server status:**
  - stopped → **Start** enabled; **Stop**/**Restart** disabled.
  - running (managed here) → **Start** disabled; **Stop**/**Restart** enabled.
  - running (external, not started here) → **Stop** disabled (we won't kill a
    process we didn't start); **Restart** enabled.
  - while an action is in flight → all action buttons disabled.
  The panel re-checks `/api/server` every 5 s so it tracks changes made
  elsewhere.
- **Live progress/output:** clicking a button opens an SSE stream
  (`POST /api/server` → `text/event-stream`) and appends each step below the
  buttons — e.g. `Resolving Caddy config…`, `Preferred port busy — using
  fallback :8001`, `Spawned Caddy (pid …)`, `Server is up at …`. Stream events:
  `log` (progress line), `result` (`{ok, action, result}`), `status` (final
  state), `done` (sentinel), or `error` on failure.

### Resolved issues

1. **Concat list used relative paths** — the `concat` demuxer resolves entries
   against the *list file's* directory, so `output/probe/seg.ts` became
   `output/probe/output/probe/seg.ts`. Fixed by writing **absolute** paths
   (forward-slashed) into the list file.
2. **Output size reported as 0.00 MB** — `downloader.js` now stats
   `result.outPath`, so the `.ts` fallback size is reported correctly.
3. **Wrong ffmpeg picked** — `findFfmpeg()` prefers `FFMPEG` env →
   `ffmpeg-static` → system PATH → Playwright's reduced build, and
   `ffmpegCanConcat()` probes capability before logging "Remuxing".

### Notes

- Stream hosts require the episode page as `Referer`; the tool always sends it.
- Segment URIs in these playlists are relative (`seg-1-v1-a1.ts`) and are
  resolved against the playlist URL.
