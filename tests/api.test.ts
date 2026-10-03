import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, type App } from '../apps/server/src/app.ts';
import { resolvePaths } from '../apps/server/src/config.ts';
import { CaptionService } from '../apps/server/src/service.ts';
import { fakeFonts } from './helpers.ts';

let app: App;
let base: string;
let dataDir: string;
let outputDir: string;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    // JSON以外の応答
  }
  return { status: response.status, headers: response.headers, text, json };
}

const post = {
  platform: 'x',
  postId: '1000000000000000001',
  postUrl: 'https://x.com/example_user/status/1000000000000000001',
  userDisplayName: 'Example User',
  userId: '@example_user',
  text: 'タイトル：星降る夜\n\n夜の海を撮影しました。\n\n#ExamplePhotoContest',
};

before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'label-api-'));
  dataDir = join(tmp, 'data');
  outputDir = join(tmp, 'output');
  const service = new CaptionService(resolvePaths({ dataDir, outputDir }), {
    fonts: fakeFonts(['Noto Sans JP']),
  });
  app = createApp(service);
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
});

after(async () => {
  await app.close();
});

test('初回起動: サンプル設定から config.json を生成し、イベントを作成する', async () => {
  assert.ok(existsSync(join(dataDir, 'config.json')));
  const { json } = await call('GET', '/api/events');
  assert.equal(json.events.length, 1);
  assert.equal(json.events[0].name, 'Example Photo Contest');
  assert.equal(json.events[0].id, json.currentEventId);
  const templates = await call('GET', '/api/templates');
  assert.deepEqual(templates.json.templates.map((t: { id: string }) => t.id), ['example']);
});

test('登録フロー: 解析 → 確認 → 登録 → 重複防止 → 編集', async () => {
  const parsed = await call('POST', '/api/parse', { post });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.existing, null);
  assert.equal(parsed.json.draft.title, '星降る夜');
  assert.equal(parsed.json.draft.comment, '夜の海を撮影しました。');

  const created = await call('POST', '/api/entries', { ...parsed.json.draft, title: '星降る夜（確認済み）' });
  assert.equal(created.status, 201);
  assert.equal(created.json.displayNumber, 'PC2026-001');
  assert.equal(created.json.status, 'draft');
  assert.equal(created.json.source.originalText, post.text);
  const id = created.json.id as string;

  // 同じ投稿を再登録しようとすると、登録済み作品が返る（仕様 §16）
  const duplicate = await call('POST', '/api/entries', parsed.json.draft);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, 'duplicate-post');
  assert.equal(duplicate.json.existing.id, id);
  assert.equal((await call('POST', '/api/parse', { post })).json.existing.displayNumber, 'PC2026-001');
  assert.equal((await call('GET', `/api/entries/by-post/${post.postId}`)).json.id, id);
  assert.equal((await call('GET', '/api/entries/by-post/0')).status, 404);

  const updated = await call('PUT', `/api/entries/${id}`, { comment: '修正したコメント', status: 'confirmed' });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.comment, '修正したコメント');
  assert.equal(updated.json.status, 'confirmed');
  assert.equal(updated.json.source.originalText, post.text, '元投稿は保持される');
  assert.equal((await call('PUT', `/api/entries/${id}`, { status: 'bogus' })).status, 400);
  assert.equal((await call('GET', '/api/entries/unknown')).status, 404);
});

test('手動入力: Xを介さずに登録できる', async () => {
  const created = await call('POST', '/api/entries', {
    title: '朝の港',
    userDisplayName: 'Sample Hanako',
    userId: 'sample_hanako',
    comment: '手入力です。',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.displayNumber, 'PC2026-002');
  assert.equal(created.json.userId, '@sample_hanako');
  assert.equal(created.json.source.platform, 'manual');
  assert.equal((await call('POST', '/api/entries', {})).status, 400);

  const list = await call('GET', '/api/entries');
  assert.deepEqual(list.json.entries.map((e: { entryNumber: string }) => e.entryNumber), ['001', '002']);
  assert.equal((await call('GET', '/api/entries?status=confirmed')).json.entries.length, 1);
});

test('プレビューと各形式の出力（SVG / PDF / PNG / HTML）', async () => {
  const preview = await call('POST', '/api/preview', {
    title: '星降る夜',
    userDisplayName: 'Example User',
    userId: 'example_user',
    comment: 'あ'.repeat(400),
  });
  assert.equal(preview.status, 200);
  assert.match(preview.json.svg, /^<\?xml|^<svg/);
  assert.ok(preview.json.svg.includes('PC2026-003'), '未保存の作品は次の管理番号でプレビューする');
  assert.ok(preview.json.warnings.some((w: { code: string; field: string }) => w.code === 'overflow' && w.field === 'comment'));

  const { json } = await call('GET', '/api/entries');
  const id = json.entries[0].id as string;

  const svg = await call('GET', `/api/entries/${id}/caption.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.ok(svg.text.includes('星降る夜（確認済み）'));
  assert.ok(svg.text.includes('@example_user'));
  assert.deepEqual(JSON.parse(decodeURIComponent(svg.headers.get('x-caption-warnings') ?? '')), []);

  const html = await call('GET', `/api/entries/${id}/caption.html?download=1`);
  assert.match(html.headers.get('content-type') ?? '', /text\/html/);
  assert.match(html.headers.get('content-disposition') ?? '', /^attachment; .*PC2026-001_example_user_/);
  assert.ok(html.text.includes('<h1 class="caption-title">星降る夜（確認済み）</h1>'));
  assert.ok(html.text.includes('.caption-title {'));

  const pdf = await fetch(`${base}/api/entries/${id}/caption.pdf`);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const png = await fetch(`${base}/api/entries/${id}/caption.png`);
  assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), 'PNG');

  assert.equal((await call('GET', `/api/entries/${id}/caption.exe`)).status, 400);
  assert.equal((await call('GET', `/api/entries/${id}/caption.svg?template=missing`)).status, 404);
});

test('一括出力: 個別ファイルと合成ファイルを生成し、confirmed を exported にする', async () => {
  const result = await call('POST', '/api/export', { formats: ['svg', 'pdf', 'html'], combined: true });
  assert.equal(result.status, 200);
  const files = readdirSync(outputDir).sort();
  assert.deepEqual(files, [...result.json.files].sort());
  assert.ok(files.includes('PC2026-001_example_user_星降る夜（確認済み）.pdf'));
  assert.ok(files.includes('PC2026-002_sample_hanako_朝の港.html'));
  assert.ok(files.includes('captions-all.pdf'));
  assert.ok(files.includes('captions-all.html'));
  assert.equal(files.length, 2 * 3 + 2);

  const { json } = await call('GET', '/api/entries');
  assert.deepEqual(json.entries.map((e: { status: string }) => e.status), ['exported', 'draft']);
  assert.equal((await call('POST', '/api/export', { formats: ['exe'] })).status, 400);
});

test('JSON / CSV エクスポート・インポートとバックアップ', async () => {
  const exported = await call('GET', '/api/data/entries.json');
  assert.equal(exported.json.entries.length, 2);
  const csv = await call('GET', '/api/data/entries.csv');
  assert.match(csv.text, /^\uFEFF?entry_number,title,/);

  const imported = await call('POST', '/api/import', {
    format: 'csv',
    content:
      'title,user_display_name,user_id,comment,source_post_url\n' +
      `CSVの作品,CSV User,@csv_user,CSVから登録,\n` +
      `重複,Example User,@example_user,,${post.postUrl}\n`,
  });
  assert.equal(imported.json.created, 1);
  assert.equal(imported.json.skipped.length, 1);
  assert.match(imported.json.skipped[0].reason, /既に登録/);
  assert.equal((await call('POST', '/api/import', { format: 'json', content: '{' })).status, 400);

  const backup = await call('POST', '/api/backup', {});
  assert.equal(backup.status, 200);
  assert.ok(existsSync(join(backup.json.directory, 'database.sqlite')));
  assert.equal(JSON.parse(readFileSync(join(backup.json.directory, 'entries.json'), 'utf8')).entries.length, 3);
});

test('イベント: 新年度を作成すると採番が独立し、過年度データは残る', async () => {
  const created = await call('POST', '/api/events', { name: 'Example 2027', year: 2027, entryNumberPrefix: 'PC2027' });
  assert.equal(created.status, 201);
  const entry = await call('POST', '/api/entries', { title: '新年度', userId: 'a', eventId: created.json.id });
  assert.equal(entry.json.displayNumber, 'PC2027-001');
  assert.equal((await call('GET', `/api/entries?eventId=${created.json.id}`)).json.entries.length, 1);

  const events = await call('GET', '/api/events');
  const old = events.json.events.find((e: { name: string }) => e.name === 'Example Photo Contest');
  const archived = await call('PUT', `/api/events/${old.id}`, { status: 'archived' });
  assert.equal(archived.json.status, 'archived');
  assert.equal((await call('GET', `/api/entries?eventId=${old.id}`)).json.entries.length, 3);
  assert.equal((await call('GET', '/api/events')).json.currentEventId, created.json.id);
});

test('削除と操作ログ', async () => {
  const created = await call('POST', '/api/entries', { title: '削除対象', userId: 'a' });
  assert.equal((await call('DELETE', `/api/entries/${created.json.id}`)).status, 204);
  assert.equal((await call('GET', `/api/entries/${created.json.id}`)).status, 404);

  const log = readFileSync(join(dataDir, 'logs', 'operations.log'), 'utf8');
  for (const action of ['entry.create', 'entry.update', 'entry.delete', 'caption.generate']) {
    assert.ok(log.includes(`"action":"${action}"`), `${action} が記録されている`);
  }
  assert.ok(!log.includes('Example User'), 'ログに投稿者情報を残さない');
});

test('セキュリティ: 拡張機能以外のオリジンと不正なHostを拒否する', async () => {
  const evil = await call('POST', '/api/entries', { title: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const extension = await call('GET', '/api/health', undefined, { Origin: 'chrome-extension://abcdefghijklmnop' });
  assert.equal(extension.status, 200);
  assert.equal(extension.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');

  const sameOrigin = await call('GET', '/api/health', undefined, { Origin: base });
  assert.equal(sameOrigin.status, 200);

  assert.equal((await call('POST', '/api/entries', undefined)).status, 415);
});

test('管理UIの静的配信とパストラバーサル対策', async () => {
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.ok(index.text.includes('LABELSystem'));
  assert.equal((await call('GET', '/app.js')).status, 200);
  assert.equal((await call('GET', '/..%2f..%2fpackage.json')).status, 404);
});
