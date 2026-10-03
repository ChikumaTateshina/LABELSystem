# セットアップ

新しい担当者が、何も入っていないPCで開発・運用環境を作るための手順です。

## 1. 必要なもの

- [Node.js](https://nodejs.org/) 22.13 以上（LTS版で可）
- Git
- Chromium系ブラウザ（Chrome / Edge / Brave）または Firefox
- テンプレートが使用するフォント（サンプルは Noto Sans JP）

## 2. 取得とインストール

```sh
git clone https://github.com/ChikumaTateshina/LABELSystem.git
cd LABELSystem
npm install
git config core.hooksPath .githooks   # 実データの誤commitを防ぐフックを有効化
```

依存バージョンは `package-lock.json` で固定されています。CIと同じ状態にしたい場合は `npm ci` を使います。

## 3. 起動

```sh
npm start
```

- 初回起動時に `examples/config.example.json` が `data/config.json` へコピーされます。
- `data/database.sqlite` が作成され、`config.json` の `event` の内容で最初のイベントが作られます。
- <http://127.0.0.1:38471/> を開くと管理画面が表示されます。

前任者から `data/` ディレクトリを引き継いだ場合は、起動前にそれをリポジトリ直下へ置いてください。
DBが古い形式の場合は `Database migration required.` と表示されるので、`npm run migrate` を実行します。

## 4. 設定（`data/config.json`）

```jsonc
{
  "event": {
    "name": "Example Photo Contest",   // 最初のイベント名（DB作成時のみ使用）
    "year": 2026,
    "entryNumberPrefix": "PC2026",     // 最初のイベントの接頭辞（DB作成時のみ使用）
    "entryNumberFormat": "{prefix}-{number}",  // 管理番号の表示形式
    "entryNumberDigits": 3             // 連番の桁数
  },
  "caption": { "defaultTemplate": "example" },
  "source": { "platform": "x" },
  "server": { "host": "127.0.0.1", "port": 38471 },
  "parser": {
    "removeHashtags": "all",           // all / contest / none
    "contestHashtags": ["#ExamplePhotoContest"],  // contest のときに除去するタグ
    "removeUrls": true
  },
  "output": { "pngDpi": 300 },         // "directory" で出力先を変更可能
  "sheet": { "url": "", "token": "", "autoSyncMinutes": 0 },  // スプレッドシート連携（docs/gas.md）
  "templateDirs": [],                  // 追加のテンプレート置き場（最優先で探索）
  "fontDirs": []                       // 追加のフォント置き場
}
```

相対パスは `data/` を基準に解決します。イベント名・接頭辞は、DB作成後は管理画面の「イベント管理」が正になります。

環境変数:

| 変数 | 内容 |
| --- | --- |
| `LABEL_DATA_DIR` | データディレクトリ（既定: `./data`）。年度別運用では `data/2026` などを指定 |
| `LABEL_OUTPUT_DIR` | 出力先（既定: `./output`） |
| `LABEL_PORT` | 待ち受けポート |

```sh
# bash / zsh
LABEL_DATA_DIR=data/2027 npm start
# Windows PowerShell
$env:LABEL_DATA_DIR = "data/2027"; npm start
```

## 5. ブラウザ拡張

```sh
npm run build
```

`apps/extension/dist/` を、Chrome / Edge では「パッケージ化されていない拡張機能を読み込む」、
Firefox では「一時的なアドオンを読み込む」から読み込みます。

- サーバのポートを変更した場合は、拡張機能のポップアップ下部「設定」でURLを変更します。
- 拡張機能を読み込んだ後は、開いていたXのタブを一度再読み込みしてください。
- Firefoxでは、アドオン管理画面の「権限」で `x.com` へのアクセスを許可する必要があります。

## 6. 動作確認

```sh
npm test                           # 自動テスト
npx tsx scripts/smoke-render.ts    # サンプルデータで SVG/PDF/PNG/HTML を output/smoke/ に生成
```

管理画面の「インポート」から `examples/entries.example.json` を読み込むと、架空データで一通り試せます。
