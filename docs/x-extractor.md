# X仕様変更時の保守ガイド

XのHTML構造は公式APIではなく、予告なく変わります。これは本システムで最も起きやすい障害です。
この文書は、コードを初めて読む担当者が **`packages/x-extractor/index.ts` だけ** を直して復旧できることを目標にしています。

> 修正が終わるまでの間も、拡張機能の「手動入力」、管理画面の「手動登録」、CSV/JSONインポートで運用は続けられます。

## 症状

拡張機能のポップアップに次のいずれかが表示される、または取得内容が明らかにおかしい。

- 「投稿情報を取得できませんでした。Xのページ構造が変更された可能性があります。」
- 「投稿を特定できませんでした。」（投稿の詳細ページを開いているのに出る場合）
- ユーザ名やコメントが空、別人の名前が入る、など

## 修正する場所

`packages/x-extractor/index.ts` の先頭にある `X_SELECTORS` に、X依存のセレクタがすべて集まっています。

```ts
export const X_SELECTORS = {
  post: 'article[data-testid="tweet"]',     // 投稿1件
  userName: '[data-testid="User-Name"]',    // 表示名と @ユーザーID のブロック
  postText: '[data-testid="tweetText"]',    // 本文
  timestamp: 'time',                        // 投稿日時（親の <a> が固定リンク）
  permalink: 'a[href*="/status/"]',         // 投稿への固定リンク
  quotedPost: 'div[role="link"]',           // 引用投稿の枠
};
```

多くの場合、ここのセレクタを現在のXに合わせて書き換えるだけで直ります。

## 各情報の取得方法

| 情報 | メソッド | 取得方法 |
| --- | --- | --- |
| 投稿要素 | `findPostElement()` | ページ内の `post` のうち、固定リンクの投稿IDが**ページURLの投稿IDと一致するもの**。詳細ページ以外では取得しない |
| 投稿URL | `getPostUrl()` | 投稿内の `timestamp` を包む `<a>` の `href`。無ければ `permalink` に一致する最初のリンク。`https://x.com/<ユーザー>/status/<ID>` に正規化 |
| 投稿ID | `getPostId()` | 投稿URLの `/status/<数字>` |
| 表示名 | `getDisplayName()` | `userName` ブロック内の最初の `<a>` のテキスト。絵文字は `<img alt>` から拾う |
| ユーザーID | `getUserId()` | `userName` ブロック内で `@英数字` だけからなる `<span>`。無ければ投稿URLのユーザー名 |
| 本文 | `getPostText()` | `postText` のテキスト。絵文字は `<img alt>`、改行はテキストのまま |

引用投稿（`quotedPost` の内側）にある本文・ユーザー名・日時は、取得対象から除外しています。

## 調査の手順

1. Xで投稿の詳細ページを開き、開発者ツール（F12）の「要素」タブで投稿を選ぶ。
2. コンソールで各セレクタが何件ヒットするか確認する。

   ```js
   document.querySelectorAll('article[data-testid="tweet"]').length
   document.querySelector('article[data-testid="tweet"] [data-testid="User-Name"]')
   document.querySelector('article[data-testid="tweet"] [data-testid="tweetText"]')?.textContent
   document.querySelector('article[data-testid="tweet"] time')?.closest('a')?.href
   ```

3. ヒットしなくなったものについて、現在のHTMLで同じ要素を指す属性を探す。
   `data-testid` は比較的安定しています。クラス名（`css-xxxx`）は頻繁に変わるので使わないでください。
4. `X_SELECTORS` を書き換える。構造そのものが変わった場合は、対応するメソッドを修正する。

## テスト方法

実サイトへアクセスせずにテストできるよう、匿名化したHTMLを `tests/fixtures/x/` に置いています。

```text
tests/fixtures/x/
├── single-post.html       標準的な投稿
├── post-with-image.html   画像付き・表示名に絵文字
├── multiline-post.html    複数行・返信が並ぶページ
└── quoted-post.html       引用投稿を含む
```

1. 現在のXの投稿HTML（投稿の `article` 要素の outerHTML）をコピーする。
2. **表示名・ユーザーID・本文・投稿IDを架空のものへ置き換え、** 不要な属性（クラス名、画像URLなど）を削る。
   実在のユーザー情報をfixtureへ残してはいけません。
3. 既存のfixtureを新しい構造に合わせて更新する（または新しいfixtureを追加する）。
4. `npm test` を実行し、`tests/x-extractor.test.ts` が通ることを確認する。
5. `npm run build` で拡張機能をビルドし、ブラウザで再読み込みして実際のページで確認する。
6. `fix/x-dom-YYYY-MM` のようなブランチで修正し、PATCHバージョンを上げてReleaseを作る。

## 変更してはいけないこと

- 取得するのは **表示名・ユーザーID・本文・投稿URL・投稿ID** だけです。フォロワー数やプロフィールなど、他の情報を取得しないでください。
- Cookie・ログイン情報・認証トークンには一切触れないでください。
- X依存のコードを `packages/x-extractor` と `apps/extension` の外へ出さないでください。
- 投稿の自動巡回・自動収集は実装しないでください。
