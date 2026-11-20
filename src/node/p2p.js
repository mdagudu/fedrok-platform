// Peer-to-peer gossip over WebSocket: transactions, blocks and chain sync.
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const SYNC_BATCH = 200;

export class P2P {
  constructor({ chain, port, peers = [], name, publicUrl, log = console }) {
    this.chain = chain;
    this.port = port;
    this.seedPeers = peers;
    this.name = name;
    this.publicUrl = publicUrl || `ws://127.0.0.1:${port}`;
    this.log = log;
    this.nodeId = crypto.randomBytes(8).toString('hex');
    this.sockets = new Map(); // ws -> info
    this.seen = new Set();
    this.syncing = false;
    this.pendingFork = null;
  }

  start() {
    this.server = new WebSocketServer({ port: this.port, maxPayload: 16 * 1024 * 1024 });
    this.server.on('connection', (ws, req) => this._attach(ws, { inbound: true, addr: req.socket.remoteAddress }));
    for (const url of this.seedPeers) this._dial(url, 500);
    this.chain.on('block', (block) => block && this.broadcast({ t: 'block', block }));
    this.chain.on('tx', (tx) => this.broadcast({ t: 'tx', tx }));
    this.log.info(`p2p listening on :${this.port}`);
  }

  peers() {
    return [...this.sockets.values()].filter((i) => i.hello).map((i) => ({ name: i.hello.name, nodeId: i.hello.nodeId, height: i.height, url: i.url || i.hello.listen, inbound: i.inbound }));
  }

  _dial(url, delay) {
    setTimeout(() => {
      const ws = new WebSocket(url);
      ws.on('error', () => {});
      ws.on('open', () => this._attach(ws, { inbound: false, url }));
      ws.on('close', () => this._dial(url, Math.min(delay * 2, 10_000)));
    }, delay);
  }

  _attach(ws, info) {
    this.sockets.set(ws, { ...info, height: 0 });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      this._handle(ws, msg).catch((e) => this.log.warn(`p2p message error: ${e.message}`));
    });
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => {});
    this._send(ws, { t: 'hello', chainId: this.chain.state.chainId, genesis: this.chain.genesisHash, nodeId: this.nodeId, name: this.name, height: this.chain.height, listen: this.publicUrl });
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except) {
    const id = msg.t + ':' + (msg.block?.hash || msg.tx?.hash || '');
    this.seen.add(id);
    if (this.seen.size > 50_000) this.seen = new Set([...this.seen].slice(-10_000));
    for (const ws of this.sockets.keys()) if (ws !== except) this._send(ws, msg);
  }

  async _handle(ws, msg) {
    const info = this.sockets.get(ws);
    if (!info) return;
    switch (msg.t) {
      case 'hello':
        if (msg.genesis !== this.chain.genesisHash) {
          this.log.warn(`peer ${msg.name} is on a different genesis; disconnecting`);
          return ws.close();
        }
        if (msg.nodeId === this.nodeId) return ws.close();
        info.hello = msg;
        info.height = msg.height;
        if (msg.height > this.chain.height) this._requestFrom(ws, this.chain.height + 1);
        // share mempool so new peers can include pending txs
        for (const tx of this.chain.mempool.values()) this._send(ws, { t: 'tx', tx });
        break;
      case 'tx': {
        if (this.seen.has('tx:' + msg.tx?.hash)) return;
        try {
          const r = this.chain.addTx(msg.tx); // emits 'tx' -> rebroadcast
          if (r.duplicate) this.seen.add('tx:' + r.hash);
        } catch {
          this.seen.add('tx:' + msg.tx?.hash);
        }
        break;
      }
      case 'block': {
        const b = msg.block;
        if (!b?.header || this.seen.has('block:' + b.hash)) return;
        info.height = Math.max(info.height, b.header.height);
        this._onBlock(ws, b);
        break;
      }
      case 'getBlocks': {
        const from = Math.max(1, Number(msg.from) || 1);
        const blocks = this.chain.blocks.slice(from - 1, from - 1 + SYNC_BATCH);
        this._send(ws, { t: 'blocks', from, blocks, height: this.chain.height });
        break;
      }
      case 'blocks':
        this._onBlocks(ws, msg);
        break;
    }
  }

  _onBlock(ws, b) {
    const h = b.header;
    if (h.height <= this.chain.height && this.chain.getBlock(h.height)?.hash === b.hash) return;
    if (h.height === this.chain.height + 1 && h.prevHash === this.chain.state.tipHash) {
      if (h.timestamp > Date.now() + 3000) return this.log.warn(`block ${h.height} from the future, ignored`);
      try {
        this.chain.addBlock(b); // emits 'block' -> rebroadcast
      } catch (e) {
        this.seen.add('block:' + b.hash);
        this.log.warn(`rejected block ${h.height} from peer: ${e.message}`);
      }
      return;
    }
    if (h.height > this.chain.height) {
      // gap or fork: fetch from a little behind our tip to find the fork point
      this._requestFrom(ws, Math.max(1, this.chain.height - 20));
    }
  }

  _requestFrom(ws, from) {
    this._send(ws, { t: 'getBlocks', from });
  }

  _onBlocks(ws, msg) {
    const blocks = msg.blocks || [];
    if (!blocks.length) return;
    // Skip blocks we already have identically.
    let i = 0;
    while (i < blocks.length && this.chain.getBlock(blocks[i].header.height)?.hash === blocks[i].hash) i++;
    const rest = blocks.slice(i);
    if (!rest.length) {
      if (msg.height > this.chain.height) this._requestFrom(ws, this.chain.height + 1);
      return;
    }
    if (rest[0].header.height === this.chain.height + 1 && rest[0].header.prevHash === this.chain.state.tipHash) {
      for (const b of rest) {
        try {
          this.chain.addBlock(b);
        } catch (e) {
          this.log.warn(`sync: block ${b.header.height} invalid: ${e.message}`);
          return;
        }
      }
    } else {
      // Divergence. Accumulate the peer's branch and try the fork choice rule.
      const ok = this.chain.tryReorg(rest);
      if (!ok && rest[0].header.height > 1) {
        const back = Math.max(1, rest[0].header.height - SYNC_BATCH);
        if (back < rest[0].header.height) return this._requestFrom(ws, back);
      }
    }
    if (msg.height > this.chain.height) this._requestFrom(ws, this.chain.height + 1);
  }
}
