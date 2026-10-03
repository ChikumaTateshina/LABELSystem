import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CaptionEntry,
  EntryInput,
  EntryListFilter,
  EntryRepository,
  EntryStatus,
  EntryUpdate,
  EventInput,
  EventRecord,
  EventRepository,
  EventStatus,
} from '../shared-types/index.ts';

export class DuplicatePostError extends Error {
  constructor(public readonly existing: CaptionEntry) {
    super('この投稿は既に登録されています。');
  }
}

export class DuplicateEntryNumberError extends Error {
  constructor(entryNumber: string) {
    super(`管理番号 ${entryNumber} は既に使用されています。`);
  }
}

interface EntryRow {
  id: string;
  event_id: string;
  entry_number: string;
  title: string;
  user_display_name: string;
  user_id: string;
  comment: string;
  original_post_text: string | null;
  source_platform: string;
  source_post_id: string | null;
  source_post_url: string | null;
  created_at: string;
  updated_at: string;
  status: EntryStatus;
  template_id: string | null;
}

function rowToEntry(row: EntryRow): CaptionEntry {
  return {
    id: row.id,
    eventId: row.event_id,
    entryNumber: row.entry_number,
    title: row.title,
    userDisplayName: row.user_display_name,
    userId: row.user_id,
    comment: row.comment,
    status: row.status,
    templateId: row.template_id,
    source: {
      platform: row.source_platform,
      postId: row.source_post_id ?? undefined,
      postUrl: row.source_post_url ?? undefined,
      originalText: row.original_post_text ?? undefined,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPDATABLE_COLUMNS: Record<keyof EntryUpdate, string> = {
  entryNumber: 'entry_number',
  title: 'title',
  userDisplayName: 'user_display_name',
  userId: 'user_id',
  comment: 'comment',
  status: 'status',
  templateId: 'template_id',
};

export class SqliteEntryRepository implements EntryRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: EntryInput & { eventId: string; entryNumber: string }): CaptionEntry {
    if (input.sourcePostId) {
      const existing = this.findByPostId(input.sourcePostId);
      if (existing) throw new DuplicatePostError(existing);
    }
    this.assertNumberAvailable(input.eventId, input.entryNumber);

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO entries (
           id, event_id, entry_number, title, user_display_name, user_id, comment,
           original_post_text, source_platform, source_post_id, source_post_url,
           created_at, updated_at, status, template_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.eventId,
        input.entryNumber,
        input.title,
        input.userDisplayName,
        input.userId,
        input.comment,
        input.originalPostText ?? null,
        input.sourcePlatform ?? (input.sourcePostId ? 'x' : 'manual'),
        input.sourcePostId ?? null,
        input.sourcePostUrl ?? null,
        now,
        now,
        input.status ?? 'draft',
        input.templateId ?? null,
      );
    return this.get(id)!;
  }

  update(id: string, patch: EntryUpdate): CaptionEntry | null {
    const current = this.get(id);
    if (!current) return null;
    if (patch.entryNumber !== undefined && patch.entryNumber !== current.entryNumber) {
      this.assertNumberAvailable(current.eventId, patch.entryNumber);
    }

    const sets: string[] = [];
    const values: (string | null)[] = [];
    for (const key of Object.keys(UPDATABLE_COLUMNS) as (keyof EntryUpdate)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${UPDATABLE_COLUMNS[key]} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return current;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    this.db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes) > 0;
  }

  get(id: string): CaptionEntry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  list(filter: EntryListFilter = {}): CaptionEntry[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filter.eventId) {
      where.push('event_id = ?');
      values.push(filter.eventId);
    }
    if (filter.status) {
      where.push('status = ?');
      values.push(filter.status);
    }
    const sql =
      'SELECT * FROM entries' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY event_id, entry_number, created_at';
    return (this.db.prepare(sql).all(...values) as unknown as EntryRow[]).map(rowToEntry);
  }

  findByPostId(postId: string): CaptionEntry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE source_post_id = ?').get(postId) as
      | EntryRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  nextEntryNumber(eventId: string): number {
    const row = this.db
      .prepare('SELECT MAX(CAST(entry_number AS INTEGER)) AS max FROM entries WHERE event_id = ?')
      .get(eventId) as { max: number | null };
    return (row.max ?? 0) + 1;
  }

  private assertNumberAvailable(eventId: string, entryNumber: string): void {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM entries WHERE event_id = ? AND entry_number = ?')
      .get(eventId, entryNumber);
    if (row) throw new DuplicateEntryNumberError(entryNumber);
  }
}

interface EventRow {
  id: string;
  name: string;
  year: number | null;
  entry_number_prefix: string;
  default_template_id: string | null;
  status: EventStatus;
  created_at: string;
}

function rowToEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    name: row.name,
    year: row.year,
    entryNumberPrefix: row.entry_number_prefix,
    defaultTemplateId: row.default_template_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: EventInput): EventRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO events (id, name, year, entry_number_prefix, default_template_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.year ?? null,
        input.entryNumberPrefix ?? '',
        input.defaultTemplateId ?? null,
        input.status ?? 'active',
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<EventInput>): EventRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      year: patch.year === undefined ? current.year : patch.year,
      entryNumberPrefix: patch.entryNumberPrefix ?? current.entryNumberPrefix,
      defaultTemplateId:
        patch.defaultTemplateId === undefined ? current.defaultTemplateId : patch.defaultTemplateId,
      status: patch.status ?? current.status,
    };
    this.db
      .prepare(
        `UPDATE events SET name = ?, year = ?, entry_number_prefix = ?, default_template_id = ?, status = ?
         WHERE id = ?`,
      )
      .run(next.name, next.year, next.entryNumberPrefix, next.defaultTemplateId, next.status, id);
    return this.get(id);
  }

  get(id: string): EventRecord | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  list(): EventRecord[] {
    return (
      this.db.prepare('SELECT * FROM events ORDER BY created_at DESC, rowid DESC').all() as unknown as EventRow[]
    ).map(rowToEvent);
  }
}
