import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** template.json の fields.* に書ける設定（仕様 §27, §32）。数値はSVGのviewBox単位。 */
export interface FieldSpec {
  required?: boolean;
  maxLines?: number;
  /** 折り返し幅。省略時はviewBox幅とx座標から推定する。 */
  maxWidth?: number;
  fontFamily?: string;
  fontWeight?: number | 'normal' | 'bold';
  fontSize?: number;
  /** 自動縮小の下限。これより小さくはしない（仕様 §29）。 */
  minFontSize?: number;
  /** 行送り（fontSize に対する倍率） */
  lineHeight?: number;
}

export interface Template {
  id: string;
  name: string;
  version: string;
  width: string;
  height: string;
  /** 使用フォント（先頭が既定フォント） */
  fonts: string[];
  /** 指定フォントが無い環境で試す代替フォント */
  fallbackFonts: string[];
  fields: Record<string, FieldSpec>;
  svg: string;
  /** HTML出力用の任意ファイル。無い場合はSVGを埋め込んだHTMLを出力する。 */
  html: string | null;
  css: string | null;
  dir: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  version: string;
  width: string;
  height: string;
  hasHtml: boolean;
}

export interface TemplateRepository {
  list(): TemplateSummary[];
  get(id: string): Template | null;
}

export class TemplateError extends Error {}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function loadTemplate(dir: string): Template {
  const jsonPath = join(dir, 'template.json');
  const svgPath = join(dir, 'template.svg');
  if (!existsSync(jsonPath) || !existsSync(svgPath)) {
    throw new TemplateError(`${dir} に template.json / template.svg がありません。`);
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new TemplateError(`${jsonPath} を解析できません: ${(error as Error).message}`);
  }
  for (const key of ['id', 'width', 'height']) {
    if (typeof meta[key] !== 'string' || meta[key] === '') {
      throw new TemplateError(`${jsonPath} に "${key}" がありません。`);
    }
  }
  return {
    id: meta.id as string,
    name: (meta.name as string) ?? (meta.id as string),
    version: (meta.version as string) ?? '1.0',
    width: meta.width as string,
    height: meta.height as string,
    fonts: Array.isArray(meta.fonts) ? (meta.fonts as string[]) : [],
    fallbackFonts: Array.isArray(meta.fallbackFonts) ? (meta.fallbackFonts as string[]) : [],
    fields: (meta.fields as Record<string, FieldSpec>) ?? {},
    svg: readFileSync(svgPath, 'utf8'),
    html: readOptional(join(dir, 'template.html')),
    css: readOptional(join(dir, 'template.css')),
    dir,
  };
}

/**
 * 複数ディレクトリからテンプレートを探索する（仕様 §69）。
 * dirs は優先順位の高い順。同じidが複数ある場合は先に見つかったものを使う。
 */
export class FsTemplateRepository implements TemplateRepository {
  constructor(private readonly dirs: string[]) {}

  private loadAll(): Template[] {
    const found = new Map<string, Template>();
    for (const base of this.dirs) {
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base).sort()) {
        const dir = join(base, name);
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'template.json'))) continue;
        try {
          const template = loadTemplate(dir);
          if (!found.has(template.id)) found.set(template.id, template);
        } catch (error) {
          console.warn(`[template] ${(error as Error).message}`);
        }
      }
    }
    return [...found.values()];
  }

  list(): TemplateSummary[] {
    return this.loadAll().map((t) => ({
      id: t.id,
      name: t.name,
      version: t.version,
      width: t.width,
      height: t.height,
      hasHtml: t.html !== null,
    }));
  }

  get(id: string): Template | null {
    return this.loadAll().find((t) => t.id === id) ?? null;
  }
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** {{name}} 形式のテンプレート変数を置換する（仕様 §24）。未定義の変数は空文字になる。 */
export function substituteVariables(
  source: string,
  variables: Record<string, string>,
  escape: (value: string) => string = escapeXml,
): string {
  return source.replace(VARIABLE_PATTERN, (_, name: string) => escape(variables[name] ?? ''));
}

const UNIT_TO_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };

/** "148mm" のような長さをmmへ変換する。単位なしはpxとして扱う。 */
export function lengthToMm(length: string): number {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(mm|cm|in|pt|px)?\s*$/.exec(length);
  if (!m) throw new TemplateError(`長さ "${length}" を解釈できません。`);
  return Number(m[1]) * UNIT_TO_MM[m[2] ?? 'px'];
}

export function mmToPt(mm: number): number {
  return (mm / 25.4) * 72;
}

export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}
