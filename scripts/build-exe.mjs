/**
 * インストール不要の単一実行ファイルをビルドする。
 *   npm run build:exe
 *
 * dist/LABELSystem.exe（Windows。他のOSでは dist/LABELSystem）を出力する。
 * Node.js の Single Executable Application 機能を使い、
 * Node.js 本体・全ライブラリ・画面・サンプルテンプレート・ブラウザ拡張・GASスクリプトを1ファイルへまとめる。
 * ビルドに使った Node.js がそのまま同梱されるため、配布先のOSと同じOSでビルドすること。
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const work = join(dist, 'exe-build');
const exeName = process.platform === 'win32' ? 'LABELSystem.exe' : 'LABELSystem';
// いったん作業フォルダへ作り、完成してから dist/ へ置く（実行中のexeを壊さないため）
const exe = join(work, exeName);
const finalExe = join(dist, exeName);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. ブラウザ拡張をビルドする（exeへ同梱するため）
execFileSync(process.execPath, [join(root, 'scripts', 'build-extension.mjs')], { stdio: 'inherit' });

// 2. 同梱するファイルを集める
const files = {};
const add = (name, path) => (files[name] = readFileSync(path).toString('base64'));
const addDir = (prefix, dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) addDir(`${prefix}${entry}/`, path);
    else add(`${prefix}${entry}`, path);
  }
};
addDir('ui/', join(root, 'src', 'ui'));
// 画面に表示するビルドの識別（バージョンとビルド日時）
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stamp = new Date().toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
files['ui/build.txt'] = Buffer.from(`v${version}（${stamp} ビルド）`).toString('base64');
addDir('templates/', join(root, 'templates'));
addDir('extension/', join(root, 'extension', 'dist'));
add('gas/Code.gs', join(root, 'gas', 'Code.gs'));
add('licenses/LICENSE.txt', join(root, 'LICENSE'));
add('licenses/THIRD_PARTY_LICENSES.md', join(root, 'THIRD_PARTY_LICENSES.md'));
add('resvg.wasm', require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
const pdfkitData = join(require.resolve('pdfkit'), '..', 'data');
for (const name of readdirSync(pdfkitData).filter((n) => n.endsWith('.afm'))) add(`pdfkit/${name}`, join(pdfkitData, name));

const embedded = join(work, 'embedded.mjs');
writeFileSync(embedded, `export const files = ${JSON.stringify(files)};\n`);

// 3. 本体を1つのCommonJSファイルへまとめる
const bundle = join(work, 'main.cjs');
await build({
  entryPoints: [join(root, 'src', 'exeMain.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  alias: { 'label-embedded': embedded },
  // import.meta は「ソースから起動する場合」の経路でのみ使われ、exeでは実行されない
  logOverride: { 'empty-import-meta': 'silent' },
  legalComments: 'none',
  logLevel: 'warning',
});

// 4. Node.js の実行ファイルへ埋め込む
const blob = join(work, 'sea-prep.blob');
const seaConfig = join(work, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
copyFileSync(process.execPath, exe);

// Windows: コンソール（黒いウィンドウ）を出さないよう、実行ファイルの種別をGUIアプリへ変更する。
// PEヘッダの Subsystem を 3 (CUI) から 2 (GUI) へ書き換えるだけで、プログラム自体は変わらない。
if (process.platform === 'win32') {
  const fd = openSync(exe, 'r+');
  try {
    const dos = Buffer.alloc(64);
    readSync(fd, dos, 0, 64, 0);
    const subsystemOffset = dos.readUInt32LE(0x3c) + 4 + 20 + 68;
    const field = Buffer.alloc(2);
    readSync(fd, field, 0, 2, subsystemOffset);
    if (field.readUInt16LE(0) !== 3) throw new Error(`想定外の Subsystem: ${field.readUInt16LE(0)}`);
    field.writeUInt16LE(2, 0);
    writeSync(fd, field, 0, 2, subsystemOffset);
  } finally {
    closeSync(fd);
  }
}

const { inject } = require('postject');
await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});

let output = finalExe;
try {
  rmSync(finalExe, { force: true });
  copyFileSync(exe, finalExe);
} catch (error) {
  if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
  output = exe;
  console.warn(`\n${relative(root, finalExe)} は実行中のため置き換えられませんでした。LABELSystem を終了してから再実行してください。`);
}

// 中間ファイルは残さない（置き換えられなかった場合は、出来上がったexeが作業フォルダにあるため残す）
if (output === finalExe) rmSync(work, { recursive: true, force: true });

const sizeMb = (statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`\nbuilt: ${relative(root, output)} (${sizeMb} MB, Node.js ${process.versions.node})`);
