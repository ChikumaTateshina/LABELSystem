/**
 * 単一実行ファイル（LABELSystem.exe）の入口。
 *
 * Node.js もライブラリも同梱されているため、利用者のPCへのインストールは不要。
 * 必要なリソースは scripts/build-exe.mjs が `label-embedded` として埋め込む。
 * 起動時に、exeと同じフォルダへ次のものを書き出す:
 *
 *   templates/example/  サンプルテンプレート（無い場合のみ。複製して自分のデザインを作れる）
 *   extension/          ブラウザ拡張（Xからの取り込み用。ブラウザへ読み込む）
 *   gas/Code.gs         スプレッドシートへ貼り付けるスクリプト
 *   licenses/           ライセンス表示
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { files } from 'label-embedded';
import { resolvePaths } from './config.ts';
import { setResvgWasm } from './render/index.ts';
import { reportFatal, start } from './start.ts';

function embedded(name: string): Buffer {
  const data = files[name];
  if (data === undefined) throw new Error(`同梱ファイルがありません: ${name}`);
  return Buffer.from(data, 'base64');
}

function extract(prefix: string, targetDir: string, overwrite: boolean): void {
  for (const name of Object.keys(files)) {
    if (!name.startsWith(prefix)) continue;
    const target = join(targetDir, name.slice(prefix.length));
    if (!overwrite && fs.existsSync(target)) continue;
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, embedded(name));
  }
}

/**
 * pdfkit は標準フォントのメトリクス（.afm）を自身のフォルダから読み込む。
 * exeにはそのフォルダが無いため、該当ファイルの読み込みだけを同梱データへ差し替える。
 */
function servePdfkitData(): void {
  const original = fs.readFileSync;
  const patched = (path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string') {
      const match = /[\\/]data[\\/]([A-Za-z-]+\.afm)$/.exec(path);
      if (match && files[`pdfkit/${match[1]}`] !== undefined) {
        const data = embedded(`pdfkit/${match[1]}`);
        return rest[0] ? data.toString('utf8') : data;
      }
    }
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  };
  (fs as { readFileSync: unknown }).readFileSync = patched;
}

function main(): Promise<void> {
  const baseDir = dirname(process.execPath);
  const paths = resolvePaths(baseDir);

  servePdfkitData();
  setResvgWasm(embedded('resvg.wasm'));
  if (!fs.existsSync(join(paths.templatesDir, 'example', 'template.json'))) {
    extract('templates/', paths.templatesDir, false);
  }
  extract('extension/', join(baseDir, 'extension'), true);
  extract('gas/', join(baseDir, 'gas'), true);
  extract('licenses/', join(baseDir, 'licenses'), true);

  const ui = Object.fromEntries(
    Object.keys(files)
      .filter((name) => name.startsWith('ui/'))
      .map((name) => [name.slice(3), embedded(name).toString('utf8')]),
  );
  return start(paths, ui);
}

main().catch(reportFatal);
