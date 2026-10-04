import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LabelApp } from './app.ts';
import type { AppPaths } from './config.ts';
import { extractIcon, showError } from './desktop.ts';
import { openWindow } from './window.ts';

/** 画面を構成するファイル（ファイル名 → 内容）。index.html が入口。 */
export type UiSource = Record<string, string>;

/** index.html が参照しているCSSとJavaScriptを埋め込んだ、単一のHTMLにする。 */
export function buildPage(ui: UiSource): string {
  return (ui['index.html'] ?? '')
    // どのビルドを使っているかを画面に表示する（build.txt は exe のビルド時に作られる）
    .replace('<!--build-->', () => (ui['build.txt'] ?? '開発版').trim())
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (whole, name: string) =>
      ui[name] === undefined ? whole : `<style>\n${ui[name]}\n</style>`,
    )
    .replace(/<script src="([^"]+)"><\/script>/g, (whole, name: string) =>
      ui[name] === undefined ? whole : `<script>\n${ui[name].replace(/<\/script/gi, '<\\/script')}\n</script>`,
    );
}

/**
 * LABELSystem を起動する。ソースからの起動（main.ts）と単一exe（exeMain.ts）の共通処理。
 * ウィンドウを開き、閉じられたら終了する。サーバは立てない。
 */
export async function start(paths: AppPaths, ui: UiSource): Promise<void> {
  const app = new LabelApp(paths);
  const uiDir = join(paths.dataDir, 'cache', 'ui');
  mkdirSync(uiDir, { recursive: true });
  const page = join(uiDir, 'index.html');
  writeFileSync(page, buildPage(ui));

  // ウィンドウのアイコンを、この実行ファイルのアイコンと同じものにする（index.html が icon.png を参照する）。
  // 取り出しには1〜2秒かかるため、実行ファイルが変わったときだけ行う。
  const icon = join(uiDir, 'icon.png');
  if (!existsSync(icon) || statSync(icon).mtimeMs < statSync(process.execPath).mtimeMs) {
    extractIcon(process.execPath, icon);
  }

  await openWindow({
    page,
    profileDir: join(paths.dataDir, 'cache', 'window'),
    handler: app.handle,
    onClose: () => process.exit(0),
  });
}

/** 起動に失敗した理由を表示して終了する。 */
export function reportFatal(error: unknown): void {
  showError(`LABELSystem を起動できませんでした。\n\n${(error as Error)?.message ?? error}`);
  setTimeout(() => process.exit(1), 500);
}
