// HTTP transport: REST + JSON-RPC 2.0 + live WebSocket feed + static web app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ApiCore, toJSON } from './api-core.js';

export { toJSON };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const STATIC_ROOTS = [
  ['/vendor/@noble/curves/', path.join(ROOT, 'node_modules/@noble/curves/')],
  ['/vendor/@noble/hashes/', path.join(ROOT, 'node_modules/@noble/hashes/')],
  ['/core/', path.join(ROOT, 'src/core/')],
  ['/', path.join(ROOT, 'web/')],
];

export class Api extends ApiCore {
  constructor({ node, port, log = console }) {
    super({ node });
    this.port = port;
    this.log = log;
  }

  start() {
    this.server = http.createServer((req, res) => this._route(req, res).catch((e) => this._send(res, 500, { error: e.message })));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, sock, head) => {
      if (req.url.startsWith('/ws')) this.wss.handleUpgrade(req, sock, head, (ws) => ws.send(toJSON({ type: 'hello', status: this.status() })));
      else sock.destroy();
    });
    this.chain.on('block', (b) => b && this._push({ type: 'block', block: this._blockSummary(b) }));
    this.chain.on('tx', (tx) => this._push({ type: 'tx', hash: tx.hash, txType: tx.type, from: tx.from }));
    this.node.btc.on('header', (h) => this._push({ type: 'btc', header: this._btcSummary(h) }));
    this.server.listen(this.port, () => this.log.info(`api + explorer on http://127.0.0.1:${this.port}`));
  }

  _push(msg) {
    const data = toJSON(msg);
    for (const c of this.wss.clients) if (c.readyState === 1) c.send(data);
  }

  _send(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    res.end(toJSON(body));
  }

  async _route(req, res) {
    if (req.method === 'OPTIONS') return this._send(res, 204, {});
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/') || p === '/rpc') {
      let body = {};
      if (req.method === 'POST') {
        let data = '';
        for await (const chunk of req) {
          data += chunk;
          if (data.length > 1_000_000) return this._send(res, 413, { error: 'body too large' });
        }
        try {
          body = data ? JSON.parse(data) : {};
        } catch {
          return p === '/rpc' ? this._send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) : this._send(res, 400, { error: 'invalid JSON' });
        }
      }
      const r = await this.handle(req.method, req.url, body);
      if (r) return this._send(res, r.code, r.body);
    }
    return this._static(p, res);
  }

  _static(p, res) {
    for (const [prefix, dir] of STATIC_ROOTS) {
      if (!p.startsWith(prefix)) continue;
      let rel = decodeURIComponent(p.slice(prefix.length)) || 'index.html';
      const file = path.resolve(dir, rel);
      if (!file.startsWith(dir)) break;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        return fs.createReadStream(file).pipe(res);
      }
      if (prefix === '/') {
        // SPA fallback
        res.writeHead(200, { 'content-type': MIME['.html'] });
        return fs.createReadStream(path.join(dir, 'index.html')).pipe(res);
      }
    }
    this._send(res, 404, { error: 'not found' });
  }
}
