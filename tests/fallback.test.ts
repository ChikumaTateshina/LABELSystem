import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CaptionModel } from '../packages/shared-types/index.ts';
import { FontStack, graphemes, renderSvg, tokenize, wrapText } from '../packages/renderer/index.ts';
import type { Template } from '../packages/template-engine/index.ts';
import { fakeFont, fakeFonts } from './helpers.ts';

const model: CaptionModel = {
  title: '星降る夜',
  username: 'Example User',
  userid: '@example',
  comment: '',
  entry_number: 'PC2026-001',
};

function template(svgText: string): Template {
  return {
    id: 'test',
    name: 'Test',
    version: '1.0',
    width: '100mm',
    height: '50mm',
    fonts: ['Test Sans'],
    fallbackFonts: [],
    fields: { comment: { maxLines: 3, maxWidth: 400, fontSize: 20, minFontSize: 20, lineHeight: 1.5 } },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500">${svgText}</svg>`,
    html: null,
    css: null,
    dir: '',
  };
}

const installed = fakeFonts(['Test Sans', 'Segoe UI Emoji']);

test('書記素クラスタ: 結合絵文字・肌色・国旗を1文字として扱う', () => {
  assert.deepEqual(graphemes('a👨‍👩‍👧b'), ['a', '👨‍👩‍👧', 'b']);
  assert.deepEqual(graphemes('👋🏽🇯🇵'), ['👋🏽', '🇯🇵']);
  assert.deepEqual(tokenize('旗🏳️‍🌈です'), ['旗', '🏳️‍🌈', 'で', 'す']);
});

test('改行計算: 結合絵文字の途中では折り返さない', () => {
  const lines = wrapText('👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧', 1, () => 2);
  assert.deepEqual(lines, ['👨‍👩‍👧', '👨‍👩‍👧', '👨‍👩‍👧']);
});

test('FontStack: 文字ごとに収録フォントを選び、同じフォントの範囲をまとめる', () => {
  const stack = new FontStack(fakeFont('Test Sans'), installed, []);
  assert.deepEqual(
    stack.runs('夜🌙✨です').map((run) => `${run.font.family}:${run.text}`),
    ['Test Sans:夜', 'Segoe UI Emoji:🌙', 'Test Sans:✨です'],
  );
  // 主フォントのみの文字列は主フォントの幅、混在する場合はrunごとの幅の合計
  assert.equal(stack.measure('夜です', 10), 30);
  assert.equal(stack.measure('夜🌙', 10), 20);

  const { substituted, missing } = stack.inspect('夜🌙🌙😀');
  assert.deepEqual([...substituted], [['Segoe UI Emoji', ['🌙', '😀']]]);
  assert.deepEqual(missing, []);
});

test('FontStack: どのフォントにも無い文字は missing として報告する', () => {
  const stack = new FontStack(fakeFont('Test Sans'), fakeFonts(['Test Sans']), []);
  assert.deepEqual(stack.inspect('夜🌙').missing, ['🌙']);
  assert.deepEqual(stack.runs('夜🌙').map((run) => run.text), ['夜🌙']);
});

test('SVG: 絵文字は代替フォントの輪郭として描画し、文字位置を絶対座標で配置する', () => {
  const caption = renderSvg(
    { ...model, comment: '夜🌙です' },
    template('<text id="comment" x="50" y="100" fill="#333">{{comment}}</text>'),
    installed,
  );
  assert.deepEqual(caption.warnings.map((w) => `${w.code}:${w.level}:${w.field}`), ['glyph-fallback:info:comment']);

  // 「夜」(幅20) → 絵文字(幅20) → 「です」。絵文字の後ろは x = 50 + 20 + 20 から再開する
  assert.match(caption.svg, /<tspan x="50" dy="0">夜<\/tspan><tspan x="90" dy="0">です<\/tspan><\/text>/);
  assert.match(
    caption.svg,
    /<g fill="#333" transform="translate\(70 100\) scale\(0\.02 -0\.02\)"><title>🌙<\/title><path fill="rgb\(255,176,46\)" d="M0 0H1000V1000H0Z"\/><\/g>/,
  );
  assert.ok(!caption.svg.includes('font-family="Segoe UI Emoji'), '代替フォント自体には依存しない');
  assert.deepEqual(caption.fonts.map((font) => font.family), ['Test Sans']);
});

test('SVG: 複数行・中央揃えでも絵文字の位置を計算する', () => {
  const caption = renderSvg(
    { ...model, comment: 'あ\n🌙い' },
    template('<text id="comment" x="500" y="100" text-anchor="middle">{{comment}}</text>'),
    installed,
  );
  // 1行目: 幅20 → 490 から。2行目: 幅40 → 絵文字が 480、「い」が 500、行送り 30
  assert.match(caption.svg, /text-anchor="start"/);
  assert.match(caption.svg, /<tspan x="490" dy="0">あ<\/tspan><tspan x="500" dy="30">い<\/tspan>/);
  assert.match(caption.svg, /translate\(480 130\)/);
});

test('SVG: 代替フォントも無い文字は従来どおり警告する', () => {
  const caption = renderSvg(
    { ...model, comment: '夜🌙' },
    template('<text id="comment" x="50" y="100">{{comment}}</text>'),
    fakeFonts(['Test Sans']),
  );
  assert.deepEqual(caption.warnings.map((w) => `${w.code}:${w.level}`), ['glyph-missing:warning']);
  assert.match(caption.svg, /<tspan x="50" dy="0">夜🌙<\/tspan>/);
});
