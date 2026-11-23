// Bundles the web app (and its shared protocol modules, ethers and the EVM
// libraries) into one ES module with esbuild.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function bundleWeb(entry = 'web/app.js', { minify = true } = {}) {
  const result = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify,
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [{
      name: 'core-alias',
      setup(b) {
        b.onResolve({ filter: /^\/core\// }, (a) => ({ path: path.join(ROOT, 'src', a.path) }));
      },
    }],
  });
  return result.outputFiles[0].text;
}
