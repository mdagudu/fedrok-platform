#!/usr/bin/env node
// Builds dist/fedrok-demo.html: the full web app plus an in-browser Fedrok
// network (same protocol and API code) in one self-contained HTML file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (f) => path.join(ROOT, 'web', f);

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
  .replace('<small>Network · Devnet</small>', '<small>Network · Hosted demo</small>')
  // The artifact host supplies the document skeleton: emit head + body content only.
  .replace(/<!doctype html>\s*<html[^>]*>\s*<head>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*<meta name="viewport"[^>]*>\s*/, '')
  .replace(/<\/head>\s*<body>\s*/, '\n')
  .replace(/\s*<\/body>\s*<\/html>\s*$/, '\n');

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'fedrok-demo.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
