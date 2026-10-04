/**
 * ブラウザ拡張をビルドする。
 *   npm run build
 * extension/dist/ に、Chrome / Edge / Firefox へそのまま読み込める一式を出力する。
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'extension');
const dist = join(src, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: { content: join(src, 'src', 'content.ts'), popup: join(src, 'src', 'popup.ts') },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115'],
  legalComments: 'none',
  logLevel: 'info',
});

for (const file of ['manifest.json', 'popup.html', 'popup.css']) {
  cpSync(join(src, file), join(dist, file));
}

console.log(`extension built: ${dist}`);
