import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ValidationError,
  buildFileName,
  createDraft,
  entriesToCsv,
  entriesToJson,
  formatEntryNumber,
  normalizeUserId,
  padEntryNumber,
  parseCsv,
  parseEntriesCsv,
  parseEntriesJson,
  parsePostText,
  sanitizeFileNamePart,
  toCaptionModel,
  toCsv,
} from '../packages/core/index.ts';
import type { CaptionEntry } from '../packages/shared-types/index.ts';

const sampleEntry: CaptionEntry = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  eventId: 'event-1',
  entryNumber: '042',
  title: '星降る夜',
  userDisplayName: 'Example User',
  userId: '@example',
  comment: '1行目\n"引用", カンマ',
  status: 'confirmed',
  templateId: null,
  source: {
    platform: 'x',
    postId: '1000000000000000001',
    postUrl: 'https://x.com/example/status/1000000000000000001',
    originalText: 'タイトル：星降る夜\n1行目',
  },
  createdAt: '2026-09-28T03:00:00.000Z',
  updatedAt: '2026-09-28T03:00:00.000Z',
};

test('タイトル・コメント解析: 明示的なタイトル行を抽出し、ハッシュタグを除去する', () => {
  const parsed = parsePostText(
    'タイトル：星降る夜\n\n夜の海を撮影しました。\n静かな感じがお気に入りです。\n\n#ExamplePhotoContest',
  );
  assert.equal(parsed.title, '星降る夜');
  assert.equal(parsed.comment, '夜の海を撮影しました。\n静かな感じがお気に入りです。');
});

test('タイトル・コメント解析: 各種のタイトル表記に対応する', () => {
  assert.equal(parsePostText('Title: Morning Harbor\nhello').title, 'Morning Harbor');
  assert.equal(parsePostText('【タイトル】朝の港\nhello').title, '朝の港');
  assert.equal(parsePostText('作品名:「朝の港」').title, '朝の港');
});

test('タイトル・コメント解析: 明示がなければタイトルを推測しない', () => {
  const parsed = parsePostText('星降る夜\n夜の海を撮影しました。');
  assert.equal(parsed.title, '');
  assert.equal(parsed.comment, '星降る夜\n夜の海を撮影しました。');
});

test('タイトル・コメント解析: URL除去とハッシュタグ除去モード', () => {
  const text = '海です https://t.co/abc123 #PhotoCon #海';
  assert.equal(parsePostText(text).comment, '海です');
  assert.equal(
    parsePostText(text, { removeHashtags: 'contest', contestHashtags: ['photocon'] }).comment,
    '海です #海',
  );
  assert.equal(
    parsePostText(text, { removeHashtags: 'none', removeUrls: false }).comment,
    '海です https://t.co/abc123 #PhotoCon #海',
  );
});

test('ドラフト生成: 元投稿本文を改変せず保持する', () => {
  const text = 'タイトル：星降る夜\n本文 #Tag';
  const draft = createDraft({
    platform: 'x',
    postId: '1',
    postUrl: 'https://x.com/example/status/1',
    userDisplayName: ' Example User ',
    userId: 'example',
    text,
  });
  assert.equal(draft.originalPostText, text);
  assert.equal(draft.title, '星降る夜');
  assert.equal(draft.comment, '本文');
  assert.equal(draft.userId, '@example');
  assert.equal(draft.userDisplayName, 'Example User');
});

test('ユーザID正規化', () => {
  assert.equal(normalizeUserId('example'), '@example');
  assert.equal(normalizeUserId(' @example '), '@example');
  assert.equal(normalizeUserId('＠example'), '@example');
  assert.equal(normalizeUserId(''), '');
});

test('CaptionModel変換', () => {
  const model = toCaptionModel(
    { title: ' 星降る\n夜 ', userDisplayName: 'Example User', userId: 'example', comment: 'a\r\nb\n' },
    'PC2026-042',
  );
  assert.deepEqual(model, {
    title: '星降る 夜',
    username: 'Example User',
    userid: '@example',
    comment: 'a\nb',
    entry_number: 'PC2026-042',
  });
});

test('管理番号の表示形式', () => {
  assert.equal(padEntryNumber(42), '042');
  assert.equal(padEntryNumber(7, 4), '0007');
  assert.equal(formatEntryNumber('042', { prefix: 'PC2026' }), 'PC2026-042');
  assert.equal(formatEntryNumber('042', { format: 'No.{number}' }), 'No.042');
  assert.equal(formatEntryNumber('042'), '042');
});

test('ファイル名生成: 規則どおりに組み立て、危険な文字を除去する', () => {
  assert.equal(
    buildFileName({ entry_number: 'PC2026-042', userid: '@example', title: '星降る夜' }, 'pdf'),
    'PC2026-042_example_星降る夜.pdf',
  );
  assert.equal(
    buildFileName({ entry_number: '001', userid: '@a', title: 'a/b\\c:d*e?f"g<h>i|j' }, 'svg'),
    '001_a_abcdefghij.svg',
  );
  assert.equal(buildFileName({ entry_number: '001', userid: '', title: '' }, '.png'), '001_untitled.png');
  assert.equal(sanitizeFileNamePart('../..'), '');
  assert.equal(sanitizeFileNamePart('CON'), '_CON');
  assert.equal(sanitizeFileNamePart('a  b\tc'), 'a_b_c');
  assert.equal(Array.from(sanitizeFileNamePart('あ'.repeat(200))).length, 60);
});

test('CSV: 引用符・改行・カンマを往復できる', () => {
  const rows = [
    ['a', 'b'],
    ['1行目\n2行目', '"quoted", comma'],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n1,2\r\n\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('JSON Export/Import: 往復で表示情報と元投稿情報を保持する', () => {
  const [input] = parseEntriesJson(entriesToJson([sampleEntry]));
  assert.equal(input.title, sampleEntry.title);
  assert.equal(input.comment, sampleEntry.comment);
  assert.equal(input.entryNumber, '042');
  assert.equal(input.status, 'confirmed');
  assert.equal(input.sourcePostId, '1000000000000000001');
  assert.equal(input.sourcePostUrl, sampleEntry.source?.postUrl);
  assert.equal(input.originalPostText, sampleEntry.source?.originalText);
});

test('CSV Export/Import: 往復できる', () => {
  const csv = entriesToCsv([sampleEntry]);
  assert.ok(csv.startsWith('\uFEFFentry_number,title,user_display_name,user_id,comment,source_post_url'));
  const [input] = parseEntriesCsv(csv);
  assert.equal(input.entryNumber, '042');
  assert.equal(input.comment, sampleEntry.comment);
  assert.equal(input.sourcePostId, '1000000000000000001');
});

test('CSV Import: 仕様書の例と日本語の列名を読み込める', () => {
  const spec =
    'entry_number,title,user_display_name,user_id,comment,source_post_url\n' +
    '001,星降る夜,Example User,@example,静かな夜の海を撮影しました。,https://x.com/example/status/123\n';
  const [a] = parseEntriesCsv(spec);
  assert.equal(a.entryNumber, '001');
  assert.equal(a.sourcePostId, '123');

  const [b] = parseEntriesCsv('タイトル,ユーザー名,ユーザーID,コメント\n朝の港,Sample,sample,手入力です\n');
  assert.deepEqual(
    { title: b.title, name: b.userDisplayName, id: b.userId, comment: b.comment, post: b.sourcePostId },
    { title: '朝の港', name: 'Sample', id: '@sample', comment: '手入力です', post: undefined },
  );
});

test('Import: 不正な入力はValidationErrorになる', () => {
  assert.throws(() => parseEntriesJson('{'), ValidationError);
  assert.throws(() => parseEntriesJson('{"foo": 1}'), ValidationError);
  assert.throws(() => parseEntriesCsv('foo,bar\n1,2\n'), ValidationError);
  assert.throws(() => parseEntriesJson('[{"title":"a","sourcePostUrl":"javascript:alert(1)"}]'), ValidationError);
});
