// Append-only block storage on disk (Node only).
import fs from 'node:fs';
import path from 'node:path';

export class FileStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'blocks.jsonl');
  }
  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }
  load() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  append(block) {
    fs.appendFileSync(this.file, JSON.stringify(block) + '\n');
  }
  rewrite(blocks) {
    fs.writeFileSync(this.file, blocks.map((b) => JSON.stringify(b)).join('\n') + (blocks.length ? '\n' : ''));
  }
}
