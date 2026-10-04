import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { SheetSettings } from './sheet.ts';

export interface AppConfig {
  /** スプレッドシート（GASウェブアプリ）への接続先 */
  sheet: SheetSettings;
  /** 既定のテンプレート */
  template: string;
  /** PNG出力の解像度 */
  pngDpi: number;
  /** 追加のテンプレート置き場（最優先で探索） */
  templateDirs: string[];
  /** 追加のフォント置き場 */
  fontDirs: string[];
}

export interface AppPaths {
  /** 実行ファイル（開発時はリポジトリ）のあるフォルダ */
  baseDir: string;
  dataDir: string;
  outputDir: string;
  configFile: string;
  templatesDir: string;
}

const DEFAULTS: AppConfig = {
  sheet: { url: '', token: '' },
  template: 'example',
  pngDpi: 300,
  templateDirs: [],
  fontDirs: [],
};

export function resolvePaths(baseDir: string): AppPaths {
  const base = resolve(baseDir);
  const dataDir = resolve(process.env.LABEL_DATA_DIR ?? join(base, 'data'));
  return {
    baseDir: base,
    dataDir,
    outputDir: resolve(process.env.LABEL_OUTPUT_DIR ?? join(base, 'output')),
    configFile: join(dataDir, 'config.json'),
    templatesDir: join(base, 'templates'),
  };
}

function readRaw(paths: AppPaths): Partial<AppConfig> {
  if (!existsSync(paths.configFile)) return {};
  try {
    return JSON.parse(readFileSync(paths.configFile, 'utf8')) as Partial<AppConfig>;
  } catch (error) {
    throw new Error(`${paths.configFile} を解析できません: ${(error as Error).message}`);
  }
}

export function loadConfig(paths: AppPaths): AppConfig {
  const raw = readRaw(paths);
  const fromData = (p: string) => (isAbsolute(p) ? p : resolve(paths.dataDir, p));
  return {
    sheet: { ...DEFAULTS.sheet, ...(raw.sheet ?? {}) },
    template: raw.template || DEFAULTS.template,
    pngDpi: Number(raw.pngDpi) > 0 ? Number(raw.pngDpi) : DEFAULTS.pngDpi,
    templateDirs: (raw.templateDirs ?? []).map(fromData),
    fontDirs: (raw.fontDirs ?? []).map(fromData),
  };
}

/** 指定した項目だけを data/config.json へ書き込む。他の項目は変更しない。 */
export function saveConfig(paths: AppPaths, changes: Partial<Pick<AppConfig, 'sheet' | 'template'>>): void {
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ ...readRaw(paths), ...changes }, null, 2) + '\n');
}
