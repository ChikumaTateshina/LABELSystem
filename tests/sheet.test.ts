import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolvePaths } from '../apps/server/src/config.ts';
import { CaptionService, HttpError } from '../apps/server/src/service.ts';
import { ValidationError, parseSheetPayload } from '../packages/core/index.ts';
import { fakeFonts } from './helpers.ts';

test('シート解析: GASのJSON（列名キー）を読み込み、行IDから重複判定キーを作る', () => {
  const inputs = parseSheetPayload(
    JSON.stringify({
      entries: [
        { タイトル: '星降る夜', ユーザー名: 'Example User', ユーザーID: 'example', コメント: '夜の海', id: 'row-1' },
        { title: '朝の港', user_id: '@sample', source_post_url: 'https://x.com/sample/status/123', id: 'row-2' },
        { title: '', user_id: '', id: 'row-3' },
      ],
    }),
  );
  assert.equal(inputs.length, 2, '空行は無視する');
  assert.deepEqual(
    inputs.map((i) => [i.title, i.userId, i.sourcePostId, i.sourcePlatform]),
    [
      ['星降る夜', '@example', 'sheet:row-1', 'spreadsheet'],
      ['朝の港', '@sample', '123', undefined],
    ],
  );
});

test('シート解析: 公開CSVを読み込み、id列が無ければ内容のハッシュをキーにする', () => {
  const csv = 'タイトル,ユーザー名,ユーザーID,コメント\n星降る夜,Example User,@example,夜の海\n';
  const [first] = parseSheetPayload(csv);
  const [again] = parseSheetPayload(csv.replace('夜の海', 'コメントを修正'));
  assert.match(first.sourcePostId ?? '', /^sheet:[0-9a-f]{16}$/);
  assert.equal(first.sourcePostId, again.sourcePostId, 'コメントの修正では別作品にならない');
  assert.notEqual(parseSheetPayload(csv.replace('星降る夜', '別の作品'))[0].sourcePostId, first.sourcePostId);
});

test('シート解析: エラー応答・HTML応答を検出する', () => {
  assert.throws(() => parseSheetPayload('{"error":"unauthorized"}'), /unauthorized/);
  assert.throws(() => parseSheetPayload('<!DOCTYPE html><html>'), ValidationError);
  assert.throws(() => parseSheetPayload('{"foo":1}'), ValidationError);
  assert.deepEqual(parseSheetPayload('{"entries":[]}'), []);
});

test('シート同期: 新しい行だけを取り込み、再同期しても二重登録しない', async () => {
  const rows = [
    { title: '星降る夜', user_display_name: 'Example User', user_id: '@example', comment: '夜の海', id: 'a' },
    { title: '朝の港', user_display_name: 'Sample', user_id: '@sample', comment: '', id: 'b' },
  ];
  let lastToken: string | null = null;
  const sheet = createServer((req, res) => {
    lastToken = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastToken === 'secret' ? { entries: rows } : { error: 'unauthorized' }));
  });
  await new Promise<void>((resolve) => sheet.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(sheet.address() as AddressInfo).port}/exec`;

  const dataDir = join(mkdtempSync(join(tmpdir(), 'label-sheet-')), 'data');
  mkdirSync(dataDir, { recursive: true });
  const writeConfig = (token: string) =>
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({ event: { name: 'Sheet Test', entryNumberPrefix: 'S' }, sheet: { url, token } }),
    );
  const open = () => new CaptionService(resolvePaths({ dataDir }), { fonts: fakeFonts([]) });

  writeConfig('secret');
  let service = open();
  try {
    assert.deepEqual(await service.syncSheet(), { fetched: 2, created: 2, unchanged: 0, skipped: [] });
    assert.equal(lastToken, 'secret');
    assert.deepEqual(service.entries.list().map((e) => [e.entryNumber, e.title, e.source?.platform]), [
      ['001', '星降る夜', 'spreadsheet'],
      ['002', '朝の港', 'spreadsheet'],
    ]);

    // 管理画面で修正した内容は、再同期しても上書きされない
    const first = service.entries.list()[0];
    service.updateEntry(first.id, { title: '星降る夜（修正）' });
    rows[0].title = 'シート側で変更';
    rows.push({ title: '追加の作品', user_display_name: 'New', user_id: '@new', comment: '', id: 'c' });
    assert.deepEqual(await service.syncSheet(), { fetched: 3, created: 1, unchanged: 2, skipped: [] });
    assert.equal(service.entries.get(first.id)?.title, '星降る夜（修正）');
    assert.equal(service.entries.list().length, 3);
  } finally {
    service.close();
  }

  // トークン不一致
  writeConfig('wrong');
  service = open();
  try {
    await assert.rejects(service.syncSheet(), (error: unknown) => error instanceof HttpError && error.status === 502);
  } finally {
    service.close();
    sheet.close();
  }
});

test('シート同期: 未設定・https以外のURLは拒否する', async () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'label-sheet-')), 'data');
  mkdirSync(dataDir, { recursive: true });
  const open = (sheet: object) => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ sheet }));
    return new CaptionService(resolvePaths({ dataDir }), { fonts: fakeFonts([]) });
  };
  for (const sheet of [{}, { url: 'http://example.com/sheet.csv' }, { url: 'not a url' }]) {
    const service = open(sheet);
    try {
      await assert.rejects(service.syncSheet(), (error: unknown) => error instanceof HttpError && error.status === 400);
    } finally {
      service.close();
    }
  }
});
