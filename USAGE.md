# StreamGrab — Usage Guide

Download a whole drama series (or selected episodes) from an aiyingshi.tv-style
page and save each episode as its own MP4 file.

---

## Requirements

- **Node.js** 18+ (uses the built-in `fetch`).
- Dependencies installed:
  ```bash
  npm install
  ```
  This pulls in `playwright`, `m3u8-parser`, `cli-progress`, and `ffmpeg-static`
  (a full ffmpeg build used for MP4 remuxing).
- Playwright's Chromium (only needed for the sniffing fallback):
  ```bash
  npx playwright install chromium
  ```

---

## Two ways to run

- **Web UI** — `npm run webui`, then open http://127.0.0.1:8787 in a browser.
- **CLI** — `node src/index.js <pageUrl> [options]`.

Both share the same download pipeline.

---

## Web UI

```bash
npm run webui
# or: node src/webui.js
```

Then open **http://127.0.0.1:8787**. The page lets you fill in:

| Field | Meaning |
| --- | --- |
| Video / episode page URL | The page to download from (required). |
| Output folder | Where to save. Defaults to `D:/Videos` when left blank. Accepts relative paths (resolved against the tool's working dir) or absolute paths like `D:/Videos` or `C:\\Users\\me\\Videos`. |
| Episodes | `all` (blank) · `1-10` · `1,3,7` · `1-5,8,12-15`. |
| Concurrency | Parallel segment downloads (1–32, default 8). |
| Show browser when sniffing | Enables the Playwright sniffing fallback in a visible browser. |
| Force sniffing | Skip inline-config extraction. |
| Keep temp segments | Don't delete `.tmp/` segment folders. |

Buttons:

- **Download** — runs the job and streams live progress into the log pane.
- **List episodes only** — discovers the series and prints the episode list without downloading.
- **Clear log** — clears the log pane.

Environment variables:

- `PORT` — default `8787`.
- `ALLOW_LAN` — **on by default**: other devices on your local network can reach
  the UI. Set to `0` to restrict to this machine only (loopback).
- `HOST` — override the bind address. Default is `0.0.0.0`, or `127.0.0.1` when
  `ALLOW_LAN=0`.

**Local-network-only by design.** Regardless of binding, every request is
checked against the source IP: loopback, RFC1918 (`10/8`, `172.16/12`,
`192.168/16`), link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`),
and IPv6 ULA (`fc00::/7`) are allowed; **anything else gets HTTP 403**. So even
if the port is forwarded or bound broadly, public clients are rejected.

```bash
# default: reachable from phones/other PCs on your LAN
npm run webui

# restrict to this machine only
ALLOW_LAN=0 npm run webui

# custom port
PORT=9000 npm run webui
```

Only one download runs at a time; a second request gets HTTP 409.

### HTTP API

The UI is a thin wrapper over a small JSON/SSE API:

- `GET /api/status` → `{ busy, job, cwd, defaultOut }`
- `POST /api/download` with a JSON body → `text/event-stream` of `log` events,
  a final `result` event, then `done`.

Body fields (all optional except `url`):

```json
{
  "url": "https://www.aiyingshi.tv/play/106159-0-1.html",
  "out": "D:/Videos",
  "episodes": "1-5",
  "concurrency": 8,
  "headed": false,
  "forceSniff": false,
  "keepSegments": false,
  "list": false
}
```

Example with `curl`:

```bash
curl -N -X POST http://127.0.0.1:8787/api/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.aiyingshi.tv/play/106159-0-1.html","out":"D:/Videos","episodes":"1-3"}'
```

---

## CLI

```
node src/index.js <pageUrl> [options]
```

Given any episode page, the tool auto-discovers the drama title and the full
episode list, then downloads them.

```bash
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html
```

Output:

```
D:/Videos/
└── 兰香如故/
    ├── 兰香如故-第01集.mp4
    ├── 兰香如故-第02集.mp4
    ├── …
    └── 兰香如故-第47集.mp4
```

---

## Listing episodes (dry run)

See the discovered title and episode list without downloading anything:

```bash
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html --list
```

```
兰香如故 — 47 episode(s) (badge: 47)

  01  https://www.aiyingshi.tv/play/106159-0-1.html
  02  https://www.aiyingshi.tv/play/106159-0-2.html
  …
  47  https://www.aiyingshi.tv/play/106159-0-47.html
```

---

## Selecting episodes

Use `-e` / `--episodes` with any of these forms:

| Spec             | Downloads                          |
| ---------------- | ---------------------------------- |
| *(omitted)*      | **all** episodes                   |
| `5`              | episode 5 only                     |
| `1,3,7`          | episodes 1, 3 and 7                |
| `1-10`           | episodes 1 through 10 (inclusive)  |
| `1-5,8,12-15`    | mix of ranges and single numbers   |

Examples:

```bash
# Episodes 1 to 10
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -e 1-10

# A few specific episodes
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -e 1,3,7

# A mixed selection, with 12 parallel segment downloads
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -e 1-5,8,12-15 -c 12
```

Out-of-range episode numbers are ignored with a warning. If nothing valid
remains, the tool exits before downloading.

---

## Options

| Flag                     | Description                                                        | Default            |
| ------------------------ | ------------------------------------------------------------------ | ------------------ |
| `-e, --episodes <spec>`  | Episodes to download (`5`, `1,3,7`, `1-10`, `1-5,8,12-15`).        | all episodes       |
| `-o, --out <dir>`        | Base output directory.                                             | `D:/Videos`        |
| `-c, --concurrency <n>`  | Parallel segment downloads per episode.                            | `8`                |
| `--list`                 | Only list the discovered title + episodes, then exit.             | off                |
| `--headed`               | Show the browser window when sniffing.                             | off (headless)     |
| `--force-sniff`          | Skip inline-config extraction; always use Playwright sniffing.     | off                |
| `--no-remux`             | Keep raw `.ts` concat instead of remuxing to `.mp4`.               | off                |
| `--keep-segments`        | Keep the temp segment folders after each episode.                  | off (cleaned up)   |
| `--work-dir <dir>`       | Where to store temp segments.                                      | `<series>/.tmp`    |
| `-h, --help`             | Show help.                                                         |                    |

---

## Common tasks

**Download one episode**
```bash
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -e 1
```

**Download the whole series, faster**
```bash
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -c 16
```

**Save to a custom directory**
```bash
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -o D:/Dramas
# → D:/Dramas/兰香如故/兰香如故-第01集.mp4
```

**Skip MP4 remux (keep raw .ts)**
```bash
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -e 1 --no-remux
```

**Watch the browser while it finds the stream**
```bash
node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html --headed
```

---

## Output layout

```
<out>/
└── <drama title>/
    ├── <drama title>-第01集.mp4
    ├── <drama title>-第02集.mp4
    ├── …
    └── .tmp/
        └── ep01/ segment-00000.ts …    (removed after each episode)
```

Episode numbers are zero-padded to the width of the highest episode number
(e.g. `01`…`47` for a 47-episode series).

---

## How it works (short version)

1. **Discover** — fetch the page, read the drama title and the full episode
   list from the inline anthology markup.
2. **Resolve stream** — try the page's inline `var config` first; fall back to
   driving Chromium (Playwright) and capturing the `.m3u8` network request.
3. **Download** — fetch the HLS playlist, pick the best variant, and download
   all segments in parallel with retry/resume. AES-128 segments are decrypted.
4. **Remux** — concatenate segments and remux to `.mp4` with ffmpeg (falls back
   to a single `.ts` if no capable ffmpeg is available).

See `README.md` for the full technical design.

---

## Troubleshooting

**`ffmpeg remux failed` / output is `.ts` not `.mp4`**
No full ffmpeg was found. Install the bundled one:
```bash
npm install ffmpeg-static
```
or point `FFMPEG` at a system ffmpeg:
```bash
FFMPEG=/path/to/ffmpeg node src/index.js <url>
```

**`Could not find any stream`**
Both extraction tiers failed. Try `--force-sniff --headed` to watch the browser
and confirm the video plays.

**Some segments fail and retry**
Transient network errors are retried automatically; the run continues. Failed
episodes are reported in the final summary and can be re-run individually with
`-e <n>` (already-downloaded segments are skipped).

**403 fetching the page**
The site may block non-browser requests. Run with `--force-sniff` so Playwright
fetches the page with a real browser context.
