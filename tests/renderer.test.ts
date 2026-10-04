import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toCaptionModel } from '../src/app.ts';
import type { CaptionModel } from '../src/types.ts';
import {
  CaptionRenderer,
  extractFromCollection,
  readFontFile,
  fitText,
  renderSvg,
  tokenize,
  wrapText,
  type Measure,
} from '../src/render/index.ts';
import {
  FsTemplateRepository,
  decodeText,
  loadTemplate,
  lengthToMm,
  mmToPt,
  mmToPx,
  substituteVariables,
  type Template,
} from '../src/template.ts';
import { fakeFont, fakeFonts } from './helpers.ts';

/** 全角 1em / 半角 0.5em */
const measure: Measure = (text, size) =>
  Array.from(text).reduce((sum, ch) => sum + (ch.codePointAt(0)! < 0x2000 ? 0.5 : 1), 0) * size;
const width10 = (text: string) => measure(text, 10);

const model: CaptionModel = toCaptionModel({
  title: '星降る夜',
  username: 'Example User',
  userid: '@example',
  comment: 'コメントです。',
  no: 'PC2026-001',
});

function template(overrides: Partial<Template> = {}): Template {
  return {
    id: 'test',
    name: 'Test',
    version: '1.0',
    width: '100mm',
    height: '50mm',
    fonts: ['Test Sans'],
    fallbackFonts: [],
    fields: {
      title: { required: true, maxLines: 1, maxWidth: 400, fontSize: 40, minFontSize: 30 },
      comment: { maxLines: 2, maxWidth: 200, fontSize: 20, minFontSize: 20, lineHeight: 1.5 },
    },
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 1000 500">' +
      '<text id="title" x="50" y="100">{{title}}</text>' +
      '<text id="comment" x="50" y="200" fill="#333">{{ comment }}</text>' +
      '<desc>{{username}} / {{userid}} / {{entry_number}} / {{unknown}}</desc></svg>',
    html: null,
    css: null,
    dir: '',
    ...overrides,
  };
}

// ---- テンプレート変数置換 ---------------------------------------------------

test('テンプレート変数置換: エスケープし、未定義の変数は空にする', () => {
  assert.equal(
    substituteVariables('<p>{{ title }}|{{userid}}|{{nope}}</p>', { title: '<a & "b">', userid: '@x' }),
    '<p>&lt;a &amp; &quot;b&quot;&gt;|@x|</p>',
  );
});

test('長さの単位変換', () => {
  assert.equal(lengthToMm('148mm'), 148);
  assert.equal(lengthToMm('1in'), 25.4);
  assert.ok(Math.abs(mmToPt(148) - 419.5276) < 0.001);
  assert.equal(mmToPx(148, 300), 1748);
  assert.throws(() => lengthToMm('wide'));
});

test('テンプレート探索: 先に指定したディレクトリを優先する', () => {
  const base = mkdtempSync(join(tmpdir(), 'label-tpl-'));
  const write = (dir: string, id: string, name: string) => {
    const path = join(base, dir, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'template.json'), JSON.stringify({ id, name, width: '10mm', height: '10mm' }));
    writeFileSync(join(path, 'template.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  };
  write('private', 'shared', 'Private');
  write('bundled', 'shared', 'Bundled');
  write('bundled', 'example', 'Example');
  mkdirSync(join(base, 'bundled', 'broken'));
  writeFileSync(join(base, 'bundled', 'broken', 'template.json'), '{');

  const repo = new FsTemplateRepository([join(base, 'private'), join(base, 'missing'), join(base, 'bundled')]);
  assert.deepEqual(repo.list().map((t) => `${t.id}:${t.name}`).sort(), ['example:Example', 'shared:Private']);
  assert.equal(repo.get('shared')?.name, 'Private');
  assert.equal(repo.get('nope'), null);
});

// ---- 改行計算 ---------------------------------------------------------------

test('改行計算: 実幅で折り返し、明示的な改行を維持する', () => {
  assert.deepEqual(wrapText('あいうえおかきくけこ', 50, width10), ['あいうえお', 'かきくけこ']);
  assert.deepEqual(wrapText('あい\n\nうえ', 50, width10), ['あい', '', 'うえ']);
  assert.deepEqual(wrapText('', 50, width10), ['']);
});

test('改行計算: 欧文は単語単位で折り返し、長すぎる単語は分割する', () => {
  assert.deepEqual(wrapText('hello world foo', 60, width10), ['hello world', 'foo']);
  assert.deepEqual(wrapText('abcdefghijklmnopqrstuvwxyz', 50, width10), ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
});

test('改行計算: 禁則処理（句読点を行頭に、開き括弧を行末に置かない）', () => {
  assert.deepEqual(tokenize('あ。「い」'), ['あ。', '「い」']);
  const lines = wrapText('あいうえお。かきく', 50, width10);
  assert.ok(lines.every((line) => !line.startsWith('。')));
  assert.deepEqual(lines, ['あいうえ', 'お。かきく']);
});

test('文字サイズ調整: 収まる場合は縮小しない', () => {
  const fit = fitText('星降る夜', { maxWidth: 400, maxLines: 1, fontSize: 40, minFontSize: 30 }, measure);
  assert.deepEqual(fit, { lines: ['星降る夜'], fontSize: 40, shrunk: false, overflow: false });
});

test('文字サイズ調整: 許容範囲内で縮小して収める', () => {
  // 12文字 × 40 = 480 > 400。400 / 12 = 33.3 なので 33 まで縮小すれば1行に収まる
  const fit = fitText('あ'.repeat(12), { maxWidth: 400, maxLines: 1, fontSize: 40, minFontSize: 30 }, measure);
  assert.equal(fit.lines.length, 1);
  assert.equal(fit.fontSize, 33);
  assert.equal(fit.shrunk, true);
  assert.equal(fit.overflow, false);
});

test('文字サイズ調整: 最小サイズでも収まらなければオーバーフローとし、それ以上縮小しない', () => {
  const fit = fitText('あ'.repeat(40), { maxWidth: 400, maxLines: 1, fontSize: 40, minFontSize: 30 }, measure);
  assert.equal(fit.fontSize, 30);
  assert.equal(fit.overflow, true);
  assert.ok(fit.lines.length > 1);
});

// ---- SVGレンダリング --------------------------------------------------------

test('SVG: 変数を差し込み、コメントをtspanへ行分割する', () => {
  const caption = renderSvg({ ...model, comment: 'あいうえおかきくけこさしす' }, template(), fakeFonts(['Test Sans']));
  assert.deepEqual(caption.warnings, []);
  assert.match(caption.svg, /<text id="title" x="50" y="100" font-size="40" font-family="Test Sans, sans-serif">/);
  assert.match(caption.svg, /<tspan x="50" dy="0">星降る夜<\/tspan>/);
  assert.match(caption.svg, /<tspan x="50" dy="0">あいうえおかきくけこ<\/tspan><tspan x="50" dy="30">さしす<\/tspan>/);
  assert.match(caption.svg, /<desc>Example User \/ @example \/ PC2026-001 \/ <\/desc>/);
  assert.equal(caption.fonts.length, 1);
});

test('SVG: 空行は次の行のdyへ行送りを積み増す', () => {
  const caption = renderSvg(
    { ...model, comment: 'あ\n\nい' },
    template({ fields: { comment: { maxLines: 3, maxWidth: 200, fontSize: 20, lineHeight: 1.5 } } }),
    fakeFonts(['Test Sans']),
  );
  assert.match(caption.svg, /<tspan x="50" dy="0">あ<\/tspan><tspan x="50" dy="60">い<\/tspan>/);
});

test('SVG: XMLとして危険な文字をエスケープする', () => {
  const caption = renderSvg({ ...model, title: '<script>&"', comment: '' }, template(), fakeFonts(['Test Sans']));
  assert.ok(caption.svg.includes('&lt;script&gt;&amp;&quot;'));
  assert.ok(!caption.svg.includes('<script>'));
});

test('SVG: コメントが長い場合にレイアウト破綻（オーバーフロー）を検出する', () => {
  const caption = renderSvg({ ...model, comment: 'あ'.repeat(40) }, template(), fakeFonts(['Test Sans']));
  const overflow = caption.warnings.find((w) => w.code === 'overflow');
  assert.equal(overflow?.field, 'comment');
  assert.equal(overflow?.level, 'warning');
});

test('SVG: 縮小・必須項目の空欄・表示できない文字を通知する', () => {
  const caption = renderSvg(
    { ...model, title: '', comment: '夜🌙' },
    template(),
    fakeFonts(['Test Sans']),
  );
  assert.deepEqual(caption.warnings.map((w) => `${w.code}:${w.field}`).sort(), [
    'glyph-missing:comment',
    'required-empty:title',
  ]);

  const shrunk = renderSvg({ ...model, title: 'あ'.repeat(12) }, template(), fakeFonts(['Test Sans']));
  assert.deepEqual(shrunk.warnings.map((w) => `${w.code}:${w.level}`), ['shrunk:info']);
  assert.match(shrunk.svg, /id="title"[^>]*font-size="33"/);
});

test('SVG: 指定フォントが無い場合は代替フォントを使い警告する', () => {
  const caption = renderSvg(model, template({ fallbackFonts: ['Fallback Sans'] }), fakeFonts(['Fallback Sans']));
  assert.equal(caption.warnings.filter((w) => w.code === 'font-missing').length, 1);
  assert.match(caption.svg, /font-family="Fallback Sans, sans-serif"/);

  const none = renderSvg(model, template(), fakeFonts([]));
  assert.equal(none.warnings.filter((w) => w.code === 'font-missing').length, 1);
  assert.match(none.svg, /星降る夜/);
});

// ---- HTML / PDF / PNG -------------------------------------------------------

test('HTML: template.html / template.css を使い、CSSを内包した単一HTMLを出力する', () => {
  const renderer = new CaptionRenderer(fakeFonts(['Test Sans']));
  const tpl = template({
    html: '<!-- note --><h1 class="caption-title">{{title}}</h1><p class="caption-comment">{{comment}}</p>',
    css: '.caption-title { color: red; }',
  });
  const html = renderer.toHtml([renderer.render({ ...model, comment: '<b>1行目</b>\n2行目' }, tpl)]);

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.match(html, /<title>星降る夜<\/title>/);
  assert.match(html, /--caption-width: 100mm;/);
  assert.match(html, /--comment-max-lines: 2;/);
  assert.match(html, /\.caption-title \{ color: red; \}/);
  assert.match(html, /<article class="caption" data-entry-number="PC2026-001">/);
  assert.match(html, /<p class="caption-comment">&lt;b&gt;1行目&lt;\/b&gt;\n2行目<\/p>/);
  assert.ok(!html.includes('<!-- note -->'));
  assert.ok(!html.includes('<link'), '外部CSSに依存しない');
});

test('HTML: HTMLテンプレートが無い場合はSVGを埋め込む。複数件を1ファイルにまとめられる', () => {
  const renderer = new CaptionRenderer(fakeFonts(['Test Sans']));
  const captions = [model, { ...model, title: '朝の港', entry_number: 'PC2026-002' }].map((m) =>
    renderer.render(m, template()),
  );
  const html = renderer.toHtml(captions, { title: 'All' });
  assert.equal(html.match(/<article class="caption caption--svg"/g)?.length, 2);
  assert.equal(html.match(/<svg /g)?.length, 2);
  assert.match(html, /<title>All<\/title>/);
});

test('PDF / PNG: SVGから生成でき、PDFは実寸のページサイズになる', async () => {
  const renderer = new CaptionRenderer(fakeFonts([]), { pngDpi: 72 });
  const caption = renderer.render(model, template());

  const pdf = await renderer.output(caption, 'pdf');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const mediaBox = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString('latin1'));
  assert.ok(mediaBox);
  assert.ok(Math.abs(Number(mediaBox[1]) - mmToPt(100)) < 0.01);
  assert.ok(Math.abs(Number(mediaBox[2]) - mmToPt(50)) < 0.01);

  const combined = await renderer.toPdf([caption, caption]);
  assert.equal(combined.toString('latin1').match(/\/Type \/Page\b/g)?.length, 2);

  const png = await renderer.output(caption, 'png');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), mmToPx(100, 72));

  assert.equal((await renderer.output(caption, 'svg')).toString(), caption.svg);
});

test('HTML: フォントファイルを @font-face として内包できる（.ttf / .otf のみ）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'label-font-'));
  const ttf = join(dir, 'Test Sans.ttf');
  writeFileSync(ttf, Buffer.from('dummy font data'));
  const renderer = new CaptionRenderer(fakeFonts(['Test Sans']));
  const tpl = template({ html: '<p>{{title}}</p>', css: '.caption { font-family: "Test Sans"; }' });
  const caption = { ...renderer.render(model, tpl), fonts: [{ ...fakeFont('Test Sans'), path: ttf }] };

  const { html, notEmbedded } = renderer.toHtmlEmbedded([caption]);
  assert.deepEqual(notEmbedded, []);
  assert.match(html, /@font-face \{\n {2}font-family: "Test Sans";\n {2}src: url\(data:font\/ttf;base64,ZHVtbXkgZm9udCBkYXRh\) format\("truetype"\);\n\}/);
  assert.ok(!renderer.toHtml([caption]).includes('@font-face'), '通常の出力では内包しない');

  // 読み込めないフォントは内包せず、その名前を返す
  const missing = { ...caption, fonts: [{ ...fakeFont('Test Sans'), path: join(dir, 'missing.ttf') }] };
  const skipped = renderer.toHtmlEmbedded([missing]);
  assert.deepEqual(skipped.notEmbedded, ['Test Sans']);
  assert.ok(!skipped.html.includes('@font-face'));

  // HTMLテンプレートが無い場合は、文字を輪郭にしたSVGを埋め込む
  const svgOnly = renderer.toHtmlEmbedded([renderer.render(model, template())]);
  assert.ok(svgOnly.html.includes('data-glyph-outlines') && !svgOnly.html.includes('<text'));
});

test('フォントコレクション（.ttc）から、指定した書体だけを単独のフォントとして取り出す', () => {
  // 2書体・各2テーブルの最小のコレクションを組み立てる（'shar' は両方の書体が共有するテーブル）
  const table = (text: string) => Buffer.from(text, 'latin1');
  const shared = table('SHARED!'); // 7バイト（4バイト境界への詰め物が必要）
  const own = [table('first-font'), table('second-font-data')];
  const header = 12 + 2 * 4;
  const fontHeader = 12 + 2 * 16;
  const dataStart = header + fontHeader * 2;
  const offsets = { shared: dataStart, own0: dataStart + 8, own1: dataStart + 8 + 12 };
  const ttc = Buffer.alloc(offsets.own1 + 16);
  ttc.write('ttcf', 0, 'latin1');
  ttc.writeUInt32BE(0x00010000, 4);
  ttc.writeUInt32BE(2, 8);
  [0, 1].forEach((i) => {
    const start = header + fontHeader * i;
    ttc.writeUInt32BE(start, 12 + i * 4);
    ttc.writeUInt32BE(i === 0 ? 0x00010000 : 0x4f54544f, start); // 2つ目は 'OTTO'
    ttc.writeUInt16BE(2, start + 4);
    const records: [string, number, number][] = [
      ['shar', offsets.shared, shared.length],
      ['own ', i === 0 ? offsets.own0 : offsets.own1, own[i].length],
    ];
    records.forEach(([tag, offset, length], r) => {
      const record = start + 12 + r * 16;
      ttc.write(tag, record, 'latin1');
      ttc.writeUInt32BE(0xabcd0000 + r, record + 4);
      ttc.writeUInt32BE(offset, record + 8);
      ttc.writeUInt32BE(length, record + 12);
    });
  });
  shared.copy(ttc, offsets.shared);
  own[0].copy(ttc, offsets.own0);
  own[1].copy(ttc, offsets.own1);

  const read = (font: Buffer, index: number) => {
    const record = 12 + index * 16;
    const offset = font.readUInt32BE(record + 8);
    return [font.toString('latin1', record, record + 4), font.toString('latin1', offset, offset + font.readUInt32BE(record + 12))];
  };
  const second = extractFromCollection(ttc, 1)!;
  assert.equal(second.toString('latin1', 0, 4), 'OTTO');
  assert.equal(second.readUInt16BE(4), 2);
  assert.deepEqual(read(second, 0), ['shar', 'SHARED!']);
  assert.deepEqual(read(second, 1), ['own ', 'second-font-data']);
  assert.equal(second.readUInt32BE(12 + 8) % 4, 0, 'テーブルは4バイト境界に置く');
  assert.equal(second.length, 12 + 32 + 8 + 16);
  assert.deepEqual(read(extractFromCollection(ttc, 0)!, 1), ['own ', 'first-font']);

  assert.equal(extractFromCollection(ttc, 2), null);
  assert.equal(extractFromCollection(Buffer.from('not a collection'), 0), null);

  // ファイルから読み込む場合: 書体を特定できなければ先頭の書体を使い、形式を判定する
  const dir = mkdtempSync(join(tmpdir(), 'label-ttc-'));
  writeFileSync(join(dir, 'fonts.ttc'), ttc);
  const file = readFontFile({ path: join(dir, 'fonts.ttc'), postscriptName: 'Unknown' });
  assert.equal(file?.format, 'truetype');
  assert.deepEqual(read(file!.data, 1), ['own ', 'first-font']);
  assert.equal(readFontFile({ path: join(dir, 'missing.ttc'), postscriptName: 'X' }), null);
});

test('テンプレートの文字コード: UTF-8 以外（Shift_JIS・UTF-16）で保存されたファイルも正しく読む', () => {
  // 「星降る夜」を各文字コードで表したもの
  const sjis = Buffer.from([0x90, 0xaf, 0x8d, 0x7e, 0x82, 0xe9, 0x96, 0xe9]);
  assert.equal(decodeText(Buffer.concat([Buffer.from('<text>'), sjis, Buffer.from('</text>')])), '<text>星降る夜</text>');
  assert.equal(decodeText(Buffer.from('星降る夜', 'utf8')), '星降る夜');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('星降る夜', 'utf8')])), '星降る夜', 'BOMは取り除く');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('星降る夜', 'utf16le')])), '星降る夜');
  assert.equal(decodeText(Buffer.from('plain ascii')), 'plain ascii');

  // Shift_JIS で保存されたテンプレートを読み込んでも、固定の文字が壊れない
  const dir = mkdtempSync(join(tmpdir(), 'label-sjis-'));
  writeFileSync(join(dir, 'template.json'), JSON.stringify({ id: 'sjis', width: '10mm', height: '10mm' }));
  writeFileSync(
    join(dir, 'template.svg'),
    Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="0">'), sjis, Buffer.from('</text></svg>')]),
  );
  assert.ok(loadTemplate(dir).svg.includes('<text x="0" y="0">星降る夜</text>'));
});

test('改行計算: 段落の先頭の空白（字下げ）は残し、折り返した行の先頭の空白は捨てる', () => {
  assert.deepEqual(wrapText('　あい\n　うえ', 50, width10), ['　あい', '　うえ']);
  assert.deepEqual(wrapText('hello world foo', 60, width10), ['hello world', 'foo']);
  assert.deepEqual(wrapText('あいうえお　かきく', 50, width10), ['あいうえお', 'かきく']);
});
