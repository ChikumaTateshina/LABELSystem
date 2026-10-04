# テンプレート書式

テンプレートは **デザイン・表示位置・タイポグラフィ** だけを担当します。
文章の加工（ハッシュタグ除去など）はレンダリング前に済んでおり、テンプレートにロジックは書きません。

## ファイル構成

```text
<テンプレートディレクトリ>/
├── template.svg    必須  マスターとなるデザイン
├── template.json   必須  設定（サイズ・フォント・各項目の表示領域）
├── template.html   任意  HTML出力用のマークアップ
└── template.css    任意  HTML出力用のスタイル
```

デザイナーから受け取るのは「`template.svg` + `template.json` + 使用フォント情報」の1セットです。
Illustrator / Figma 等で作成した場合もSVGへ書き出してから投入します。

## 置き場所と探索順

1. `data/config.json` の `templateDirs` に指定したディレクトリ
2. `data/templates/`（本番用。Git管理対象外）
3. `templates/`（同梱サンプル）

同じ `id` のテンプレートが複数ある場合は、上にあるものが使われます。
コンテストごとのデザインは `data/templates/` へ追加します。

使うテンプレートはウィンドウで選びます。最後に出力で使ったテンプレートが、次回の初期値になります。

## template.json

```json
{
  "id": "museum-white",
  "name": "Museum White",
  "version": "1.0",
  "width": "148mm",
  "height": "105mm",

  "fonts": ["Noto Sans JP", "Noto Sans CJK JP"],
  "fallbackFonts": ["Yu Gothic", "Hiragino Sans"],

  "fields": {
    "title":   { "required": true,  "maxLines": 2, "maxWidth": 1280, "fontSize": 72, "minFontSize": 56, "lineHeight": 1.3 },
    "username":{ "required": true,  "maxLines": 1, "maxWidth": 1280, "fontSize": 44, "minFontSize": 34 },
    "userid":  { "required": true,  "maxLines": 1, "maxWidth": 1280, "fontSize": 30, "minFontSize": 24 },
    "comment": { "required": false, "maxLines": 6, "maxWidth": 1280, "fontSize": 34, "minFontSize": 28, "lineHeight": 1.6 }
  }
}
```

| キー | 内容 |
| --- | --- |
| `id` | テンプレートの識別子（必須） |
| `width` / `height` | 用紙サイズ（必須）。`mm` `cm` `in` `pt` `px` が使えます。PDFのページサイズとPNGの画素数はここから決まります。`px` で指定した場合、PNGはその画素数ちょうどで出力されます（それ以外の単位では `pngDpi` で換算） |
| `fonts` | 使用フォント。先頭から順に探し、最初に見つかったものを使います（どれを使っても可という意味） |
| `fallbackFonts` | `fonts` がどれも無い場合の代替。使用時はプレビューに警告を表示します |

`fields.<変数名>` の設定（長さはSVGの `viewBox` 単位）:

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `required` | `false` | 空欄のとき警告する |
| `maxLines` | `1` | 最大行数 |
| `maxWidth` | viewBox幅とx座標から推定 | 折り返し幅 |
| `fontSize` | SVG側の `font-size`、無ければ 40 | 基準の文字サイズ |
| `minFontSize` | `fontSize` の80% | 自動縮小の下限。これより小さくはなりません |
| `lineHeight` | `1.5` | 行送り（文字サイズに対する倍率） |
| `fontFamily` | `fonts` | この項目だけ別フォントにする場合（PCに入っているフォントのファミリ名） |
| `valign` | `top` | 枠（基準の文字サイズで `maxLines` 行ぶん）の中での上下の揃え。`top` / `middle` / `bottom`。行数が `maxLines` より少ないときに、中央・下端へ寄せます |
| `fontWeight` | 指定なし | `"bold"` や `700` など |

## template.svg

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="148mm" height="105mm" viewBox="0 0 1480 1050">
  <rect width="1480" height="1050" fill="#fff"/>
  <text id="title"    x="100" y="230" fill="#1a1a1a">{{title}}</text>
  <text id="username" x="100" y="456">{{username}}</text>
  <text id="userid"   x="100" y="508" fill="#8a8a8a">{{userid}}</text>
  <text id="comment"  x="100" y="620">{{comment}}</text>
</svg>
```

使える変数（スプレッドシートの列に対応します）:

| 変数 | 列 |
| --- | --- |
| `{{no}}` | No.（`{{entry_number}}` も同じ値） |
| `{{theme}}` | テーマ |
| `{{category}}` | 部門 |
| `{{title}}` | タイトル |
| `{{username}}` | ユーザ名 |
| `{{userid}}` | ユーザID（`@example` の形に揃えます） |
| `{{comment}}` | コメント |
| `{{date}}` | 投稿日 |
| `{{award}}` | 賞など |
| `{{note}}` | 備考 |

ルール:

- **`<text ...>{{変数}}</text>` と、変数だけを中身にした `text` 要素**が自動改行の対象です。
  `x` `y` は1行目のベースライン位置、`text-anchor` で中央・右揃えにできます。
  出力時は行ごとの `<tspan>` に展開され、`font-size` と `font-family` が書き込まれます。
- それ以外の場所に書いた `{{変数}}` は単純に置換されます（改行・サイズ調整なし）。
- 属性は `fill="#333"` のように要素へ直接書いてください（`<style>` 内のCSSは解釈しません）。
- 固定の文字列（「撮影者」などのラベル）には `font-family` 属性を明記してください。

### 文字があふれる場合の動作

1. 通常の文字サイズで自動改行する
2. `maxLines` に収まらなければ、`minFontSize` まで 0.5 ずつ縮小する
3. それでも収まらなければ **警告を出して全行を描画**する（切り捨てや極端な縮小はしません）

警告が出た作品は、人が文章を修正してください。

### フォント

- フォントは「`data/fonts/` → `fontDirs` → OSにインストール済みのフォント」の順に探します。
- PDFにはフォントを埋め込みます。再配布できないフォントをリポジトリへ入れないでください。
- 可変フォント（Variable Font）は既定ウェイトでしか描画できないため、
  要求ウェイトと合わない場合は採用されません。ウェイト別の静的フォントを使ってください。
- フォントに無い文字（絵文字・機種依存文字・他言語の文字）は、`fallbackFonts` → 一般的な日本語フォント →
  絵文字・記号用フォント（Noto Emoji / Segoe UI Emoji など）の順に字形を探し、**輪郭として**描画します。
  その行は文字の位置を計算して配置するため、テンプレート側の対応は不要です（`text-anchor` も維持されます）。
- どのフォントにも無い文字は警告されます。

## HTML出力用テンプレート（任意）

`template.html` があると、HTML出力はSVGの埋め込みではなく、文字をHTMLのテキストとして出力します。

`template.html` — キャプション1枚分の中身だけを書きます。変数はSVGと同じです。

```html
<p class="caption-number">{{entry_number}}</p>
<h1 class="caption-title">{{title}}</h1>
<p class="caption-username">{{username}}</p>
<p class="caption-userid">{{userid}}</p>
<p class="caption-comment">{{comment}}</p>
```

`template.css` — 出力HTMLの `<style>` に埋め込まれます（外部ファイルへの依存はありません）。

```css
.caption { padding: 10mm; font-family: "Noto Sans JP", sans-serif; }
.caption-comment {
  white-space: pre-line;                       /* コメントの改行を反映 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--comment-max-lines); /* template.json の maxLines */
  overflow: hidden;
}
```

出力時に自動で用意されるもの:

- 各キャプションを包む `<article class="caption" data-entry-number="…">`（実寸の幅・高さ、`overflow: hidden`）
- CSS変数 `--caption-width` / `--caption-height` / `--<変数名>-max-lines`
- 印刷用の `@page`（1キャプション = 1ページ）

値はすべてHTMLエスケープされます。`template.html` が無いテンプレートでは、レンダリング済みSVGを埋め込んだHTMLを出力します。

> HTMLはブラウザが文字を組むため、SVG / PDF / PNG と改行位置が完全には一致しません。
> 厳密なレイアウトが必要な用途ではPDFまたはPNGを使ってください。

## 画面で作成・編集する

LABELSystem のウィンドウで「編集・コードを確認」または「複製して新規作成」を押すと、テンプレートをその場で編集できます。

「ブロック」タブでは、`template.svg` の直下にある `<text>` / `<line>` / `<rect>` / `<image>` をブロックとして扱い、
追加・削除・重なり順の変更・ドラッグでの配置・フォームでの設定ができます。
`<g>` の中の要素など、ブロックとして扱えない要素は変更されずに残ります。
用紙全体を覆う `<rect>` は「背景」として扱われ、「用紙の設定」の背景色で変更できます。
画像は `<image href="data:image/png;base64,…">` の形でSVGの中へ埋め込まれます。PDFへ出力できるのは PNG と JPEG です。
コードのタブ（4つのファイル）と同じ内容を編集しているので、ブロックで大まかに配置してからコードで仕上げることもできます。

ブロックを変更すると、同じ配置になるよう `template.html` / `template.css` も自動で作り直されます。
この連動は `template.json` の `"htmlFromBlocks"` で管理しており、`false` のときは作り直しません
（`template.html` / `template.css` をコードのタブで直接編集すると、自動で `false` になります）。
自動で作るHTMLは、SVGと同じ位置・大きさ（mm）で各ブロックを絶対配置し、文字は1行目の下端（ベースライン）で位置を合わせます。
入力のたびにプレビューが更新され、書式に誤りがある間は直前のプレビューを残したまま理由が表示されます。
`template.json` の `id` を変えて保存すると、別のテンプレートとして `data/templates/<id>/` に保存されます。
デザイナーから受け取ったファイルは「インポート」で取り込めます。

## 新しいテンプレートを追加する手順（ファイルで行う場合）

1. `templates/example/` を `data/templates/<名前>/` へコピーする。
2. `template.json` の `id` と `name` を変更する。
3. `template.svg`（必要なら `template.html` / `template.css`）を編集する。
4. LABELSystem の「再読み込み」を押すと、テンプレートの選択肢に現れます。
5. 長いタイトル・長いコメント・絵文字入りの名前でプレビューし、警告が正しく出ることを確認する。
