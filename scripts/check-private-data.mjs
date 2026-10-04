/**
 * 個人情報・実データの誤commitを防ぐチェック（仕様 §90）。
 *   node scripts/check-private-data.mjs            Git管理下の全ファイルを検査（CI用）
 *   node scripts/check-private-data.mjs --staged   ステージ済みファイルを検査（pre-commit用）
 * 問題があれば一覧を表示して終了コード1を返す。
 */
import { execFileSync } from 'node:child_process';

const staged = process.argv.includes('--staged');

const RULES = [
  { pattern: /^data\//, reason: 'data/ 配下（接続設定を含む）' },
  { pattern: /^output\//, reason: 'output/ 配下の出力ファイル' },
  { pattern: /(^|\/)\.env(\.(?!example$)[^/]*)?$/, reason: '環境変数ファイル' },
  { pattern: /(^|\/)config\.json$/, reason: '本番用設定ファイル（接続URL・トークンを含む。config.example.json のみ公開する）' },
  { pattern: /\.(pem|key|p12|pfx)$/i, reason: '秘密鍵' },
  { pattern: /(^dist\/|\.exe$)/i, reason: 'ビルド成果物（ReleaseへはGitHub Actionsが添付する）' },
  { pattern: /\.(ttf|otf|ttc|otc|woff2?)$/i, reason: 'フォントファイル（再配布可否を確認し、data/assets/fonts/ へ置く）' },
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

let files;
try {
  files = staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    : git(['ls-files', '-z']);
} catch {
  console.log('check-private-data: Gitリポジトリではないため、検査をスキップしました。');
  process.exit(0);
}

const problems = [];
for (const file of files) {
  const rule = RULES.find((r) => r.pattern.test(file));
  if (rule) problems.push(`  ${file}\n      → ${rule.reason}`);
}

if (problems.length > 0) {
  console.error('公開リポジトリへ含めてはならない可能性のあるファイルが見つかりました:\n');
  console.error(problems.join('\n'));
  console.error('\n意図したものでなければ `git restore --staged <file>` で取り消してください。');
  process.exit(1);
}
console.log(`check-private-data: OK (${files.length} files)`);
