# Contributing

## ブランチ

- メインブランチは `main`。直接commitせず、作業ブランチからPull Requestを作成します。
- ブランチ名: `feature/*`（機能追加）、`fix/*`（修正）、`docs/*`（文書）
  - 例: `feature/pdf-export`、`fix/x-dom-2027-04`、`docs/template-guide`
- 年度ごとにfork・ブランチ分岐はしません。年度固有の内容はイベント設定とテンプレート（`data/`）で扱います。

## 開発の流れ

```sh
npm install
git config core.hooksPath .githooks
npm start          # サーバ起動
npm test           # 自動テスト
npm run lint
npm run typecheck
npm run build      # ブラウザ拡張
```

Pull Requestの前に、上の4つ（test / lint / typecheck / build）が通ることを確認してください。CIでも同じ検査を行います。

## 守ること

- **設計境界を越えない。** XのDOMに触れるコードは `packages/x-extractor` と `apps/extension` のみ。
  `packages/core` は X にも DB にも依存させない。
- **イベント名などをハードコードしない。** 運用固有の値は `data/config.json` またはイベント設定へ。
- **実データを入れない。** テスト・サンプル・fixture・スクリーンショットには架空のデータだけを使う。
  過去の応募をサンプルへ転用しない。
- **DBスキーマはMigrationで変更する。**（[docs/database.md](docs/database.md)）
- Core部分の変更にはテストを追加する。
- 依存ライブラリを追加したら `package-lock.json` をcommitし、`THIRD_PARTY_LICENSES.md` を更新する。
- 再配布できないフォント・素材をcommitしない。

## バージョン

[Semantic Versioning](https://semver.org/lang/ja/) に従います。Releaseの手順は [docs/succession.md](docs/succession.md) を参照してください。
