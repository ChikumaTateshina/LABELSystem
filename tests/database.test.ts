import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DuplicateEntryNumberError,
  DuplicatePostError,
  MigrationRequiredError,
  SqliteEntryRepository,
  SqliteEventRepository,
  ensureCompatible,
  getSchemaVersion,
  latestSchemaVersion,
  loadMigrations,
  openDatabase,
  runMigrations,
} from '../packages/database/index.ts';

function setup() {
  const db = openDatabase(':memory:');
  ensureCompatible(db);
  const events = new SqliteEventRepository(db);
  const entries = new SqliteEntryRepository(db);
  const event = events.create({ name: 'Example Photo Contest', year: 2026, entryNumberPrefix: 'PC2026' });
  return { db, events, entries, event };
}

const base = {
  title: '星降る夜',
  userDisplayName: 'Example User',
  userId: '@example',
  comment: '静かな夜の海を撮影しました。',
};

test('Migration: 新規DBを最新スキーマまで初期化し、バージョンを保持する', () => {
  const db = openDatabase(':memory:');
  assert.equal(getSchemaVersion(db), 0);
  assert.deepEqual(runMigrations(db), loadMigrations().map((m) => m.version));
  assert.equal(getSchemaVersion(db), latestSchemaVersion());
  assert.deepEqual(runMigrations(db), [], '再実行しても何も適用されない');
});

test('Migration: 古いDBは起動時に検出し、migrateで既存データを引き継ぐ', () => {
  const migrations = loadMigrations();
  const db = openDatabase(':memory:');
  runMigrations(db, migrations.slice(0, 1));
  db.prepare(
    `INSERT INTO entries (id, entry_number, title, source_post_id, created_at, updated_at)
     VALUES ('legacy-1', '001', 'Old Entry', '111', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();

  assert.throws(() => ensureCompatible(db, migrations), MigrationRequiredError);
  assert.throws(() => ensureCompatible(db, migrations), /Database migration required\./);

  runMigrations(db, migrations);
  ensureCompatible(db, migrations);
  const entry = new SqliteEntryRepository(db).get('legacy-1');
  assert.equal(entry?.title, 'Old Entry');
  assert.equal(entry?.source?.platform, 'x');
  assert.ok(new SqliteEventRepository(db).get(entry!.eventId), '既存作品は引き継ぎ用イベントに所属する');
});

test('Migration: アプリより新しいDBは拒否する', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'").run();
  assert.throws(() => ensureCompatible(db), /より新しいバージョン/);
});

test('DB CRUD: 作成・取得・一覧・更新・削除', () => {
  const { entries, event } = setup();
  const created = entries.create({
    ...base,
    eventId: event.id,
    entryNumber: '001',
    originalPostText: 'タイトル：星降る夜\n静かな夜の海を撮影しました。',
    sourcePostId: '123456789',
    sourcePostUrl: 'https://x.com/example/status/123456789',
  });
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.status, 'draft');
  assert.equal(created.source?.platform, 'x');
  assert.deepEqual(entries.get(created.id), created);
  assert.equal(entries.findByPostId('123456789')?.id, created.id);
  assert.equal(entries.findByPostId('nope'), null);

  entries.create({ ...base, title: '朝の港', eventId: event.id, entryNumber: '002' });
  assert.deepEqual(entries.list({ eventId: event.id }).map((e) => e.entryNumber), ['001', '002']);
  assert.equal(entries.list({ status: 'confirmed' }).length, 0);
  assert.equal(entries.nextEntryNumber(event.id), 3);

  const updated = entries.update(created.id, { title: '星降る夜（改）', status: 'confirmed', templateId: 'example' });
  assert.equal(updated?.title, '星降る夜（改）');
  assert.equal(updated?.status, 'confirmed');
  assert.equal(updated?.templateId, 'example');
  assert.equal(
    updated?.source?.originalText,
    'タイトル：星降る夜\n静かな夜の海を撮影しました。',
    '元投稿本文は表示情報の更新で変化しない',
  );
  assert.equal(entries.update('missing', { title: 'x' }), null);

  assert.equal(entries.delete(created.id), true);
  assert.equal(entries.delete(created.id), false);
  assert.equal(entries.get(created.id), null);
});

test('重複登録防止: 同じ投稿IDは登録できず、登録済み作品を返す', () => {
  const { entries, event } = setup();
  const first = entries.create({ ...base, eventId: event.id, entryNumber: '001', sourcePostId: '42' });
  assert.throws(
    () => entries.create({ ...base, eventId: event.id, entryNumber: '002', sourcePostId: '42' }),
    (error: unknown) => error instanceof DuplicatePostError && error.existing.id === first.id,
  );
  // 手動登録（投稿IDなし）は何件でも登録できる
  entries.create({ ...base, eventId: event.id, entryNumber: '002' });
  entries.create({ ...base, eventId: event.id, entryNumber: '003' });
  assert.equal(entries.list().length, 3);
});

test('管理番号: イベント内で一意。別イベントでは同じ番号を使える', () => {
  const { entries, events, event } = setup();
  const first = entries.create({ ...base, eventId: event.id, entryNumber: '001' });
  assert.throws(
    () => entries.create({ ...base, eventId: event.id, entryNumber: '001' }),
    DuplicateEntryNumberError,
  );
  const second = entries.create({ ...base, eventId: event.id, entryNumber: '002' });
  assert.throws(() => entries.update(second.id, { entryNumber: '001' }), DuplicateEntryNumberError);
  assert.equal(entries.update(first.id, { entryNumber: '001' })?.entryNumber, '001');

  const next = events.create({ name: 'Example Photo Contest 2027', year: 2027 });
  assert.equal(entries.nextEntryNumber(next.id), 1);
  entries.create({ ...base, eventId: next.id, entryNumber: '001' });
  assert.equal(entries.list({ eventId: next.id }).length, 1);
});

test('イベント: 作成・更新・アーカイブ', () => {
  const { events, event } = setup();
  assert.equal(event.status, 'active');
  assert.equal(event.entryNumberPrefix, 'PC2026');
  const archived = events.update(event.id, { status: 'archived' });
  assert.equal(archived?.status, 'archived');
  assert.equal(archived?.name, 'Example Photo Contest');
  assert.equal(events.list().length, 1);
  assert.equal(events.update('missing', { name: 'x' }), null);
});
