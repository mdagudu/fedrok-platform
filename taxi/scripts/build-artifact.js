#!/usr/bin/env node
// Builds dist/fedrok-taxi.html: the web app and the whole in-browser pilot
// network (validators, record store, in-car units) in one self-contained page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (f) => path.join(ROOT, 'web', f);

const result = await build({
  entryPoints: [web('app.js')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, write: false, legalComments: 'none',
});
const dataUri = (f) => 'data:image/png;base64,' + fs.readFileSync(web(f.slice(1))).toString('base64');
const inlineAssets = (s) => s.replace(/\/assets\/[\w.-]+\.png/g, (m) => dataUri(m));
const js = inlineAssets(result.outputFiles[0].text);
// Leaflet is bundled (JS above, CSS here) so the page only needs the network for map tiles and fonts.
const leafletCss = fs.readFileSync(path.join(ROOT, 'node_modules/leaflet/dist/leaflet.css'), 'utf8').replace(/url\(images\/[^)]+\)/g, 'none');
const css = leafletCss + inlineAssets(fs.readFileSync(web('styles.css'), 'utf8'));
const html = inlineAssets(fs.readFileSync(web('index.html'), 'utf8'))
  .replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="/app.js"></script>', () => `<script type="module">${js.replace(/<\/script/g, '<\\/script')}</script>`);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'fedrok-taxi.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
