/**
 * DBスキーマを最新へ更新する（仕様 §72）。
 *   npm run migrate
 * 実行前に data/backups/ へDBのコピーを保存する。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getSchemaVersion,
  latestSchemaVersion,
  openDatabase,
  runMigrations,
} from '../../../packages/database/index.ts';
import { resolvePaths } from './config.ts';

const paths = resolvePaths();
mkdirSync(paths.dataDir, { recursive: true });

const existed = existsSync(paths.databaseFile);
const db = openDatabase(paths.databaseFile);
const before = getSchemaVersion(db);
const latest = latestSchemaVersion();

if (before >= latest) {
  console.log(`schema_version = ${before}: 最新です。`);
} else {
  if (existed && before > 0) {
    const dir = join(paths.dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const backup = join(dir, `database.before-migrate-v${before}.${Date.now()}.sqlite`);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(paths.databaseFile, backup);
    console.log(`バックアップ: ${backup}`);
  }
  const applied = runMigrations(db);
  console.log(`schema_version: ${before} → ${getSchemaVersion(db)} (適用: ${applied.join(', ')})`);
}
db.close();
