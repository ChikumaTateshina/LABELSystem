import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { LabelApp, toCaptionModel } from '../src/app.ts';
import { resolvePaths, type AppPaths } from '../src/config.ts';
import { buildFileName, sanitizeFileNamePart } from '../src/filename.ts';
import { formatPostDate, normalizeUserId, parsePostText } from '../src/parser.ts';
import { buildPage } from '../src/start.ts';
import type { SheetRow } from '../src/types.ts';
import { HEADERS, startFakeGas, type FakeGas } from './fakeSheet.ts';
import { fakeFonts } from './helpers.ts';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

let gas: FakeGas;
let app: LabelApp;
let paths: AppPaths;

before(async () => {
  gas = await startFakeGas([
    HEADERS,
    ['1', '夜', '風景部門', '星降る夜', 'Example User', 'example', '静かな夜の海を撮影しました。', '2026/09/01', '', 'https://x.com/example/status/1', '最優秀賞', ''],
    ['2', '夜', 'ポートレート部門', '朝の港', 'Sample Hanako', '@sample_hanako', 'あ'.repeat(400), '2026/09/02', '', '', '', ''],
  ]);
  const tmp = mkdtempSync(join(tmpdir(), 'label-app-'));
  process.env.LABEL_DATA_DIR = join(tmp, 'data');
  process.env.LABEL_OUTPUT_DIR = join(tmp, 'output');
  paths = resolvePaths(rootDir);
  delete process.env.LABEL_DATA_DIR;
  delete process.env.LABEL_OUTPUT_DIR;
  app = new LabelApp(paths, { fonts: fakeFonts(['Noto Sans JP']) });
});

after(() => gas.close());

test('初回: 未設定の状態で起動でき、テンプレートは選べる', () => {
  const state = app.state();
  assert.equal(state.configured, false);
  assert.deepEqual(state.templates.map((t) => t.id), ['example']);
  assert.equal(state.template, 'example');
});

test('接続設定: 接続を確認してから保存する。失敗した設定は保存しない', async () => {
  await assert.rejects(app.handle('saveSettings', { url: gas.url, token: 'wrong' }), /トークンが一致しません/);
  await assert.rejects(app.handle('saveSettings', { url: 'http://example.com/exec', token: 'x' }), /https/);
  assert.equal(existsSync(paths.configFile), false);

  const state = (await app.handle('saveSettings', { url: gas.url, token: gas.token })) as { configured: boolean };
  assert.equal(state.configured, true);
  assert.deepEqual(JSON.parse(readFileSync(paths.configFile, 'utf8')).sheet, { url: gas.url, token: gas.token });

  // 次回起動時は保存した設定で接続される
  const again = new LabelApp(paths, { fonts: fakeFonts(['Noto Sans JP']) });
  assert.equal(again.state().configured, true);
  assert.equal((await again.rows()).length, 2);
});

test('行の読み取り → テンプレートへ差し込み → プレビュー', async () => {
  const rows = (await app.handle('rows')) as SheetRow[];
  assert.deepEqual(rows.map((r) => r.title), ['星降る夜', '朝の港']);

  const preview = (await app.handle('preview', { row: rows[0], templateId: 'example' })) as {
    svg: string;
    warnings: { code: string }[];
  };
  for (const text of ['星降る夜', 'Example User', '@example', '静かな夜の海を撮影しました。', '>1<']) {
    assert.ok(preview.svg.includes(text), `${text} が差し込まれている`);
  }
  assert.deepEqual(preview.warnings, []);

  // コメントが長い行は、レイアウト破綻を検出する
  const long = (await app.handle('preview', { row: rows[1], templateId: '' })) as { warnings: { code: string; field: string }[] };
  assert.ok(long.warnings.some((w) => w.code === 'overflow' && w.field === 'comment'));
  await assert.rejects(app.handle('preview', { row: rows[0], templateId: 'missing' }), /見つかりません/);
});

test('出力: 選択した行を各形式で書き出し、まとめファイルも作る', async () => {
  const rows = await app.rows();
  const result = await app.output(rows, ['svg', 'pdf', 'png', 'html'], 'example', true);
  const files = readdirSync(paths.outputDir).sort();
  assert.deepEqual(files, [...result.files].sort());
  assert.ok(files.includes('1_example_星降る夜.pdf'));
  assert.ok(files.includes('2_sample_hanako_朝の港.png'));
  assert.ok(files.includes('captions-all.pdf') && files.includes('captions-all.html'));
  assert.equal(files.length, 2 * 4 + 2);

  assert.equal(readFileSync(join(paths.outputDir, '1_example_星降る夜.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.equal(readFileSync(join(paths.outputDir, '1_example_星降る夜.png')).subarray(1, 4).toString(), 'PNG');
  assert.ok(readFileSync(join(paths.outputDir, '1_example_星降る夜.html'), 'utf8').includes('<h1 class="caption-title">星降る夜</h1>'));

  // 修正が必要な作品だけを知らせる
  assert.deepEqual(result.warnings.map((w) => w.no), ['2']);
  assert.deepEqual(gas.sheet.writes, [], '出力ではスプレッドシートを変更しない');

  await assert.rejects(app.output([], ['pdf'], '', false), /行を選択/);
  await assert.rejects(app.output(rows, [], '', false), /出力形式/);
  await assert.rejects(app.handle('output', { rows, formats: ['exe'] }), /出力形式/);
});

test('画面から呼び出せる操作は限定されている', async () => {
  await assert.rejects(app.handle('constructor', {}), /不明な操作/);
  await assert.rejects(app.handle('saveConfig', {}), /不明な操作/);
  assert.equal(await app.handle('openUrl', { url: 'javascript:alert(1)' }), false);
  assert.equal(await app.handle('openUrl', { url: 'file:///C:/Windows/System32/calc.exe' }), false);
});

test('行 → テンプレート変数の変換', () => {
  const model = toCaptionModel({
    no: '12',
    theme: '夜',
    category: '風景部門',
    title: ' 星降る\n夜 ',
    username: 'Example User',
    userid: 'example',
    comment: 'a\r\nb\n',
    date: '2026/09/01',
    award: '最優秀賞',
    note: '',
  });
  assert.deepEqual(model, {
    no: '12',
    entry_number: '12',
    theme: '夜',
    category: '風景部門',
    title: '星降る 夜',
    username: 'Example User',
    userid: '@example',
    comment: 'a\nb',
    date: '2026/09/01',
    award: '最優秀賞',
    note: '',
  });
});

test('ファイル名: {No.}_{ユーザID}_{タイトル} とし、危険な文字を除去する', () => {
  assert.equal(buildFileName({ entry_number: '42', userid: '@example', title: '星降る夜' }, 'pdf'), '42_example_星降る夜.pdf');
  assert.equal(buildFileName({ entry_number: '1', userid: '@a', title: 'a/b\\c:d*e?f"g<h>i|j' }, 'svg'), '1_a_abcdefghij.svg');
  assert.equal(buildFileName({ entry_number: '1', userid: '', title: '' }, '.png'), '1_untitled.png');
  assert.equal(sanitizeFileNamePart('../..'), '');
  assert.equal(sanitizeFileNamePart('CON'), '_CON');
  assert.equal(sanitizeFileNamePart('a  b\tc'), 'a_b_c');
});

test('投稿本文の解析（ブラウザ拡張で使用）: 明示的なタイトルだけを抽出し、ハッシュタグ・URLを除く', () => {
  assert.deepEqual(parsePostText('タイトル：星降る夜\n\n夜の海を撮影しました。\n\n#ExamplePhotoContest https://t.co/abc'), {
    title: '星降る夜',
    comment: '夜の海を撮影しました。',
  });
  assert.equal(parsePostText('【タイトル】朝の港\nhello').title, '朝の港');
  assert.deepEqual(parsePostText('星降る夜\n夜の海'), { title: '', comment: '星降る夜\n夜の海' }, '推測はしない');
  assert.equal(normalizeUserId(' ＠example '), '@example');
  assert.equal(normalizeUserId(''), '');
  assert.match(formatPostDate('2026-09-28T03:00:00.000Z'), /^2026\/09\/2[78]$/);
  assert.equal(formatPostDate(undefined), '');
  assert.equal(formatPostDate('not a date'), '');
});

test('画面: CSSとJavaScriptを1つのHTMLへまとめる', () => {
  const page = buildPage({
    'index.html':
      '<head><link rel="icon" href="icon.png"><link rel="stylesheet" href="style.css"></head>' +
      '<body><script src="blocks.js"></script><script src="app.js"></script></body>',
    'style.css': 'body { color: red; }',
    'blocks.js': 'window.BlockEditor = 1;',
    'app.js': 'const s = "</script>"; const d = "$&";',
  });
  assert.ok(page.includes('<style>\nbody { color: red; }\n</style>'));
  assert.ok(page.includes('<script>\nwindow.BlockEditor = 1;\n</script>'));
  assert.ok(page.includes('const s = "<\\/script>"; const d = "$&";'));
  assert.equal(page.match(/<\/script>/g)?.length, 2);
  assert.ok(page.includes('<link rel="icon" href="icon.png">'), 'アイコンは別ファイルとして参照する');
});

test('テンプレート: 画面から複製・編集・保存でき、保存前の内容でもプレビューできる', async () => {
  const row = (await app.rows())[0];
  const files = (await app.handle('templateFiles', { templateId: 'example' })) as {
    json: string;
    svg: string;
    html: string;
    css: string;
  };
  assert.ok(files.svg.includes('{{title}}') && files.html.includes('caption-title') && files.css.includes('.caption'));

  // 保存していない編集内容が、SVGと「出力されるHTMLのコード一式」の両方へ反映される
  const edited = {
    ...files,
    json: JSON.stringify({ ...JSON.parse(files.json), id: 'my-design', name: 'My Design' }),
    svg: files.svg.replace('fill="#1a1a1a">{{title}}', 'fill="#cc0000">{{title}}'),
    html: '<h1 class="mine">{{title}} / {{award}}</h1>',
    css: '.mine { color: #cc0000; }',
  };
  const preview = (await app.handle('previewTemplate', { row, files: edited })) as { svg: string; html: string };
  assert.match(preview.svg, /fill="#cc0000"[^>]*><tspan[^>]*>星降る夜/);
  assert.ok(preview.html.startsWith('<!DOCTYPE html>'));
  assert.ok(preview.html.includes('<h1 class="mine">星降る夜 / 最優秀賞</h1>'));
  assert.ok(preview.html.includes('.mine { color: #cc0000; }'));
  assert.deepEqual(app.state().templates.map((t) => t.id), ['example'], 'プレビューだけでは保存されない');

  const saved = (await app.handle('saveTemplate', { files: edited })) as { saved: string; templates: { id: string }[]; template: string };
  assert.equal(saved.saved, 'my-design');
  assert.equal(saved.template, 'my-design');
  assert.deepEqual(saved.templates.map((t) => t.id).sort(), ['example', 'my-design']);
  assert.equal(readFileSync(join(paths.dataDir, 'templates', 'my-design', 'template.css'), 'utf8'), '.mine { color: #cc0000; }');

  // HTML / CSS を空にして保存すると、SVGを埋め込んだHTMLを出力するテンプレートになる
  await app.handle('saveTemplate', { files: { ...edited, html: '', css: '' } });
  assert.equal(existsSync(join(paths.dataDir, 'templates', 'my-design', 'template.html')), false);
  const result = await app.output([row], ['html'], 'my-design', false);
  assert.ok(readFileSync(join(paths.outputDir, result.files[0]), 'utf8').includes('caption--svg'));
});

test('テンプレート: 不正な内容は保存できず、理由を返す', async () => {
  const files = (await app.handle('templateFiles', { templateId: 'example' })) as { json: string; svg: string };
  const row = (await app.rows())[0];
  const withId = (id: string) => ({ ...files, json: JSON.stringify({ ...JSON.parse(files.json), id }) });

  await assert.rejects(app.handle('saveTemplate', { files: { ...files, json: '{' } }), /template\.json を解析できません/);
  await assert.rejects(app.handle('saveTemplate', { files: { ...files, svg: 'hello' } }), /<svg>/);
  await assert.rejects(app.handle('saveTemplate', { files: { json: files.json } }), /<svg>/);
  for (const id of ['../evil', 'a/b', '..', 'a b', '']) {
    await assert.rejects(app.handle('saveTemplate', { files: withId(id) }), /"id"/, `id: ${id}`);
  }
  await assert.rejects(app.handle('previewTemplate', { row, files: { ...files, json: '{}' } }), /"id" がありません/);
  await assert.rejects(app.handle('templateFiles', { templateId: 'missing' }), /見つかりません/);
  assert.equal(existsSync(join(paths.dataDir, 'templates', 'evil')), false);
});

test('フォント: PC内のフォント一覧を返し、出力時に埋め込める', async () => {
  assert.deepEqual(await app.handle('fonts'), ['Noto Sans JP']);
  const [row] = await app.rows();

  // SVG: 文字を輪郭にする（フォントが無い環境でも同じ見た目になる）
  const plain = await app.output([row], ['svg'], 'example', false, false);
  assert.ok(readFileSync(join(paths.outputDir, plain.files[0]), 'utf8').includes('<tspan'));
  const embedded = await app.output([row], ['svg', 'html'], 'example', true, true);
  const svg = readFileSync(join(paths.outputDir, embedded.files[0]), 'utf8');
  assert.ok(!svg.includes('<text') && svg.includes('data-glyph-outlines'));

  // HTML: 読み込めないフォントは内包せず、その旨を知らせる（テスト用フォントは実在しない）
  assert.equal(embedded.notes.length, 1);
  assert.match(embedded.notes[0], /Noto Sans JP.*内包できませんでした/);
  assert.deepEqual(plain.notes, []);
});

test('用紙サイズをピクセルで指定したテンプレートは、PNGをその画素数で出力する', async () => {
  const files = (await app.handle('templateFiles', { templateId: 'example' })) as { json: string; svg: string };
  const meta = { ...JSON.parse(files.json), id: 'pixels', width: '640px', height: '360px' };
  const svg = files.svg.replace('width="148mm" height="105mm" viewBox="0 0 1480 1050"', 'width="640px" height="360px" viewBox="0 0 640 360"');
  await app.handle('saveTemplate', { files: { json: JSON.stringify(meta), svg } });
  const [row] = await app.rows();
  const result = await app.output([row], ['png', 'pdf'], 'pixels', false);
  const png = readFileSync(join(paths.outputDir, result.files.find((f) => f.endsWith('.png'))!));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [640, 360]);
  // PDFは 96dpi 換算の実寸（640px = 480pt）
  const pdf = readFileSync(join(paths.outputDir, result.files.find((f) => f.endsWith('.pdf'))!)).toString('latin1');
  assert.match(pdf, /MediaBox \[0 0 480 270\]/);
});

test('画像と背景色: テンプレートへ埋め込んだ画像を、PDF・PNG・HTMLへ出力できる', async () => {
  // 2x2 ピクセルの赤いPNGを組み立てる
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8bit RGB
  const pixels = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]); // 各行: フィルタ0 + 赤2ピクセル
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
  const files = (await app.handle('templateFiles', { templateId: 'example' })) as { json: string; svg: string };
  const svg = files.svg
    .replace('fill="#ffffff"/>', 'fill="#102a43"/>')
    .replace('</svg>', `<image x="1000" y="700" width="300" height="300" href="data:image/png;base64,${png}"/>\n</svg>`);
  const json = JSON.stringify({ ...JSON.parse(files.json), id: 'with-image' });
  await app.handle('saveTemplate', { files: { json, svg, html: '<p>{{title}}</p><img alt="" src="data:image/png;base64,' + png + '">', css: '' } });

  const [row] = await app.rows();
  const result = await app.output([row], ['svg', 'pdf', 'png', 'html'], 'with-image', false);
  const read = (ext: string) => readFileSync(join(paths.outputDir, result.files.find((f) => f.endsWith(ext))!));
  assert.ok(read('.svg').toString().includes(`href="data:image/png;base64,${png}"`));
  assert.ok(read('.svg').toString().includes('fill="#102a43"'));
  assert.match(read('.pdf').toString('latin1'), /\/Subtype \/Image/);
  assert.equal(read('.png').subarray(1, 4).toString(), 'PNG');
  assert.ok(read('.html').toString().includes(`<img alt="" src="data:image/png;base64,${png}">`));
});

test('加筆修正: スプレッドシートを変えずに、このPCの中だけで行の内容を直せる', async () => {
  const writesBefore = gas.sheet.writes.length;
  const [row] = await app.rows();
  assert.equal(row.original, undefined);

  // タイトルとコメントを修正する
  const edited = (await app.handle('saveEdit', { row, changes: { title: '星降る夜（改題）', comment: '　字下げした\n修正後のコメント', username: row.username } })) as SheetRow;
  assert.equal(edited.title, '星降る夜（改題）');
  assert.deepEqual(edited.original, { title: '星降る夜', comment: '静かな夜の海を撮影しました。' }, '変えていない項目は記録しない');

  // 読み直しても、別の起動でも、修正が重ねられる。プレビューと出力にも使われる
  const again = new LabelApp(paths, { fonts: fakeFonts(['Noto Sans JP']) });
  const [reloaded, second] = await again.rows();
  assert.equal(reloaded.title, '星降る夜（改題）');
  assert.equal(second.original, undefined, 'ほかの行には影響しない');
  const svg = again.preview(reloaded, 'example').svg;
  assert.ok(svg.includes('星降る夜（改題）') && svg.includes('修正後のコメント'));
  assert.match(svg, /<tspan[^>]*>\u3000字下げした<\/tspan>/, '行頭の字下げ（全角空白）は残る');
  const result = await again.output([reloaded], ['svg'], 'example', false);
  assert.deepEqual(result.files, ['1_example_星降る夜（改題）.svg']);

  // 一部の項目だけをシートの値へ戻す
  const partly = (await app.handle('saveEdit', { row: reloaded, changes: { title: '星降る夜' } })) as SheetRow;
  assert.equal(partly.title, '星降る夜');
  assert.deepEqual(Object.keys(partly.original ?? {}), ['comment']);

  // すべて取り消す
  const cleared = (await app.handle('clearEdit', { row: partly })) as SheetRow;
  assert.equal(cleared.comment, '静かな夜の海を撮影しました。');
  assert.equal(cleared.original, undefined);
  assert.equal((await app.rows())[0].original, undefined);

  // No. とURLは修正の対象外。スプレッドシートには一切書き込まない
  const ignored = (await app.handle('saveEdit', { row: cleared, changes: { no: '999', postUrl: 'https://evil.example/' } })) as SheetRow;
  assert.equal(ignored.no, '1');
  assert.equal(ignored.original, undefined);
  assert.equal(gas.sheet.writes.length, writesBefore);
});
