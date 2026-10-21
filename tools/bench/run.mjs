#!/usr/bin/env node
/* Runs bench.html in Chrome (puppeteer-core) and records one Chrome trace per backend.
   The traces open directly in https://ui.perfetto.dev (Open trace file), where the pipeline stages
   show up as tb:vision / tb:capture / tb:bgsub / tb:blobs / tb:learn / tb:track slices.

   node tools/bench/run.mjs [--backends cpu,gpu,gpu-async] [--frames 600] [--throttle 1] [--out bench-out]
                            [--label name] [--headful] [--chrome /path/to/chrome] */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith('--')) a.push([x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
const backends = String(args.backends || 'cpu,gpu,gpu-async').split(',');
const frames = +args.frames || 600;
const throttle = +args.throttle || 1;
const outDir = resolve(args.out || join(ROOT, 'bench-out'));
const label = args.label ? '-' + args.label : '';
const extra = args.query ? '&' + args.query : ''; // extra bench.html URL options

const CHROME = args.chrome || process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('Chrome not found: pass --chrome or set CHROME_PATH'); process.exit(2); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const body = await readFile(path); res.writeHead(200, {
    'content-type': TYPES[extname(path)] || 'application/octet-stream',
    // cross-origin isolated: performance.now() at 5 us instead of 100 us resolution
    'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
  }).end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !args.headful,
  args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 },
});

const CATEGORIES = ['blink.user_timing', 'devtools.timeline', 'toplevel', 'v8.execute', 'gpu'];
await mkdir(outDir, { recursive: true });
const results = [];
try {
  for (const backend of backends) {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.error('[page]', m.text()); });
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const trace = join(outDir, `trace-${backend}${label}.json`);
    await page.tracing.start({ path: trace, categories: CATEGORIES });
    await page.goto(`${base}/bench.html?run&backend=${backend}&frames=${frames}${extra}`);
    await page.waitForFunction('window.__bench && window.__bench.done', { timeout: 0, polling: 500 });
    await page.tracing.stop();
    const [r] = await page.evaluate(() => window.__bench.results);
    Object.assign(r, { requested: backend, throttle, trace });
    results.push(r);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

const resultsFile = join(outDir, `results${label}.json`);
await writeFile(resultsFile, JSON.stringify({ date: new Date().toISOString(), frames, throttle, results }, null, 2));
const f = (x) => x.toFixed(3).padStart(8);
console.log(`\nframes=${frames} throttle=${throttle}x   (ms per frame: mean / p50 / p95)`);
for (const r of results) {
  console.log(`\n${r.backend.toUpperCase()}  ${r.renderer}${r.extra ? '  ' + r.extra : ''}`);
  for (const [s, v] of Object.entries(r.stages)) console.log(`  ${s.padEnd(8)} ${f(v.mean)} ${f(v.p50)} ${f(v.p95)}`);
  console.log(`  trace: ${r.trace}`);
}
console.log(`\n${resultsFile}`);
