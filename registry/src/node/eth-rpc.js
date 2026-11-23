// Standard Ethereum JSON-RPC (eth_*, net_*, web3_*) over the Fedrok chain,
// so MetaMask, ethers.js, viem, Foundry and other EVM tools can talk to a
// Fedrok node at /rpc.
const hex = (v) => '0x' + BigInt(v).toString(16);
const ZERO32 = '0x' + '0'.repeat(64);

function rpcError(code, message, data) {
  const e = new Error(message);
  e.code = code;
  if (data) e.data = data;
  return e;
}

export class EthRpc {
  constructor(chain) {
    this.chain = chain;
    this.methods = {
      web3_clientVersion: () => 'Fedrok/0.2.0 (EVM shanghai, Proof of Green)',
      net_version: () => String(this.s.chainId),
      net_listening: () => true,
      net_peerCount: () => '0x0',
      eth_chainId: () => hex(this.s.chainId),
      eth_syncing: () => false,
      eth_mining: () => false,
      eth_accounts: () => [],
      eth_blockNumber: () => hex(this.s.height),
      eth_gasPrice: () => hex(BigInt(this.s.params.minGasPrice) * 2n),
      eth_maxPriorityFeePerGas: () => hex(this.s.params.minGasPrice),
      eth_feeHistory: ([count, newest]) => this.feeHistory(Number(count), newest),
      eth_getBalance: async ([a]) => hex((await this.chain.getAccount(a)).balance),
      eth_getTransactionCount: async ([a, tag]) => (tag === 'pending' ? hex(this.chain.nextNonce(a.toLowerCase())) : hex((await this.chain.getAccount(a)).nonce)),
      eth_getCode: async ([a]) => (await this.chain.getAccount(a)).code,
      eth_getStorageAt: ([a, slot]) => this.chain.getStorageAt(a, slot),
      eth_call: ([tx]) => this.chain.call(tx),
      eth_estimateGas: async ([tx]) => hex(await this.chain.estimateGas(tx)),
      eth_sendRawTransaction: async ([raw]) => {
        try {
          return (await this.chain.addTx(raw)).hash;
        } catch (e) {
          throw rpcError(-32000, e.message);
        }
      },
      eth_getTransactionByHash: ([h]) => this.txByHash(h.toLowerCase()),
      eth_getTransactionReceipt: ([h]) => this.receipt(h.toLowerCase()),
      eth_getBlockByNumber: ([n, full]) => this.blockJSON(this.blockAt(n), full),
      eth_getBlockByHash: ([h, full]) => this.blockJSON(this.chain.getBlock(h.toLowerCase()), full),
      eth_getBlockTransactionCountByNumber: ([n]) => { const b = this.blockAt(n); return b ? hex(b.txs.length) : null; },
      eth_getLogs: ([f]) => this.getLogs(f || {}),
    };
  }

  get s() {
    return this.chain.state;
  }

  has(m) {
    return Boolean(this.methods[m]);
  }

  call(m, params) {
    return this.methods[m](params || []);
  }

  blockAt(n) {
    if (n === undefined || n === 'latest' || n === 'pending' || n === 'safe' || n === 'finalized') return this.chain.tip || this.genesisBlock();
    if (n === 'earliest') return this.genesisBlock();
    const h = Number(BigInt(n));
    return h === 0 ? this.genesisBlock() : this.chain.getBlock(h);
  }

  genesisBlock() {
    const g = this.chain.genesis;
    return { header: { height: 0, prevHash: ZERO32, timestamp: g.timestamp, validator: '0x' + '0'.repeat(40), stateRoot: this.chain.genesisStateRoot, gasUsed: '0', baseFeePerGas: g.params.minGasPrice, txRoot: ZERO32, receiptsRoot: ZERO32 }, txs: [], hash: this.chain.genesisHash };
  }

  blockJSON(b, full) {
    if (!b) return null;
    const h = b.header;
    return {
      number: hex(h.height), hash: b.hash, parentHash: h.prevHash, timestamp: hex(Math.floor(h.timestamp / 1000)),
      miner: h.validator, stateRoot: h.stateRoot, transactionsRoot: h.txRoot, receiptsRoot: h.receiptsRoot,
      gasLimit: hex(100_000_000), gasUsed: hex(h.gasUsed || 0), baseFeePerGas: hex(h.baseFeePerGas || 0),
      difficulty: '0x0', totalDifficulty: '0x0', nonce: '0x0000000000000000', sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
      logsBloom: '0x' + '0'.repeat(512), extraData: '0x', mixHash: ZERO32, size: '0x0', uncles: [], withdrawals: [], withdrawalsRoot: ZERO32,
      transactions: full ? b.txs.map((t, i) => this.txJSON(t, b, i)) : b.txs.map((t) => t.hash),
      // Proof of Green fields
      poa: { slot: h.slot, validator: h.validator, validatorSig: b.sig },
    };
  }

  txJSON(t, b, index) {
    const sig = this.sigOf(t);
    return {
      hash: t.hash, nonce: hex(t.nonce), from: t.from, to: t.to, value: hex(t.value), input: t.data, gas: hex(t.gasLimit),
      type: hex(t.evmType), maxFeePerGas: hex(t.maxFeePerGas), maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas), gasPrice: hex(b ? BigInt(b.header.baseFeePerGas) + BigInt(t.maxPriorityFeePerGas) : t.maxFeePerGas),
      chainId: hex(this.s.chainId), blockHash: b ? b.hash : null, blockNumber: b ? hex(b.header.height) : null, transactionIndex: b ? hex(index) : null,
      accessList: [], ...sig,
    };
  }

  sigOf(t) {
    const tx = t._tx;
    if (!tx) return {};
    return { v: hex(tx.v), r: hex(tx.r), s: hex(tx.s), yParity: hex(tx.v) };
  }

  txByHash(h) {
    const idx = this.chain.txIndex.get(h);
    if (idx) {
      const b = this.chain.blocks[idx.height - 1];
      return this.txJSON(b.txs[idx.index], b, idx.index);
    }
    const p = this.chain.mempool.get(h);
    return p ? this.txJSON(p, null, null) : null;
  }

  receipt(h) {
    const idx = this.chain.txIndex.get(h);
    if (!idx) return null;
    const b = this.chain.blocks[idx.height - 1];
    const t = b.txs[idx.index];
    let cumulative = 0n;
    let logIndex = 0;
    for (let i = 0; i < idx.index; i++) {
      const r = this.chain.txIndex.get(b.txs[i].hash).receipt;
      cumulative += BigInt(r.gasUsed);
      logIndex += r.logs.length;
    }
    const r = idx.receipt;
    cumulative += BigInt(r.gasUsed);
    return {
      transactionHash: h, transactionIndex: hex(idx.index), blockHash: b.hash, blockNumber: hex(b.header.height), from: t.from, to: t.to,
      cumulativeGasUsed: hex(cumulative), gasUsed: hex(r.gasUsed), effectiveGasPrice: hex(BigInt(r.fee) / BigInt(r.gasUsed || 1)),
      contractAddress: r.contractAddress, status: r.status === 'ok' ? '0x1' : '0x0', type: hex(t.evmType), logsBloom: '0x' + '0'.repeat(512),
      logs: r.logs.map((l, i) => ({ ...l, logIndex: hex(logIndex + i), transactionHash: h, transactionIndex: hex(idx.index), blockHash: b.hash, blockNumber: hex(b.header.height), removed: false })),
    };
  }

  getLogs(f) {
    if (f.blockHash) {
      const b = this.chain.getBlock(f.blockHash.toLowerCase());
      if (!b) return [];
      f = { ...f, fromBlock: b.header.height, toBlock: b.header.height };
    }
    const num = (x, d) => (x === undefined || x === 'latest' || x === 'pending' ? d : x === 'earliest' ? 0 : Number(BigInt(x)));
    const from = Math.max(1, num(f.fromBlock, this.s.height));
    const to = Math.min(this.s.height, num(f.toBlock, this.s.height));
    if (to - from > 10_000) throw rpcError(-32005, 'query returned more than 10000 blocks');
    const addrs = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase()) : null;
    const topics = f.topics || [];
    const out = [];
    for (let h = from; h <= to; h++) {
      const b = this.chain.blocks[h - 1];
      let logIndex = 0;
      b.txs.forEach((t, ti) => {
        for (const l of this.chain.txIndex.get(t.hash).receipt.logs) {
          const match = (!addrs || addrs.includes(l.address)) && topics.every((want, i) => want === null || want === undefined || (Array.isArray(want) ? want.includes(l.topics[i]) : want === l.topics[i]));
          if (match) out.push({ ...l, logIndex: hex(logIndex), transactionHash: t.hash, transactionIndex: hex(ti), blockHash: b.hash, blockNumber: hex(h), removed: false });
          logIndex++;
        }
      });
    }
    return out;
  }

  feeHistory(count, newest) {
    const last = newest === 'latest' || newest === undefined ? this.s.height : Number(BigInt(newest));
    const n = Math.max(1, Math.min(count || 1, 1024, last + 1));
    const base = hex(this.s.params.minGasPrice);
    return { oldestBlock: hex(last - n + 1), baseFeePerGas: Array(n + 1).fill(base), gasUsedRatio: Array(n).fill(0), reward: Array(n).fill([hex(this.s.params.minGasPrice)]) };
  }
}
