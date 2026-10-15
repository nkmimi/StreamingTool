#!/usr/bin/env node
import { log } from './util.js';
import { runDownload, DEFAULT_OUT } from './downloader.js';

function parseArgs(argv) {
  const args = {
    url: null, out: null, concurrency: 8, headed: false, forceSniff: false,
    noRemux: false, keepSegments: false, workDir: null, list: false, episodes: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '-c' || a === '--concurrency') args.concurrency = parseInt(argv[++i], 10) || 8;
    else if (a === '-e' || a === '--episodes') args.episodes = argv[++i];
    else if (a === '--headed') args.headed = true;
    else if (a === '--force-sniff') args.forceSniff = true;
    else if (a === '--no-remux') args.noRemux = true;
    else if (a === '--keep-segments') args.keepSegments = true;
    else if (a === '--work-dir') args.workDir = argv[++i];
    else if (a === '--list') args.list = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!a.startsWith('-') && !args.url) args.url = a;
  }
  return args;
}

function usage() {
  console.log(`
Usage: node src/index.js <pageUrl> [options]

Options:
  -e, --episodes <spec>   Episodes to download: '5' | '1,3,7' | '1-10' | '1-5,8,12-15'
                          (default: all)
  -o, --out <dir>         Base output dir (default: D:/Videos)
  -c, --concurrency <n>   Parallel segment downloads per episode (default 8)
      --list              Only list discovered title + episodes, then exit
      --headed            Show the browser when sniffing
      --force-sniff       Skip inline-config extraction, always use Playwright
      --no-remux          Keep raw .ts concat instead of remuxing to mp4
      --keep-segments     Do not delete temp segment folders

Examples:
  node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html --list
  node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -e 1-10
  node src/index.js https://www.aiyingshi.tv/play/106159-0-1.html -e 1,3,7 -c 12 -o D:/Videos
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) { usage(); process.exit(args.url ? 0 : 1); }

  const res = await runDownload({
    url: args.url,
    out: args.out || DEFAULT_OUT,
    episodes: args.episodes,
    concurrency: args.concurrency,
    headed: args.headed,
    forceSniff: args.forceSniff,
    noRemux: args.noRemux,
    keepSegments: args.keepSegments,
    workDir: args.workDir,
    list: args.list,
    emit: (line) => log.info(line),
  });

  if (res.listOnly) {
    console.log(`\n${res.title} — ${res.all.length} episode(s)${res.total ? ` (badge: ${res.total})` : ''}\n`);
    for (const e of res.all) console.log(`  ${String(e.index).padStart(res.width, '0')}  ${e.url}`);
  }
}

main().catch((e) => {
  log.error(e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
