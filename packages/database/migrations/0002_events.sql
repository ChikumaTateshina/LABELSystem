-- 0002: 複数イベント（年度）管理と入力元プラットフォーム（仕様 §63, §75, §76）
CREATE TABLE events (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  year                INTEGER,
  entry_number_prefix TEXT NOT NULL DEFAULT '',
  default_template_id TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'archived')),
  created_at          TEXT NOT NULL
);

-- 0001 の時点で登録済みの作品があれば、引き継ぎ用イベントへ所属させる
INSERT INTO events (id, name, created_at)
SELECT 'legacy-event', 'Imported Event', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM entries);

ALTER TABLE entries ADD COLUMN event_id TEXT REFERENCES events(id);
ALTER TABLE entries ADD COLUMN source_platform TEXT NOT NULL DEFAULT 'manual';

UPDATE entries SET event_id = 'legacy-event';
UPDATE entries SET source_platform = 'x' WHERE source_post_id IS NOT NULL;

CREATE UNIQUE INDEX idx_entries_event_number ON entries (event_id, entry_number);
CREATE INDEX idx_entries_event ON entries (event_id);
