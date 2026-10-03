import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { ExtractionError, XPostExtractor } from '../packages/x-extractor/index.ts';

/** 匿名化したHTML fixtureを読み込む。Xの実サイトへはアクセスしない（仕様 §84）。 */
function extractor(fixture: string, pageUrl: string): XPostExtractor {
  const html = readFileSync(fileURLToPath(new URL(`./fixtures/x/${fixture}`, import.meta.url)), 'utf8');
  const { document } = parseHTML(html);
  return new XPostExtractor(document as unknown as Document, pageUrl);
}

test('single-post: 表示名・ユーザーID・本文・URL・投稿IDを取得できる', async () => {
  const post = await extractor('single-post.html', 'https://x.com/example_user/status/1000000000000000001').extract();
  assert.equal(post.platform, 'x');
  assert.equal(post.postId, '1000000000000000001');
  assert.equal(post.postUrl, 'https://x.com/example_user/status/1000000000000000001');
  assert.equal(post.userDisplayName, 'Example User');
  assert.equal(post.userId, '@example_user');
  assert.equal(
    post.text,
    'タイトル：星降る夜\n\n夜の海を撮影しました。\n静かな感じがお気に入りです。\n\n#ExamplePhotoContest',
  );
  assert.ok(!Number.isNaN(Date.parse(post.capturedAt ?? '')));
});

test('post-with-image: 絵文字（img alt）を文字として取得し、画像リンクをURLと誤認しない', async () => {
  const post = await extractor(
    'post-with-image.html',
    'https://x.com/sample_photo/status/1000000000000000002/photo/1',
  ).extract();
  assert.equal(post.userDisplayName, 'サンプル写真部📷');
  assert.equal(post.userId, '@sample_photo');
  assert.equal(post.text, '朝の港🌅 を撮りました');
  assert.equal(post.postUrl, 'https://x.com/sample_photo/status/1000000000000000002');
});

test('multiline-post: 改行を保持し、返信ではなくURLの投稿を取得する', async () => {
  const post = await extractor('multiline-post.html', 'https://x.com/example_user/status/1000000000000000003').extract();
  assert.equal(post.postId, '1000000000000000003');
  assert.equal(post.userId, '@example_user');
  assert.equal(post.text, '1行目\n2行目\n\n4行目 https://example.com/…');
});

test('quoted-post: 引用された投稿の本文・投稿者を取得しない', async () => {
  const post = await extractor('quoted-post.html', 'https://x.com/example_user/status/1000000000000000004').extract();
  assert.equal(post.userDisplayName, 'Example User');
  assert.equal(post.userId, '@example_user');
  assert.equal(post.text, '');
  assert.equal(post.postId, '1000000000000000004');
});

test('投稿を特定できない場合は ExtractionError になる', async () => {
  // タイムライン等、投稿詳細ページ以外では誤取得を避けるため取得しない
  await assert.rejects(extractor('single-post.html', 'https://x.com/home').extract(), ExtractionError);
  // URLの投稿がページ内に見つからない
  await assert.rejects(
    extractor('single-post.html', 'https://x.com/example_user/status/999').extract(),
    ExtractionError,
  );
});
