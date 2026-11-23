#!/usr/bin/env node
// Builds dist/fedrok-registry-demo.html: the full web app plus an in-browser Fedrok
// network (same protocol and API code) in one self-contained HTML file.
//
// By default the in-browser network is first run here, in Node, until the
// demo scenarios have seeded it, and that network is embedded in the page, so
// visitors open a working network straight away. --no-snapshot skips this
// (the page then seeds itself on first visit, which takes a few minutes).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (f) => path.join(ROOT, 'web', f);

async function seedSnapshot() {
  // Minimal browser globals for web/inbrowser/local-node.js.
  const mem = new Map();
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { startLocalNetwork } = await import('../web/inbrowser/local-node.js');
  const local = await startLocalNetwork();
  const t0 = Date.now();
  let last = '';
  local.subscribe((m) => { if (m.type === 'seed' && m.line && m.line.trim()) last = m.line.trim(); });
  const tick = setInterval(() => process.stdout.write(`\r  seeding demo network (${Math.round((Date.now() - t0) / 1000)} s) ${last.slice(0, 70).padEnd(70)}`), 1000);
  while (!local.seed.done) {
    if (!local.seed.running) throw new Error('demo seeding stopped: ' + local.seed.lines.slice(-1)[0]);
    await new Promise((r) => setTimeout(r, 500));
  }
  clearInterval(tick);
  const snap = local.snapshot();
  process.stdout.write(`\r  demo network seeded: ${snap.blocks.length} blocks, ${snap.blocks.reduce((n, b) => n + b.txs.length, 0)} transactions${' '.repeat(40)}\n`);
  return snap;
}

const snapshot = process.argv.includes('--no-snapshot') ? null : await seedSnapshot();

const result = await build({
  entryPoints: [web('inbrowser/entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'none',
  plugins: [{
    name: 'core-alias',
    setup(b) {
      b.onResolve({ filter: /^\/core\// }, (a) => ({ path: path.join(ROOT, 'src', a.path) }));
    },
  }],
});
let js = result.outputFiles[0].text;
if (snapshot) js = `window.FEDROK_DEMO_SNAPSHOT=${JSON.stringify(snapshot)};\n` + js;
let css = fs.readFileSync(web('styles.css'), 'utf8');
let html = fs.readFileSync(web('index.html'), 'utf8');

const dataUri = (f) => 'data:image/png;base64,' + fs.readFileSync(web(f.slice(1))).toString('base64');
const inlineAssets = (s) => s.replace(/\/assets\/[\w.-]+\.png/g, (m) => dataUri(m));
js = inlineAssets(js);
css = inlineAssets(css);
html = inlineAssets(html);

html = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="/app.js"></script>', () => `<script type="module">${js.replace(/<\/script/g, '<\\/script')}</script>`)
  .replace('<small>Registry · Devnet</small>', '<small>Registry · Hosted demo</small>')
  // The artifact host supplies the document skeleton: emit head + body content only.
  .replace(/<!doctype html>\s*<html[^>]*>\s*<head>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*<meta name="viewport"[^>]*>\s*/, '')
  .replace(/<\/head>\s*<body>\s*/, '\n')
  .replace(/\s*<\/body>\s*<\/html>\s*$/, '\n');

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'fedrok-registry-demo.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
process.exit(0); // the seeded network's timers would otherwise keep running
