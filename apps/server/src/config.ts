import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  event: {
    name: string;
    year?: number | null;
    entryNumberPrefix: string;
    /** 管理番号の表示形式。{prefix} と {number} を使用できる。 */
    entryNumberFormat?: string;
    entryNumberDigits: number;
  };
  caption: { defaultTemplate: string };
  source: { platform: string };
  server: { host: string; port: number };
  parser: {
    removeHashtags: 'all' | 'contest' | 'none';
    contestHashtags: string[];
    removeUrls: boolean;
  };
  output: { pngDpi: number; directory?: string };
  /** スプレッドシート連携（GASウェブアプリ、またはCSVとして公開したシートのURL） */
  sheet: { url: string; token: string; autoSyncMinutes: number };
  templateDirs: string[];
  fontDirs: string[];
}

export interface AppPaths {
  rootDir: string;
  dataDir: string;
  outputDir: string;
  databaseFile: string;
  configFile: string;
  adminWebDir: string;
  bundledTemplatesDir: string;
}

export const ROOT_DIR = fileURLToPath(new URL('../../..', import.meta.url));

const DEFAULTS: AppConfig = {
  event: { name: 'Photo Contest', year: null, entryNumberPrefix: '', entryNumberDigits: 3 },
  caption: { defaultTemplate: 'example' },
  source: { platform: 'x' },
  server: { host: '127.0.0.1', port: 38471 },
  parser: { removeHashtags: 'all', contestHashtags: [], removeUrls: true },
  output: { pngDpi: 300 },
  sheet: { url: '', token: '', autoSyncMinutes: 0 },
  templateDirs: [],
  fontDirs: [],
};

/**
 * 実運用データの置き場所は環境変数 LABEL_DATA_DIR で切り替えられる（年度別運用: data/2026 など）。
 */
export function resolvePaths(overrides: Partial<Pick<AppPaths, 'dataDir' | 'outputDir'>> = {}): AppPaths {
  const rootDir = ROOT_DIR;
  const dataDir = resolve(overrides.dataDir ?? process.env.LABEL_DATA_DIR ?? join(rootDir, 'data'));
  const outputDir = resolve(overrides.outputDir ?? process.env.LABEL_OUTPUT_DIR ?? join(rootDir, 'output'));
  return {
    rootDir,
    dataDir,
    outputDir,
    databaseFile: join(dataDir, 'database.sqlite'),
    configFile: join(dataDir, 'config.json'),
    adminWebDir: join(rootDir, 'apps', 'admin-web'),
    bundledTemplatesDir: join(rootDir, 'templates'),
  };
}

function merge<T extends object>(base: T, override: Partial<T> | undefined): T {
  return { ...base, ...(override ?? {}) };
}

/**
 * data/config.json を読み込む。存在しない場合は examples/config.example.json から生成する（仕様 §94）。
 */
export function loadConfig(paths: AppPaths): AppConfig {
  mkdirSync(paths.dataDir, { recursive: true });
  if (!existsSync(paths.configFile)) {
    const example = join(paths.rootDir, 'examples', 'config.example.json');
    if (existsSync(example)) {
      copyFileSync(example, paths.configFile);
      console.log(`[config] ${paths.configFile} をサンプル設定から生成しました。イベント名等を編集してください。`);
    }
  }

  let raw: Partial<AppConfig> = {};
  if (existsSync(paths.configFile)) {
    try {
      raw = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Partial<AppConfig>;
    } catch (error) {
      throw new Error(`${paths.configFile} を解析できません: ${(error as Error).message}`);
    }
  }

  const config: AppConfig = {
    event: merge(DEFAULTS.event, raw.event),
    caption: merge(DEFAULTS.caption, raw.caption),
    source: merge(DEFAULTS.source, raw.source),
    server: merge(DEFAULTS.server, raw.server),
    parser: merge(DEFAULTS.parser, raw.parser),
    output: merge(DEFAULTS.output, raw.output),
    sheet: merge(DEFAULTS.sheet, raw.sheet),
    templateDirs: raw.templateDirs ?? [],
    fontDirs: raw.fontDirs ?? [],
  };
  if (process.env.LABEL_PORT) config.server.port = Number(process.env.LABEL_PORT);

  const fromData = (p: string) => (isAbsolute(p) ? p : resolve(paths.dataDir, p));
  config.templateDirs = config.templateDirs.map(fromData);
  config.fontDirs = config.fontDirs.map(fromData);
  if (config.output.directory && !process.env.LABEL_OUTPUT_DIR) {
    paths.outputDir = fromData(config.output.directory);
  }
  return config;
}
