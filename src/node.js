#!/usr/bin/env node
// Fedrok full node: chain + Bitcoin light client + P2P + API + block production.
//
//   node src/node.js --genesis=devnet/genesis.json --data=devnet/node1 \
//     --api-port=8545 --p2p-port=30303 --peers=ws://127.0.0.1:30304 \
//     --key=devnet/keys/generator1.key --btc=http://127.0.0.1:18443
import fs from 'node:fs';
import { Chain } from './evm/chain.js';
import { FileStorage } from './node/file-storage.js';
import { BtcLightClient } from './node/btc-light-client.js';
import { P2P } from './node/p2p.js';
import { Api } from './node/api.js';
import { addressFromPrivate } from './core/crypto.js';
import { MAX_BTC_HEADERS_PER_BLOCK } from './core/btc.js';
import { faucetSend } from './evm/faucet.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const env = process.env;
const cfg = {
  name: args.name || env.FEDROK_NODE_NAME || 'fedrok-node',
  genesis: args.genesis || env.FEDROK_GENESIS || 'devnet/genesis.json',
  data: args.data || env.FEDROK_DATA || 'devnet/node',
  apiPort: Number(args['api-port'] || env.FEDROK_API_PORT || 8545),
  p2pPort: Number(args['p2p-port'] || env.FEDROK_P2P_PORT || 30303),
  peers: (args.peers || env.FEDROK_PEERS || '').split(',').filter(Boolean),
  key: args.key || env.FEDROK_VALIDATOR_KEY || null,
  faucetKey: args['faucet-key'] || env.FEDROK_FAUCET_KEY || null,
  btc: args.btc || env.FEDROK_BTC_URL || 'http://127.0.0.1:18443',
};

const prefix = `[${cfg.name}]`;
const log = {
  info: (...m) => console.log(prefix, ...m),
  warn: (...m) => console.warn(prefix, 'WARN', ...m),
};
const readKey = (f) => (f ? fs.readFileSync(f, 'utf8').trim() : null);
const HEARTBEAT_MS = 30_000;

class FedrokNode {
  constructor() {
    this.name = cfg.name;
    this.genesis = JSON.parse(fs.readFileSync(cfg.genesis, 'utf8'));
    this.chain = new Chain(this.genesis, new FileStorage(cfg.data), log);
    this.validatorKey = readKey(cfg.key);
    this.validatorAddress = this.validatorKey ? addressFromPrivate(this.validatorKey) : null;
    this.faucetKey = readKey(cfg.faucetKey);
    this.btc = new BtcLightClient({ url: cfg.btc, difficulty: this.genesis.btc.difficulty, log });
    this.p2p = new P2P({ chain: this.chain, port: cfg.p2pPort, peers: cfg.peers, name: cfg.name, log });
    this.api = new Api({ node: this, port: cfg.apiPort, log });
  }

  async start() {
    await this.chain.load();
    this.btc.start(1000);
    this.p2p.start();
    this.api.start();
    if (this.validatorKey) {
      log.info(`block generator key loaded: ${this.validatorAddress}`);
      this.lastTriedSlot = -1;
      setInterval(() => this.tryProduce(), 150);
    }
    this.chain.on('block', (b) => {
      if (b && b.header.height % 20 === 0) log.info(`height ${b.header.height} (${b.header.mode}, generator ${b.header.generator.slice(0, 10)}…)`);
    });
  }

  async tryProduce() {
    if (!this.btc.synced || this.producing) return;
    const now = Date.now();
    const bt = this.chain.state.params.blockTimeMs;
    const slot = Math.floor(now / bt);
    if (slot === this.lastTriedSlot) return;
    // Give the previous slot's block a moment to arrive before claiming ours.
    if (now % bt < 250) return;
    this.lastTriedSlot = slot;
    const anchor = this.chain.state.pog.anchorHeight;
    const tip = this.btc.tip.height;
    const btcHeaders = this.btc.range(anchor, Math.min(tip, anchor + MAX_BTC_HEADERS_PER_BLOCK));
    // Produce when there is something to record, or as a heartbeat.
    const idle = this.chain.mempool.size === 0 && btcHeaders.length === 0 && now - this.chain.state.lastTimestamp < HEARTBEAT_MS;
    if (idle) return;
    this.producing = true;
    try {
      const block = await this.chain.produce({ timestamp: now, btcHeaders, privKey: this.validatorKey });
      if (block && block.header.txCount) log.info(`produced block ${block.header.height} with ${block.header.txCount} tx`);
    } catch (e) {
      log.warn(`block production failed: ${e.message}`);
    } finally {
      this.producing = false;
    }
  }

  async btcSimMiners() {
    const r = await fetch(this.btc.url + '/sim/miners');
    if (!r.ok) throw new Error('simulator unavailable');
    return r.json();
  }

  async faucetSend(to) {
    return faucetSend(this.chain, this.faucetKey, to, this.genesis.faucet);
  }
}

const node = new FedrokNode();
node.start().catch((e) => {
  console.error(e);
  process.exit(1);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
