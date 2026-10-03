/**
 * レンダリング経路の動作確認用スクリプト。
 *   npx tsx scripts/smoke-render.ts [出力ディレクトリ]
 * サンプルテンプレートと架空データから SVG / PDF / PNG / HTML を生成する。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCaptionModel } from '../packages/core/index.ts';
import { CaptionRenderer, FontRegistry, OUTPUT_FORMATS } from '../packages/renderer/index.ts';
import { loadTemplate } from '../packages/template-engine/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = resolve(process.argv[2] ?? join(root, 'output', 'smoke'));
mkdirSync(outDir, { recursive: true });

const started = Date.now();
const renderer = new CaptionRenderer(new FontRegistry(undefined, join(outDir, 'font-index.json')));
const template = loadTemplate(join(root, 'templates', 'example'));
const model = toCaptionModel(
  {
    title: '星降る夜🌙',
    userDisplayName: 'サンプル太郎',
    userId: 'sample_taro',
    comment:
      '静かな夜の海を撮影しました。\n波の少ない瞬間がお気に入りです。\n\nThis is example data for checking automatic line wrapping in the caption renderer.',
  },
  'PC2026-001',
);

const caption = renderer.render(model, template);
console.log(`render: ${Date.now() - started}ms`);
for (const warning of caption.warnings) console.log(`[${warning.level}] ${warning.message}`);
console.log('fonts:', caption.fonts.map((f) => `${f.family} (${f.path})`).join(', ') || '(none)');

for (const format of OUTPUT_FORMATS) {
  const file = join(outDir, `smoke.${format}`);
  writeFileSync(file, await renderer.output(caption, format));
  console.log(`wrote ${file}`);
}
