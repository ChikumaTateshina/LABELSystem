# アーキテクチャ

## 設計原則

本システムは「Xを解析するシステム」ではなく、
「X投稿を入力源の一つとして利用できるキャプション生成システム」です。
次の4つを独立させ、1つの巨大な処理にしません。

| # | 役割 | 実装場所 |
| --- | --- | --- |
| ① | Xから情報を取得する | `packages/x-extractor`, `apps/extension` |
| ② | 情報を保存・編集する | `packages/database`, `apps/server`, `apps/admin-web` |
| ③ | デザインへ配置する | `packages/template-engine`, `packages/renderer/svg` |
| ④ | ファイルとして出力する | `packages/renderer/{pdf,png,html}` |

また、**コード・データ・デザイン・イベント設定**を別物として扱います。
年度更新や担当者交代のためにソースコードを書き換える必要はありません。

## データフロー

```text
X のページ
   │  XPostExtractor（packages/x-extractor）
   ▼
SourcePost ──POST /api/parse──▶ EntryDraft（タイトル・コメント解析: packages/core）
   │                               │ 登録確認画面で人が確認・修正
   ▼                               ▼
                     POST /api/entries ──▶ EntryRepository ──▶ SQLite
                                                  │
                                                  ▼
                                      CaptionModel（packages/core）
                                                  │        Template（packages/template-engine）
                                                  ▼            │
                                       CaptionRenderer.render() ◀┘
                                                  │
                                                  ▼
                                         RenderedCaption（SVG + 警告）
                                          ├─▶ PDF  (pdfkit + svg-to-pdfkit)
                                          ├─▶ PNG  (resvg)
                                          └─▶ HTML (template.html + template.css)
```

## 主要な境界（交換可能な単位）

型は `packages/shared-types/index.ts` にあります。

| インターフェース | 現在の実装 | 交換例 |
| --- | --- | --- |
| `PostExtractor` | `XPostExtractor` | Bluesky / Misskey 用の Extractor を追加 |
| `EntryRepository` / `EventRepository` | `SqliteEntryRepository` / `SqliteEventRepository` | PostgreSQL 実装へ交換 |
| `TemplateRepository` | `FsTemplateRepository` | 別の保管場所から読み込む |
| `CaptionRenderer` | `packages/renderer/index.ts` | 出力形式の追加 |
| `FontProvider` | `FontRegistry` | テストでは固定幅のダミーを使用 |

依存の向きは `apps → packages`、`packages/*` の中では `shared-types` と `core` が最下層です。
`core` は X にも DB にも依存しません。

## ローカルAPI

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/health` | 稼働確認 |
| GET | `/api/config` | イベント設定・出力先など |
| GET / POST | `/api/events` | イベント一覧 / 作成 |
| PUT | `/api/events/{id}` | イベント更新（アーカイブ等） |
| GET | `/api/templates` | テンプレート一覧 |
| POST | `/api/parse` | SourcePost → ドラフト（登録済みなら `existing` を返す） |
| GET / POST | `/api/entries` | 一覧（`?eventId=&status=`）/ 登録 |
| GET / PUT / DELETE | `/api/entries/{id}` | 取得 / 更新 / 削除 |
| GET | `/api/entries/by-post/{postId}` | 投稿IDから検索 |
| POST | `/api/preview` | 未保存の内容をプレビュー（SVG + 警告） |
| GET | `/api/entries/{id}/caption.{svg\|pdf\|png\|html}` | 1件を出力（`?template=&download=1`） |
| POST | `/api/export` | 一括出力（`output/` へ書き出し） |
| GET | `/api/data/entries.{json\|csv}` | 作品データのエクスポート |
| POST | `/api/import` | 作品データのインポート |
| POST | `/api/sheet/sync` | スプレッドシートから新しい行を取り込む |
| POST | `/api/backup` | バックアップ作成 |

重複登録時は `409` と `{ code: "duplicate-post", existing: {...} }` を返します。

## セキュリティ上の前提

- サーバは `127.0.0.1` のみで待ち受けます。`Host` ヘッダがローカル以外の要求は拒否します（DNSリバインディング対策）。
- 他オリジンからの要求は、ブラウザ拡張（`chrome-extension://` / `moz-extension://`）以外を拒否します。
- 更新系APIは `Content-Type: application/json` を必須とします。
- 拡張機能が送信するのは、投稿から取得した情報と運営者が入力した情報のみです。
- 操作ログ（`data/logs/operations.log`）にはIDと管理番号のみを記録し、投稿者情報は書きません。
- サーバが外部へ通信するのは、スプレッドシート連携を設定した場合の `sheet.url` への取得（GET）のみです。

## 管理番号

DBには連番（例: `042`）だけを保存し、表示時にイベントの接頭辞と
`event.entryNumberFormat`（既定 `{prefix}-{number}`）を適用して `PC2026-042` のように表示します。
採番はイベントごとに独立しています。
