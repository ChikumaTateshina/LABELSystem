# データベース

SQLiteの単一ファイル `data/database.sqlite` を使用します（Node.js 標準の `node:sqlite`）。
アプリケーションは `EntryRepository` / `EventRepository` 越しにのみDBへアクセスするため、
PostgreSQL等へ交換する場合は `packages/database/` に別実装を追加します。

## スキーマ

### entries — 作品

| 列 | 内容 |
| --- | --- |
| `id` | 内部ID（UUID） |
| `event_id` | 所属イベント（`events.id`） |
| `entry_number` | 管理番号の連番部分（例: `042`）。イベント内で一意 |
| `title` | 作品タイトル（展示データ） |
| `user_display_name` | 表示名（展示データ） |
| `user_id` | ユーザID `@example`（展示データ） |
| `comment` | コメント（展示データ） |
| `original_post_text` | 元投稿本文（改変前。更新APIでは変更されない） |
| `source_platform` | 入力元（`x` / `manual` など） |
| `source_post_id` | 投稿ID。**UNIQUE**（重複登録防止） |
| `source_post_url` | 元投稿URL |
| `status` | `draft` / `confirmed` / `exported` |
| `template_id` | 作品ごとのテンプレート指定（NULLならイベントの既定） |
| `created_at` / `updated_at` | ISO 8601（UTC） |

「元データ ≠ 展示データ」です。`title` や `comment` を編集しても `original_post_text` は変わりません。

### events — イベント（年度）

| 列 | 内容 |
| --- | --- |
| `id` | 内部ID |
| `name` | イベント名 |
| `year` | 年度 |
| `entry_number_prefix` | 管理番号の接頭辞（例: `PC2026`） |
| `default_template_id` | 既定テンプレート |
| `status` | `active` / `archived` |
| `created_at` | 作成日時 |

### schema_meta

`schema_version` に適用済みMigrationの番号を保持します。

## Migration

スキーマ変更は `packages/database/migrations/` にSQLファイルを追加して行います。手でDBを書き換えないでください。

```text
migrations/
├── 0001_initial.sql
└── 0002_events.sql
```

- ファイル名は `4桁の連番_説明.sql`。番号順に、1ファイル1トランザクションで適用されます。
- 一度公開したMigrationは変更せず、新しい番号のファイルを追加します。
- 起動時の動作:
  - 新規DB → 自動で最新まで適用
  - 古いDB → `Database migration required.` と表示して終了
  - アプリより新しいDB → エラー（アプリを更新する）

古いDBを更新するには:

```sh
npm run migrate
```

実行前に `data/backups/database.before-migrate-v<旧バージョン>.<時刻>.sqlite` が自動で作成されます。

### Migrationを追加する手順

1. `packages/database/migrations/000N_<説明>.sql` を作成する。
2. `packages/database/sqliteRepositories.ts` の読み書きを新しい列に対応させる。
3. `tests/database.test.ts` にテストを追加し、`npm test` を通す。
4. `docs/database.md`（この文書）のスキーマ表を更新する。

## 公開してよいもの・いけないもの

| 公開可 | 公開不可 |
| --- | --- |
| テーブル構造、Migration、Repository | 実データ、本番DBファイル、バックアップDB |

`*.sqlite` と `data/` は `.gitignore`、pre-commitフック、CIの三重で除外しています。
