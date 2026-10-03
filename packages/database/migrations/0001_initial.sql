-- 0001: 初期スキーマ（仕様 §14）
CREATE TABLE entries (
  id                 TEXT PRIMARY KEY,
  entry_number       TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  user_display_name  TEXT NOT NULL DEFAULT '',
  user_id            TEXT NOT NULL DEFAULT '',
  comment            TEXT NOT NULL DEFAULT '',
  original_post_text TEXT,
  source_post_id     TEXT UNIQUE,
  source_post_url    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'confirmed', 'exported')),
  template_id        TEXT
);
