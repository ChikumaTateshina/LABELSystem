# LABELSystem - Layout and Artwork Bibliographic Entry Layer
## フォトコンテスト用情報取得キャプション生成システム群
## 要件・仕様書

Version: 1.0  
Status: Initial Specification

---

# 1. 目的

本システムは、X（旧Twitter）上で開催されるフォトコンテストの投稿から必要な情報を取得し、美術館・写真展における作品キャプションを想定したレイアウトへ自動的に流し込んで出力することを目的とする。

本システムでは、応募作品の高度な分類、画像認識、自動タグ付け、作品評価、審査支援等は行わない。

システムが扱う主要情報は以下の4項目とする。

- 作品タイトル
- ユーザ名
- コメント
- ユーザID

X上から自動取得可能な情報はブラウザ拡張によって取得し、作品タイトル等のX投稿から一意に取得できない情報については必要に応じて人間が入力・修正する。

最終的には、登録された作品情報とデザインテンプレートを組み合わせ、展示・印刷に利用可能なキャプションデータを生成する。

---

# 2. システム設計方針

システムを以下の3コンポーネントに明確に分離する。

```text
[X Webページ]
      │
      │ 閲覧中の投稿から取得
      ▼
[ブラウザ拡張]
      │
      │ Entry Data
      ▼
[キャプションDB]
      │
      ├─────────────┐
      │             │
      ▼             ▼
[管理・編集UI]   [テンプレート]
      │             │
      └──────┬──────┘
             ▼
      [レンダリングエンジン]
             │
             ▼
        SVG / PDF / PNG
```

各コンポーネントを疎結合とし、XのHTML構造変更、テンプレートデザイン変更、出力形式変更の影響が他の部分へ波及しにくい構造とする。

---

# 3. 対象環境

## 3.1 ブラウザ

優先対応：

- Google Chrome
- Chromium系ブラウザ
  - Microsoft Edge
  - Brave等

可能であれば：

- Mozilla Firefox

Chrome系ではManifest V3を使用する。

FirefoxについてもWebExtensions APIを使用し、可能な限り同一ソースコードからビルド可能な構成とする。

ブラウザ拡張はXのDOMから情報を取得するため、X APIは使用しない。

---

# 4. 非対象機能

初期実装では以下を実装しない。

- X APIによる投稿検索
- ハッシュタグ自動巡回
- 応募作品自動収集
- 画像認識
- 画像内容からの説明文生成
- 自動タグ付け
- AIによる作品評価
- 入賞作品判定
- NSFW判定
- フォロワー数等の取得
- いいね数等の統計情報取得
- 投稿者プロフィール分析
- 自動返信
- Xへの自動投稿
- キャプション文章の創作的なAI生成

コメントは原則として投稿者自身の投稿内容または運営者が入力した文章を利用する。

---

# 5. 基本ワークフロー

想定する標準操作は以下とする。

```text
1. 運営者がXで応募投稿を開く

2. ブラウザ拡張の
   「キャプションへ登録」
   を実行

3. 拡張機能が投稿から
   ・ユーザ名
   ・ユーザID
   ・投稿本文
   ・投稿URL
   ・投稿ID
   を取得

4. 登録確認画面を表示

5. 運営者が
   ・タイトル
   ・コメント
   を確認または修正

6. DBへ登録

7. 管理画面から作品を選択

8. デザインテンプレートへ差し込み

9. キャプションをプレビュー

10. PDF / SVG / PNG等として出力
```

---

# 6. ブラウザ拡張仕様

## 6.1 役割

ブラウザ拡張はX上で表示されている投稿から、キャプション生成に必要な情報を取得する。

ブラウザ拡張自身にはキャプション生成ロジックを極力持たせない。

役割は、

```text
X投稿
 ↓
構造化データ
```

への変換に限定する。

---

# 7. Xから取得する情報

最低限以下を取得する。

```json
{
  "source": "x",
  "postId": "1234567890123456789",
  "postUrl": "https://x.com/example/status/1234567890123456789",
  "userDisplayName": "Example User",
  "userId": "@example",
  "postText": "作品タイトル：星降る夜\n夜の海を撮影しました。",
  "capturedAt": "2026-09-28T12:00:00+09:00"
}
```

このうちキャプション表示に直接必要なのは、

```text
userDisplayName
userId
postText
```

とする。

`postId`と`postUrl`は管理情報として保持する。

---

# 8. 投稿情報の抽出方式

XのHTML構造は恒久的なAPIではないため、DOMセレクタをシステム全体へ直接記述しない。

以下のような専用抽出層を設ける。

```text
X DOM
 │
 ▼
XPostExtractor
 │
 ├─ getPostId()
 ├─ getPostUrl()
 ├─ getDisplayName()
 ├─ getUserId()
 └─ getPostText()
```

X側のDOM変更が発生した場合、原則として`XPostExtractor`のみを修正する。

---

# 9. 投稿の特定

タイムライン上には複数投稿が存在するため、誤取得防止を重視する。

推奨する動作は、

```text
投稿単位に
「キャプションへ登録」
ボタンを挿入
```

する方式とする。

例：

```text
┌─────────────────────────┐
│ Example User @example    │
│                         │
│ 星降る夜                 │
│ 夜の海を撮影しました。   │
│                         │
│ ♡  ↻  …                 │
│                         │
│ [キャプションへ登録]    │
└─────────────────────────┘
```

または投稿詳細ページを開いている状態で、拡張機能ボタンから登録する方式を採用してもよい。

初期実装では、後者でも差し支えない。

---

# 10. 登録確認画面

Xから情報取得後、即座にDB登録せず、確認画面を表示する。

例：

```text
作品登録

タイトル
[ 星降る夜                     ]

ユーザ名
[ Example User                 ]

ユーザID
[ @example                     ]

コメント
[ 夜の海を撮影しました。       ]
[                              ]

元投稿
https://x.com/example/status/...

[キャンセル]        [登録]
```

すべてのフィールドを編集可能とする。

---

# 11. タイトルの扱い

Xには作品タイトル専用フィールドが存在しないため、自動取得を必須としない。

タイトル決定方式は以下の優先順位とする。

```text
1. 投稿本文から明示的なタイトル記述を抽出
2. 抽出できなければ空欄
3. 運営者が入力
```

例えば、

```text
タイトル：星降る夜

夜の海を撮影しました。
#PhotoContest
```

の場合、

```text
title = 星降る夜
comment = 夜の海を撮影しました。
```

と解析してもよい。

ただし、この機能は補助機能とする。

曖昧な場合にAI等でタイトルを推測してはならない。

---

# 12. コメントの扱い

基本的には投稿本文をコメント候補として利用する。

以下は除去可能とする。

```text
コンテスト指定ハッシュタグ
作品タイトル行
不要なURL
```

例：

入力：

```text
タイトル：星降る夜

夜の海を撮影しました。
静かな感じがお気に入りです。

#ExamplePhotoContest
```

内部データ：

```text
title:
星降る夜

comment:
夜の海を撮影しました。
静かな感じがお気に入りです。
```

ただし、元投稿の本文をDBにも保持する。

---

# 13. データベース仕様

## 13.1 基本方針

DBはキャプション生成に必要な情報と、元投稿との対応情報のみを保持する。

過剰なXプロフィール情報は保存しない。

---

# 14. Entryデータモデル

基本テーブルを`entries`とする。

```text
entries
───────────────────────────────
id
entry_number

title

user_display_name
user_id

comment

original_post_text

source_post_id
source_post_url

created_at
updated_at

status
template_id
```

---

# 15. Entry詳細仕様

### id

内部一意ID。

UUIDを推奨する。

例：

```text
550e8400-e29b-41d4-a716-446655440000
```

### entry_number

フォトコン側の管理番号。

例：

```text
001
002
003
```

表示形式は設定可能とする。

例：

```text
No.001
PC2026-001
001
```

### title

作品タイトル。

UTF-8。

### user_display_name

X上の表示名。

例：

```text
蓼科千曲
```

### user_id

XのユーザーID。

例：

```text
@tateshina
```

### comment

展示キャプションに表示するコメント。

### original_post_text

元投稿本文。

改変前の文章を保持する。

### source_post_id

X投稿ID。

重複登録防止にも利用する。

### source_post_url

元投稿URL。

### status

以下を基本とする。

```text
draft
confirmed
exported
```

---

# 16. 重複登録防止

`source_post_id`にUnique制約を設定する。

同一投稿を再登録しようとした場合、

```text
この投稿は既に登録されています。

Entry:
PC2026-042

[登録済み作品を開く]
```

と表示する。

---

# 17. DB方式

小～中規模のフォトコンを想定する場合、SQLiteを第一候補とする。

理由：

```text
・サーバ不要
・単一ファイル
・バックアップ容易
・数百～数千作品では十分
・SQLによる管理が容易
```

複数端末・複数スタッフから同時利用する場合は、

```text
PostgreSQL
```

等へ交換可能なRepository構造とする。

アプリケーションからDBへ直接依存しない。

```text
EntryRepository
 ├─ create()
 ├─ update()
 ├─ delete()
 ├─ get()
 ├─ list()
 └─ findByPostId()
```

---

# 18. ブラウザ拡張とDB間の通信

推奨構成：

```text
Browser Extension
       │
       │ HTTP
       ▼
Local Caption Server
       │
       ▼
     SQLite
```

例：

```text
http://127.0.0.1:38471
```

ブラウザ拡張がSQLiteを直接操作しない。

---

# 19. ローカルAPI

最低限以下を実装する。

```text
POST /api/entries
GET  /api/entries
GET  /api/entries/{id}
PUT  /api/entries/{id}
DELETE /api/entries/{id}

GET /api/entries/by-post/{postId}
```

---

# 20. POST /api/entries

例：

```json
{
  "title": "星降る夜",
  "userDisplayName": "蓼科千曲",
  "userId": "@tateshina",
  "comment": "静かな夜の海を撮影しました。",
  "originalPostText": "タイトル：星降る夜\n静かな夜の海を撮影しました。",
  "sourcePostId": "123456789",
  "sourcePostUrl": "https://x.com/example/status/123456789"
}
```

---

# 21. 管理UI

管理画面では登録済み作品を一覧表示する。

```text
┌─────┬────────────┬──────────┬──────────┐
│ No. │ Title      │ User     │ Status   │
├─────┼────────────┼──────────┼──────────┤
│ 001 │ 星降る夜   │ @example │ Confirmed│
│ 002 │ 朝の港     │ @sample  │ Draft    │
└─────┴────────────┴──────────┴──────────┘
```

作品を選択すると編集画面へ移動する。

---

# 22. キャプションデータモデル

レンダリング時にはDBレコードを直接テンプレートへ渡さず、以下の中間モデルへ変換する。

```json
{
  "title": "星降る夜",
  "username": "蓼科千曲",
  "userid": "@tateshina",
  "comment": "静かな夜の海を撮影しました。"
}
```

これをCaptionModelとする。

---

# 23. テンプレート仕様

初期実装の標準テンプレート形式はSVGとする。

理由：

```text
・ベクター形式
・印刷向け
・文字の差し替えが容易
・ブラウザでプレビュー可能
・PDF変換が容易
・レイアウトを厳密に維持できる
```

---

# 24. テンプレート変数

最低限以下を定義する。

```text
{{title}}
{{username}}
{{userid}}
{{comment}}
```

必要に応じて、

```text
{{entry_number}}
```

を追加できる。

---

# 25. SVGテンプレート例

```xml
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="148mm"
  height="105mm"
  viewBox="0 0 1480 1050">

  <text
    id="title"
    x="100"
    y="180">
    {{title}}
  </text>

  <text
    id="username"
    x="100"
    y="300">
    {{username}}
  </text>

  <text
    id="userid"
    x="100"
    y="350">
    {{userid}}
  </text>

  <text
    id="comment"
    x="100"
    y="500">
    {{comment}}
  </text>

</svg>
```

---

# 26. テンプレート設計原則

テンプレートには文章生成ロジックを含めない。

テンプレートは、

```text
デザイン
+
表示位置
+
タイポグラフィ
```

のみを担当する。

データ加工はレンダリング前に完了させる。

---

# 27. テキスト領域

各フィールドに最大表示領域を設定する。

例：

```text
Title
  最大2行

Username
  最大1行

User ID
  最大1行

Comment
  最大6行
```

文字数ではなく、実際のレンダリング幅で折り返し判定する。

---

# 28. 自動改行

コメントはSVG標準の単純な`text`要素任せにせず、レンダリング側で行分割する。

例：

```xml
<text>
  <tspan x="100" dy="0">
    静かな夜の海を撮影しました。
  </tspan>

  <tspan x="100" dy="45">
    波の少ない瞬間がお気に入りです。
  </tspan>
</text>
```

---

# 29. 文字オーバーフロー

表示領域を超えた場合、自動的に極端な縮小を行わない。

処理優先順位：

```text
1. 通常表示
2. 自動改行
3. 許容範囲内で文字サイズ縮小
4. オーバーフロー警告
5. 人間による修正
```

最終的に読めないサイズへ縮小してはならない。

---

# 30. フォント

テンプレートは使用フォントを明示する。

例：

```text
Noto Sans JP
Noto Serif JP
Source Han Sans
```

ローカルに存在しないフォントを使用する場合はエラーまたは警告を表示する。

印刷用PDF生成時には可能な限りフォントを埋め込む。

---

# 31. テンプレート管理

テンプレートを複数保持可能とする。

例：

```text
templates/
 ├─ default/
 │   ├─ template.svg
 │   └─ template.json
 │
 ├─ museum-white/
 │   ├─ template.svg
 │   └─ template.json
 │
 └─ museum-dark/
     ├─ template.svg
     └─ template.json
```

---

# 32. template.json

SVGと別にテンプレート設定を保持する。

例：

```json
{
  "id": "museum-white",
  "name": "Museum White",
  "version": "1.0",
  "width": "148mm",
  "height": "105mm",

  "fields": {
    "title": {
      "required": true,
      "maxLines": 2
    },

    "username": {
      "required": true,
      "maxLines": 1
    },

    "userid": {
      "required": true,
      "maxLines": 1
    },

    "comment": {
      "required": false,
      "maxLines": 6
    }
  }
}
```

---

# 33. テンプレート入力仕様

デザイナーからテンプレートを受け取る場合、

```text
template.svg
template.json
使用フォント情報
```

を1セットとする。

元デザインがIllustrator、Figma等の場合でも、システム投入時にはSVGへ変換する。

---

# 34. レンダリングエンジン

Rendererは、

```text
CaptionModel
+
Template
```

を入力し、

```text
RenderedCaption
```

を生成する。

```text
CaptionRenderer.render(
    CaptionModel,
    Template
)
```

---

# 35. プレビュー

出力前に必ずプレビューを表示する。

例：

```text
┌─────────────────────────────────┐

       星降る夜

       蓼科千曲
       @tateshina


       静かな夜の海を撮影しました。
       波の少ない瞬間がお気に入りです。


└─────────────────────────────────┘

[戻る]

[SVG出力]
[PNG出力]
[PDF出力]
```

---

# 36. 出力形式

最低限以下に対応する。

### SVG

マスター出力。

### PDF

印刷用途。

### PNG

Web確認・共有用途。

PDFとPNGはSVGを基準として生成する。

```text
SVG
 ├─ PDF
 └─ PNG
```

とすることで、レイアウト差異を減らす。

---

# 37. PDF仕様

印刷用途を想定し、

```text
実寸サイズ維持
フォント埋め込み
余白維持
```

を必須とする。

可能であれば、

```text
PDF/X
```

等への変換は外部ツールによる後処理として扱う。

---

# 38. 一括出力

複数作品の一括生成に対応する。

例：

```text
[全作品PDF生成]
```

出力：

```text
output/
 ├─ PC2026-001.pdf
 ├─ PC2026-002.pdf
 ├─ PC2026-003.pdf
 └─ ...
```

---

# 39. 合成PDF

必要に応じて、

```text
captions-all.pdf
```

として複数キャプションを1PDFへまとめられる設計とする。

ただし個別PDFを正とする。

---

# 40. ファイル名規則

標準：

```text
{entry_number}_{user_id}_{title}.pdf
```

ただしファイルシステム上危険な文字を除去する。

例：

```text
PC2026-042_example_星降る夜.pdf
```

---

# 41. データ修正

元投稿の情報を取得した後もすべての表示情報を修正可能とする。

ただし、

```text
original_post_text
source_post_id
source_post_url
```

は元情報として別途保持する。

つまり、

```text
元データ
≠
展示データ
```

とする。

---

# 42. ログ

最低限以下の操作を記録可能とする。

```text
Entry作成
Entry更新
Entry削除
Caption生成
```

高度な監査ログ機能は要求しない。

---

# 43. バックアップ

SQLiteの場合、

```text
database.sqlite
templates/
```

の2つをバックアップすれば復元可能な構造とする。

さらに、

```text
entries.json
```

としてDB内容をエクスポート可能にする。

---

# 44. インポート・エクスポート

最低限JSONおよびCSVに対応する。

CSV例：

```csv
entry_number,title,user_display_name,user_id,comment,source_post_url
001,星降る夜,蓼科千曲,@tateshina,静かな夜の海を撮影しました。,https://x.com/...
```

これにより、最悪ブラウザ拡張が利用不能になった場合でも手入力による運用を継続できる。

---

# 45. Xの仕様変更への対策

X DOMへの依存は本システム最大の不安定要素である。

そのため、

```text
Xページ解析
```

と、

```text
キャプション管理
```

を完全に分離する。

X側が変更された場合でも、

```text
XPostExtractor
```

のみを修正すれば、DB・テンプレート・レンダリング系は変更不要とする。

---

# 46. ブラウザ拡張の権限

必要最小限とする。

想定：

```json
{
  "permissions": [
    "activeTab",
    "storage"
  ],

  "host_permissions": [
    "https://x.com/*"
  ]
}
```

Chrome MV3では`activeTab`や`host_permissions`を用いて対象ページへのスクリプト実行権限を与えられる。

拡張機能設定には`chrome.storage` / WebExtensions storage APIを利用できる。Chrome公式では拡張機能固有の非同期ストレージとして提供されている。

ただし応募作品そのものはブラウザストレージを正本とせず、DBを正本とする。

---

# 47. セキュリティ

ブラウザ拡張からローカルサーバへ送信できるデータは、

```text
X投稿から取得した情報
+
運営者が入力した情報
```

のみに制限する。

Cookie、ログインセッション、認証トークン等を取得・保存・送信してはならない。

---

# 48. プライバシー

フォトコン参加者について保存する情報を必要最小限に限定する。

初期実装では、

```text
表示名
XユーザーID
投稿本文
投稿URL
投稿ID
```

以外のプロフィール情報を取得しない。

---

# 49. エラー処理

Xから必要情報を取得できない場合、

```text
投稿情報を取得できませんでした。

Xのページ構造が変更された可能性があります。

[手動入力]
```

を表示する。

取得失敗時にもシステムそのものを利用不能にしてはならない。

---

# 50. 手動入力モード

Xを介さず直接作品を登録できる画面を必須とする。

```text
タイトル
[               ]

ユーザ名
[               ]

ユーザID
[               ]

コメント
[               ]

元投稿URL
[               ]

[登録]
```

これによりブラウザ拡張障害時にも運営を継続できる。

---

# 51. システム構成例

```text
project/
│
├─ extension/
│   ├─ manifest.json
│   ├─ content/
│   │   └─ xPostExtractor.ts
│   ├─ popup/
│   └─ background/
│
├─ server/
│   ├─ api/
│   ├─ database/
│   ├─ models/
│   └─ repositories/
│
├─ web/
│   ├─ entries/
│   ├─ templates/
│   └─ preview/
│
├─ renderer/
│   ├─ svg/
│   ├─ pdf/
│   └─ png/
│
├─ templates/
│
└─ output/
```

---

# 52. 推奨技術構成

実装言語を強制しないが、一例として以下を想定する。

```text
Browser Extension
TypeScript

管理画面
TypeScript
React / Vue / Vanilla

Local API
Node.js
または
Python

DB
SQLite

Template
SVG

PDF生成
SVG → PDF

PNG生成
SVG → Raster
```

システム規模を考慮すると、過度なフレームワーク導入は避ける。

---

# 53. 重要な設計境界

本システムでは次の4つを独立させる。

```text
① Xから情報を取得する

② 情報を保存・編集する

③ デザインへ配置する

④ ファイルとして出力する
```

これらを一つの巨大な処理として実装してはならない。

---

# 54. MVP

最初の実装段階では以下だけで成立する。

```text
X投稿
 ↓
ブラウザ拡張
 ↓
ユーザ名
ユーザID
本文
 ↓
登録画面
 ↓
タイトル入力
コメント確認
 ↓
SQLite
 ↓
SVGテンプレート
 ↓
プレビュー
 ↓
PDF
```

これをMVPとする。

---

# 55. Phase 2

MVP安定後に必要であれば追加する。

```text
一括PDF生成
CSV入出力
複数テンプレート
Firefox対応
タイトル簡易解析
ハッシュタグ除去
コメント整形
バックアップ
```

---

# 56. Phase 3

将来的に必要になった場合のみ検討する。

```text
複数端末対応
複数スタッフ同時利用
中央DB
Web管理画面
オンラインバックアップ
```

X APIによる自動収集はこの段階でも必須ではない。

---

# 57. 受け入れ条件

最低限、以下の操作が成立すれば初期版完成とする。

```text
1.
Xの任意の投稿から
表示名・ユーザーID・本文・URLを取得できる。

2.
取得内容を登録前に編集できる。

3.
タイトルを入力できる。

4.
DBへ作品として保存できる。

5.
保存済み作品を後から編集できる。

6.
指定SVGテンプレートへ
タイトル
ユーザ名
コメント
ユーザID
を差し込める。

7.
プレビューできる。

8.
SVGとして出力できる。

9.
PDFとして出力できる。

10.
コメントが長い場合に
レイアウト破綻を検出できる。

11.
同じX投稿を誤って二重登録しない。

12.
X取得機能が壊れても
手入力で運営を継続できる。
```

---

# 58. 最終データフロー

```text
              X
              │
              ▼
     Browser Extension
              │
              ▼
       XPostExtractor
              │
              ▼
        Entry Draft
              │
              ▼
       確認・手動修正
              │
              ▼
             DB
              │
              ▼
        CaptionModel
              │
        ┌─────┴─────┐
        │           │
        │      SVG Template
        │           │
        └─────┬─────┘
              ▼
       CaptionRenderer
              │
       ┌──────┼──────┐
       ▼      ▼      ▼
      SVG    PDF    PNG
```

---

# 59. 本システムの設計原則

本システムの目的は、

「Xを解析するシステム」

ではなく、

「X投稿を入力源の一つとして利用できるキャプション生成システム」

とする。

そのためX依存コードは最小化し、キャプションDBとテンプレート・レンダリング系はXから完全に独立させる。

Xから情報を取得できなくなった場合でも、

```text
手入力
CSV
JSON
```

のいずれかから作品を投入し、キャプション生成を継続できることを基本要件とする。

これにより、X側の仕様変更やブラウザ拡張の一時的な故障がフォトコン運営全体の停止につながらない構成とする。

# 60. 公開・継続運用方針

本プロジェクトは複数年にわたり運用され、担当者が交代することを前提とする。

GitHub上でソースコードを公開し、特定のフォトコンテストや特定団体に依存しない汎用的なキャプション生成基盤として維持できる構造とする。

設計上、以下を明確に分離する。

```text
公開可能な汎用基幹部分
        │
        ├── ブラウザ拡張
        ├── 投稿抽出機構
        ├── DBアクセス層
        ├── 管理UI
        ├── テンプレートエンジン
        ├── SVG/PDF/PNGレンダリング
        └── 設定読み込み機構

運用固有部分
        │
        ├── 実際の応募者データ
        ├── 実際のDB
        ├── フォトコン名称
        ├── 実運用テンプレート
        ├── ロゴ・ブランド素材
        └── 運営固有設定
```

GitHub公開リポジトリには原則として前者のみを含める。

---

# 61. 公開リポジトリの基本原則

公開リポジトリは、第三者がcloneした場合でも特定イベントのデータを必要とせず起動・検証できるものとする。

リポジトリ内には以下を含めてはならない。

```text
実際の応募投稿データ
実際のユーザ名
実際のXユーザーID
応募作品コメント
本番DB
個人情報を含むログ
認証Cookie
セッショントークン
APIキー
秘密鍵
内部サーバ認証情報
非公開デザイン素材
ライセンス上再配布不能なフォント
```

---

# 62. リポジトリ構成

推奨構成は以下とする。

```text
photo-caption-system/
│
├── apps/
│   ├── extension/
│   ├── server/
│   └── admin-web/
│
├── packages/
│   ├── core/
│   ├── x-extractor/
│   ├── database/
│   ├── renderer/
│   ├── template-engine/
│   └── shared-types/
│
├── templates/
│   └── example/
│       ├── template.svg
│       └── template.json
│
├── examples/
│   ├── entries.example.json
│   └── config.example.json
│
├── docs/
│   ├── architecture.md
│   ├── setup.md
│   ├── operation.md
│   ├── template-format.md
│   ├── database.md
│   ├── x-extractor.md
│   └── succession.md
│
├── data/
│   └── .gitkeep
│
├── output/
│   └── .gitkeep
│
├── .gitignore
├── README.md
├── LICENSE
├── CONTRIBUTING.md
└── SECURITY.md
```

---

# 63. Coreパッケージ

システム固有部分から独立した基幹ロジックを、

```text
packages/core
```

に配置する。

CoreはXそのものへ依存してはならない。

Coreが扱う基本データ型は以下とする。

```ts
interface CaptionEntry {
  id: string;
  entryNumber?: string;

  title: string;

  userDisplayName: string;
  userId: string;

  comment: string;

  source?: {
    platform: string;
    postId?: string;
    postUrl?: string;
    originalText?: string;
  };
}
```

X固有情報も`source`以下へ格納し、将来的に他サービスへ入力元を変更できるようにする。

---

# 64. X依存部分の分離

XのDOM解析ロジックは、

```text
packages/x-extractor
```

へ隔離する。

Coreから直接XのDOMを参照してはならない。

処理構造：

```text
X DOM

 ↓

XPostExtractor

 ↓

SourcePost

 ↓

CaptionEntry Draft
```

とする。

---

# 65. 入力元インターフェース

将来的な保守性を考慮し、投稿取得機構に共通インターフェースを定義する。

概念上、

```ts
interface PostExtractor {
  extract(): Promise<SourcePost>;
}
```

とする。

`SourcePost`は、

```ts
interface SourcePost {
  platform: string;

  postId?: string;
  postUrl?: string;

  userDisplayName: string;
  userId: string;

  text: string;
}
```

を基本とする。

初期実装では、

```text
XPostExtractor
```

のみ実装する。

これにより将来的に、

```text
BlueskyPostExtractor
MisskeyPostExtractor
ManualPostExtractor
```

等を追加可能とする。

---

# 66. 運用固有設定の外部化

イベント名称等をソースコードへハードコードしてはならない。

設定ファイルとして外部化する。

例：

```json
{
  "event": {
    "name": "Example Photo Contest",
    "entryNumberPrefix": "PC2026"
  },

  "caption": {
    "defaultTemplate": "museum-default"
  },

  "source": {
    "platform": "x"
  }
}
```

本番用設定はGit管理対象外とする。

GitHubには、

```text
config.example.json
```

のみ含める。

---

# 67. データディレクトリ

実運用データは原則、

```text
data/
```

以下に保存する。

例：

```text
data/
├── database.sqlite
├── config.json
└── backups/
```

`data/`配下はGit管理対象外とする。

`.gitignore`例：

```gitignore
data/*
!data/.gitkeep

output/*
!output/.gitkeep

*.sqlite
*.sqlite3
*.db

.env
.env.*
!.env.example
```

---

# 68. テンプレートの公開・非公開分離

テンプレートエンジン自体は完全に公開可能とする。

一方、実際のイベントで使用するデザインについては別管理可能とする。

公開リポジトリ：

```text
templates/example/
```

のみ保持する。

本番：

```text
data/templates/
```

または外部ディレクトリから読み込む。

構成：

```text
Public Repository

templates/example/
    └─ OSS向けサンプル


Local Environment

data/templates/
    └─ contest-2026/
        ├─ template.svg
        └─ template.json
```

---

# 69. テンプレート探索

テンプレートエンジンは複数のテンプレートディレクトリを探索可能とする。

優先順位：

```text
1. ユーザー指定ディレクトリ
2. data/templates/
3. 同梱example template
```

これにより公開ソースを変更せずイベントごとのデザインを利用できる。

---

# 70. ブランド素材

ロゴ、イベント名称画像、団体固有フォント等についてもコアコードから分離する。

SVG内部へ直接埋め込む場合を除き、

```text
data/assets/
```

等から参照する。

ライセンス上再配布できないフォントをGitHubへ登録してはならない。

READMEでは、

```text
必要フォントを利用者自身が導入すること
```

を明示する。

---

# 71. DBスキーマの公開性

DBスキーマ自体は公開する。

公開可能：

```text
テーブル構造
Migration
ORMモデル
Repository
```

公開不可：

```text
実データ
本番DBファイル
バックアップDB
```

MigrationをGit管理することで、担当者交代後もDB構造を再現可能にする。

---

# 72. Database Migration

スキーマ変更は手動SQL編集ではなくMigrationとして管理する。

例：

```text
migrations/
├── 0001_initial.sql
├── 0002_add_template_id.sql
└── 0003_add_export_status.sql
```

新しい担当者は、

```text
migration実行
```

のみで既存DBを最新形式へ更新できること。

---

# 73. DBバージョン

DB内部にスキーマバージョンを保持する。

例：

```text
schema_version = 3
```

アプリケーション起動時に互換性を確認する。

アプリケーションよりDBが古い場合、

```text
Database migration required.
```

と通知する。

---

# 74. 年度の扱い

年度ごとにソースコードをforkしてはならない。

同一コードベースを継続利用する。

年度固有情報は設定として扱う。

例：

```text
data/
├── 2026/
│   ├── database.sqlite
│   ├── config.json
│   └── templates/
│
├── 2027/
│   ├── database.sqlite
│   ├── config.json
│   └── templates/
│
└── 2028/
```

あるいは単一DB内に、

```text
event_id
```

を保持して複数年度を管理してもよい。

---

# 75. 推奨年度管理方式

長期的には、単一システムから複数イベントを管理できるように、

```text
events
```

テーブルを追加する。

```text
events
─────────────────────────
id
name
year
entry_number_prefix
default_template_id
created_at
```

`entries`には、

```text
event_id
```

を追加する。

関係：

```text
Event
  │
  ├─ Entry
  ├─ Entry
  ├─ Entry
  └─ Entry
```

とする。

これにより年度ごとにアプリケーションを複製する必要をなくす。

---

# 76. イベントアーカイブ

過年度イベントは削除せず、

```text
active
archived
```

状態を持たせる。

過年度のデータを保持したまま、新年度の受付を開始できること。

---

# 77. Git運用

メインブランチは、

```text
main
```

とする。

開発作業は、

```text
feature/*
fix/*
docs/*
```

等のブランチを利用する。

例：

```text
feature/pdf-export
fix/x-dom-2027-04
docs/template-guide
```

---

# 78. Release

運営で使用した安定版にはGit Tagを付与する。

例：

```text
v1.0.0
v1.1.0
v2.0.0
```

年度別にコードを分岐するのではなく、

```text
Photo Contest 2026
  → v1.2.1

Photo Contest 2027
  → v1.5.0
```

のように、使用したバージョンを記録する。

---

# 79. Semantic Versioning

原則SemVerを使用する。

```text
MAJOR.MINOR.PATCH
```

例：

```text
1.4.2
```

MAJOR：

互換性のない変更

MINOR：

後方互換性を保った機能追加

PATCH：

バグ修正

---

# 80. README必須内容

READMEには最低限以下を記載する。

```text
・このプロジェクトの目的
・スクリーンショット
・システム構成
・動作環境
・インストール方法
・起動方法
・ブラウザ拡張導入方法
・テンプレート追加方法
・DB保存場所
・バックアップ方法
・既知の制限
・X DOM変更時の注意
・ライセンス
・開発者向けドキュメントへのリンク
```

---

# 81. 引継ぎドキュメント

担当者交代を重要なユースケースとして扱う。

以下を、

```text
docs/succession.md
```

として必須作成する。

内容：

```text
1. プロジェクト全体構成

2. 普段の運用方法

3. 新年度開始方法

4. DBバックアップ方法

5. DB復旧方法

6. テンプレート交換方法

7. ブラウザ拡張更新方法

8. X側仕様変更時に確認する場所

9. Release作成方法

10. 前年度データのアーカイブ方法

11. トラブル時の手動運用方法
```

---

# 82. X仕様変更時の保守ガイド

X側DOM変更が長期運用上最も発生しやすい障害である。

専用ドキュメント、

```text
docs/x-extractor.md
```

を作成する。

少なくとも、

```text
投稿要素の特定方法
表示名の取得場所
ユーザーIDの取得場所
本文の取得場所
投稿URLの取得方法
投稿IDの導出方法
テスト方法
```

を記載する。

コードを初めて読む担当者でも`x-extractor`のみ修正できることを目標とする。

---

# 83. 自動テスト

公開OSSとしての継続性を確保するため、Core部分には自動テストを設ける。

最低限：

```text
CaptionModel変換

タイトル・コメント解析

テンプレート変数置換

改行計算

ファイル名生成

DB CRUD

Migration

JSON/CSV Import/Export
```

をテストする。

---

# 84. X Extractorのテスト

Xの実サイトへ依存するE2Eテストのみとしない。

匿名化したHTML fixtureを保持する。

例：

```text
tests/fixtures/x/
├── single-post.html
├── post-with-image.html
├── multiline-post.html
└── quoted-post.html
```

これによりXへアクセスせずExtract処理をテストできるようにする。

fixture内には実ユーザー情報を使用しない。

---

# 85. CI

GitHub Actions等によるCIを設定可能な構成とする。

最低限、

```text
Install
 ↓
Lint
 ↓
Type Check
 ↓
Unit Test
 ↓
Build
```

を実施する。

GitHub Actionsの設定自体も公開リポジトリに含める。

---

# 86. Release Artifact

Release作成時には、可能であれば以下を自動生成する。

```text
Browser Extension ZIP

Server package

Admin UI package
```

これにより後任担当者がソースからビルドできなくても、安定版を取得しやすくする。

---

# 87. ライセンス

公開基幹部分には明示的なOSSライセンスを設定する。

ライセンス未指定状態で公開してはならない。

想定候補：

```text
MIT License
Apache License 2.0
```

本システム程度のツールで、第三者利用や改変を広く許容する場合はMIT Licenseを基本候補とする。

ただし団体の方針に応じて最終決定する。

---

# 88. NOTICE / Third Party Licenses

利用ライブラリについて、

```text
THIRD_PARTY_LICENSES
```

または同等の仕組みでライセンスを管理する。

SVGテンプレートに外部素材等を含める場合もライセンス条件を確認する。

---

# 89. SECURITY.md

以下を明記する。

```text
本システムはXのCookieを取得しない。

Xログイン認証情報を保存しない。

投稿ページ上に表示されている情報のみを取得対象とする。

本番DBには投稿者情報が含まれるため、公開リポジトリへcommitしない。
```

また、脆弱性報告の方法も記載する。

---

# 90. 個人情報混入防止

Gitへの誤commit対策として、多重防御を行う。

```text
.gitignore
+
Git pre-commit check
+
CI secret/data check
```

可能であれば、

```text
database.sqlite
CSV実データ
JSON実データ
.env
```

等をcommitしようとした場合に警告または拒否する。

---

# 91. サンプルデータ

開発・デモ用には完全な架空データのみを使用する。

例：

```json
{
  "title": "Sample Photograph",
  "userDisplayName": "Example User",
  "userId": "@example",
  "comment": "This is example data.",
  "source": {
    "platform": "x",
    "postId": "0000000000000000000",
    "postUrl": "https://x.com/example/status/0000000000000000000"
  }
}
```

実際の過去応募をサンプルとして転用しない。

---

# 92. 開発環境の再現性

担当者交代を考慮し、依存バージョンを固定または適切にロックする。

例えばNode.js環境であれば、

```text
package.json
package-lock.json
```

等をGit管理する。

特定担当者のPCだけでビルド可能な状態を避ける。

---

# 93. ローカル環境初期化

新しい担当者は原則として、

```text
git clone

↓

依存関係インストール

↓

サンプル設定コピー

↓

起動
```

程度で開発環境を作成できること。

初期化手順は、

```text
docs/setup.md
```

へ完全に記載する。

---

# 94. 設定ファイル生成

初回起動時に、

```text
config.example.json
```

から、

```text
data/config.json
```

を生成する補助機能を用意してもよい。

公開サンプルと実運用設定を混同しない。

---

# 95. 本番データのバックアップ

GitHubを本番データのバックアップ用途に使用してはならない。

GitHub：

```text
ソースコード
ドキュメント
公開サンプル
```

を管理する。

別バックアップ：

```text
DB
テンプレート
設定
```

を管理する。

担当引継ぎ時には、

```text
ソースコード
+
最新Release番号
+
dataディレクトリのバックアップ
```

を引き渡す。

---

# 96. 開発者交代時の最低引継ぎ物

以下が揃えば次担当者が運用を復旧できる状態を目標とする。

```text
GitHub Repository

+

data/
 ├─ database.sqlite
 ├─ config.json
 └─ templates/

+

利用バージョン情報
```

特定担当者の知識や端末に依存する情報を作らない。

---

# 97. 公開API境界

パッケージ間インターフェースを明確化する。

```text
PostExtractor

EntryRepository

TemplateRepository

CaptionRenderer
```

等を主要境界として扱う。

これにより、将来の担当者が一部分だけ実装交換可能とする。

例：

```text
SQLiteRepository
        ↓
PostgreSQLRepository
```

へ交換しても、Renderer等には影響を与えない。

---

# 98. プロジェクトとしての最終構造

```text
                    Public GitHub Repository
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
 Browser Extension          Core                 Renderer
       │                      │                      │
   X Extractor          Data Models          Template Engine
                              │                      │
                              └──────────┬───────────┘
                                         │
                                    Local Server
                                         │
                                         ▼

                              ┌────────────────────┐
                              │   Private Data     │
                              │                    │
                              │ database.sqlite    │
                              │ config.json        │
                              │ templates/         │
                              │ assets/            │
                              └────────────────────┘
```

公開GitHubリポジトリのみでは実際の応募者情報を復元できない構成とする。

同時に、公開リポジトリとサンプルデータだけでシステムのビルド・テスト・評価が可能であることを要求する。

---

# 99. 長期運用上の最重要原則

本プロジェクトでは、

```text
コード
データ
デザイン
イベント設定
```

を別物として扱う。

年度更新や担当者交代に際してソースコードを書き換える運用を原則禁止する。

理想的な年度更新は、

```text
新Event作成
 ↓
イベント設定入力
 ↓
新テンプレート登録
 ↓
受付開始
```

のみで完了すること。

コード変更は、

```text
バグ修正
X側仕様変更対応
新機能追加
```

の場合に限定する。

これにより、本システムを単年度のフォトコン専用ツールではなく、複数年継続利用可能な汎用キャプション生成基盤として維持する。