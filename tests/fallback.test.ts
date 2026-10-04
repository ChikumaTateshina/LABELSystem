import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCaptionModel } from '../src/app.ts';
import type { CaptionModel } from '../src/types.ts';
import { FontStack, graphemes, renderSvg, tokenize, wrapText } from '../src/render/index.ts';
import type { Template } from '../src/template.ts';
import { fakeFont, fakeFonts } from './helpers.ts';

const model: CaptionModel = toCaptionModel({
  title: '星降る夜',
  username: 'Example User',
  userid: '@example',
  comment: '',
  no: 'PC2026-001',
});

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

test('アウトライン化: すべての文字（固定の文字を含む）を輪郭にし、<text> を残さない', () => {
  const tpl = template(
    '<text id="comment" x="50" y="100" fill="#333">{{comment}}</text>' +
      '<text x="900" y="50" text-anchor="end" font-size="20" letter-spacing="10" fill="#888">A&amp;B</text>',
  );
  const caption = renderSvg({ ...model, comment: 'あい' }, tpl, installed, { outlineText: true });
  assert.ok(!caption.svg.includes('<text'), '文字要素は残らない');
  assert.ok(!caption.svg.includes('<tspan'));
  // 項目: 「あい」は x=50, y=100, 20/1000 倍で描く
  assert.match(caption.svg, /<g data-field="comment"[^>]*><g fill="#333" transform="translate\(50 100\) scale\(0\.02 -0\.02\)"><title>あい<\/title>/);
  // 固定の文字: 幅 = 3文字 × 10 + 字間 10 × 3 = 60。右揃えなので 900 - 60 から描き始め、字間の分だけ各文字をずらす
  assert.match(caption.svg, /<g fill="#888" transform="translate\(840 50\) scale\(0\.02 -0\.02\)"><title>A&amp;B<\/title>/);
  assert.match(caption.svg, /transform="translate\(1500 0\)"/, '2文字目は 1000 + 字間 10 / 0.02 = 1500');

  // 通常のレンダリングでは文字のまま
  assert.ok(renderSvg({ ...model, comment: 'あい' }, tpl, installed).svg.includes('<tspan x="50" dy="0">あい</tspan>'));
});

test('上下の揃え: 行数が最大行数より少ないとき、枠の中央・下端へ寄せる', () => {
  const svg = '<text id="comment" x="50" y="100">{{comment}}</text>';
  const withAlign = (valign?: 'top' | 'middle' | 'bottom') => ({
    ...template(svg),
    // 文字サイズ 20・行送り 1.5 倍（30）・最大3行 → 枠は 1行目 y=100 〜 3行目 y=160
    fields: { comment: { maxLines: 3, maxWidth: 400, fontSize: 20, minFontSize: 20, lineHeight: 1.5, valign } },
  });
  const firstDy = (text: string, valign?: 'top' | 'middle' | 'bottom') =>
    /<tspan x="50" dy="([^"]+)"/.exec(renderSvg({ ...model, comment: text }, withAlign(valign), installed).svg)?.[1];

  assert.equal(firstDy('あ'), '0');
  assert.equal(firstDy('あ', 'top'), '0');
  assert.equal(firstDy('あ', 'middle'), '30', '1行なら、2行目の位置（中央）に置く');
  assert.equal(firstDy('あ', 'bottom'), '60', '1行なら、3行目の位置（下端）に置く');
  assert.equal(firstDy('あ\nい', 'middle'), '15');
  assert.equal(firstDy('あ\nい', 'bottom'), '30');
  assert.equal(firstDy('あ\nい\nう', 'middle'), '0', '枠いっぱいのときは動かさない');
  assert.equal(firstDy('あ\nい\nう\nえ', 'bottom'), '0', 'あふれているときは上から並べる');

  // 2行目以降の行送りは変わらない
  assert.match(renderSvg({ ...model, comment: 'あ\nい' }, withAlign('bottom'), installed).svg, /dy="30">あ<\/tspan><tspan x="50" dy="30">い/);
  // 絵文字を含む行（輪郭として描く）も、同じだけずれる
  const mixed = renderSvg({ ...model, comment: 'あ🌙' }, withAlign('bottom'), installed).svg;
  assert.match(mixed, /<tspan x="50" dy="60">あ<\/tspan>/);
  assert.match(mixed, /translate\(70 160\)/);
});
