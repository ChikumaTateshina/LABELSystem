import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class MigrationRequiredError extends Error {
  constructor(
    public readonly current: number,
    public readonly latest: number,
  ) {
    super(`Database migration required. (schema_version = ${current}, required = ${latest})`);
  }
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: Number(f.slice(0, 4)),
      name: f,
      sql: readFileSync(join(dir, f), 'utf8'),
    }));
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/** DB内部に保持しているスキーマバージョンを返す（仕様 §73）。未初期化のDBは 0。 */
export function getSchemaVersion(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

export function latestSchemaVersion(migrations: Migration[] = loadMigrations()): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/** 未適用のMigrationを順に適用する。各Migrationは1トランザクションで実行する。 */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = loadMigrations()): number[] {
  const applied: number[] = [];
  let current = getSchemaVersion(db);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(migration.version));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.name} の適用に失敗しました: ${(error as Error).message}`);
    }
    current = migration.version;
    applied.push(migration.version);
  }
  return applied;
}

/**
 * アプリケーション起動時の互換性確認。
 * 新規DBは自動で初期化し、古いDBは MigrationRequiredError を投げて明示的な migrate を促す。
 */
export function ensureCompatible(db: DatabaseSync, migrations: Migration[] = loadMigrations()): void {
  const current = getSchemaVersion(db);
  const latest = latestSchemaVersion(migrations);
  if (current === 0) {
    runMigrations(db, migrations);
  } else if (current < latest) {
    throw new MigrationRequiredError(current, latest);
  } else if (current > latest) {
    throw new Error(
      `このDBはより新しいバージョンのアプリケーションで作成されています (schema_version = ${current}, 対応 = ${latest})。`,
    );
  }
}
