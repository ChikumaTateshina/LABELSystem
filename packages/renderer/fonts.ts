import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as fontkit from 'fontkit';

/** レンダラーが必要とするフォント機能。テストでは差し替え可能。 */
export interface ResolvedFont {
  family: string;
  path: string;
  postscriptName: string;
  measure(text: string, fontSize: number): number;
  hasGlyph(codePoint: number): boolean;
  /** 文字列をベクターの輪郭へ変換する。代替フォントの文字（絵文字など）の描画に使う。 */
  outline(text: string): OutlinedText;
}

/** フォント単位（y軸は上向き）で表した輪郭。カラー絵文字はレイヤーごとに色を持つ。 */
export interface OutlinedText {
  unitsPerEm: number;
  advance: number;
  paths: { d: string; x: number; y: number; fill: string | null; opacity: number }[];
}

export interface FontProvider {
  /** families を順に探し、最初に見つかったフォントを返す。 */
  resolve(families: string[], weight?: number): ResolvedFont | null;
}

/** 指定フォントが無い場合に試す、日本語を表示できる一般的なフォント。 */
export const DEFAULT_FALLBACK_FONTS = [
  'Noto Sans JP',
  'Noto Sans CJK JP',
  'Source Han Sans',
  'Yu Gothic',
  'Hiragino Sans',
  'BIZ UDGothic',
  'Meiryo',
  'IPAexGothic',
  'MS Gothic',
];

interface FontIndexEntry {
  path: string;
  families: string[];
  postscriptName: string;
  weight: number;
  italic: boolean;
  /** 可変フォント。PDF/PNG生成では既定インスタンスしか使えない。 */
  variable: boolean;
}

/** 可変フォントを採用する条件: 既定インスタンスのウェイトが要求からこの範囲内であること */
const VARIABLE_FONT_WEIGHT_TOLERANCE = 150;

interface FontIndexFile {
  version: 2;
  files: Record<string, { size: number; mtimeMs: number; fonts: FontIndexEntry[] }>;
}

const FONT_EXTENSIONS = /\.(ttf|otf|ttc|otc)$/i;

export function systemFontDirs(): string[] {
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return [
        join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'),
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts'),
      ];
    case 'darwin':
      return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')];
    default:
      return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.fonts'), join(home, '.local/share/fonts')];
  }
}

function normalizeFamily(name: string): string {
  return name.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '').toLowerCase();
}

function listFontFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) listFontFiles(path, out);
    else if (FONT_EXTENSIONS.test(name)) out.push(path);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFont = any;

function describeFont(path: string, font: AnyFont): FontIndexEntry | null {
  if (!font?.postscriptName) return null;
  const families = new Set<string>();
  const records = font.name?.records ?? {};
  for (const key of ['fontFamily', 'preferredFamily']) {
    for (const value of Object.values(records[key] ?? {})) {
      if (typeof value === 'string' && value) families.add(value);
    }
  }
  if (font.familyName) families.add(font.familyName);
  return {
    path,
    families: [...families],
    postscriptName: String(font.postscriptName),
    weight: Number(font['OS/2']?.usWeightClass ?? 400),
    italic: Number(font.italicAngle ?? 0) !== 0,
    variable: Boolean(font.fvar),
  };
}

interface OutlinePoint {
  onCurve: boolean;
  x: number;
  y: number;
}

function num(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** TrueTypeの輪郭（2次ベジェ。制御点が連続する場合は中点を補う）をSVGパスへ変換する。 */
function contourToPath(points: OutlinePoint[]): string {
  if (points.length === 0) return '';
  const mid = (a: OutlinePoint, b: OutlinePoint): OutlinePoint => ({
    onCurve: true,
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const first = points.findIndex((point) => point.onCurve);
  const start = first >= 0 ? points[first] : mid(points[points.length - 1], points[0]);
  const rest = first >= 0 ? [...points.slice(first + 1), ...points.slice(0, first + 1)] : [...points, start];

  let d = `M${num(start.x)} ${num(start.y)}`;
  let control: OutlinePoint | null = null;
  for (const point of rest) {
    if (point.onCurve) {
      d += control
        ? `Q${num(control.x)} ${num(control.y)} ${num(point.x)} ${num(point.y)}`
        : `L${num(point.x)} ${num(point.y)}`;
      control = null;
    } else {
      if (control) {
        const m = mid(control, point);
        d += `Q${num(control.x)} ${num(control.y)} ${num(m.x)} ${num(m.y)}`;
      }
      control = point;
    }
  }
  return d + 'Z';
}

/**
 * グリフの輪郭をSVGパスとして取り出す。
 *
 * TrueTypeフォントでは fontkit の glyph.path を使わず、ここで合成グリフを展開する。理由は2つ:
 * - カラー絵文字フォントでは、合成グリフの部品がカラーグリフとして返され輪郭を取得できない
 * - 合成グリフの2x2変換（回転）の適用が TrueType の仕様と異なり、回転した部品の位置がずれる
 */
class GlyphOutliner {
  /** カラーグリフと共有しないための、素のグリフ専用キャッシュ */
  private readonly baseGlyphs = {};
  private readonly paths = new Map<number, string>();

  constructor(private readonly font: AnyFont) {}

  private contours(id: number, depth = 0): OutlinePoint[][] {
    const data = this.font._getBaseGlyph(id)?._decode?.();
    if (!data || depth > 8) return [];
    if (data.numberOfContours >= 0) {
      const result: OutlinePoint[][] = [];
      let current: OutlinePoint[] = [];
      for (const point of data.points ?? []) {
        current.push(point);
        if (point.endContour) {
          result.push(current);
          current = [];
        }
      }
      return result;
    }
    return (data.components ?? []).flatMap((c: AnyFont) =>
      this.contours(c.glyphID, depth + 1).map((contour) =>
        contour.map((point) => ({
          onCurve: point.onCurve,
          x: point.x * c.scaleX + point.y * c.scale10 + c.dx,
          y: point.x * c.scale01 + point.y * c.scaleY + c.dy,
        })),
      ),
    );
  }

  path(glyph: AnyFont): string {
    const cached = this.paths.get(glyph.id);
    if (cached !== undefined) return cached;
    let d = '';
    const shared = this.font._glyphs;
    this.font._glyphs = this.baseGlyphs;
    try {
      const base = this.font._getBaseGlyph(glyph.id);
      d =
        typeof base?._decode === 'function'
          ? this.contours(glyph.id).map(contourToPath).join('')
          : String(base?.path.toSVG() ?? '');
    } catch {
      d = '';
    } finally {
      this.font._glyphs = shared;
    }
    this.paths.set(glyph.id, d);
    return d;
  }
}

function openFonts(path: string): AnyFont[] {
  const opened: AnyFont = fontkit.openSync(path);
  return Array.isArray(opened.fonts) ? opened.fonts : [opened];
}

/**
 * ローカルにインストールされたフォントを探索する。
 * 走査結果は cacheFile に保存し、2回目以降は変更のあったファイルのみ読み直す。
 */
export class FontRegistry implements FontProvider {
  private index: FontIndexEntry[] | null = null;
  private readonly loaded = new Map<string, ResolvedFont>();

  constructor(
    private readonly dirs: string[] = systemFontDirs(),
    private readonly cacheFile?: string,
  ) {}

  private buildIndex(): FontIndexEntry[] {
    let cache: FontIndexFile = { version: 2, files: {} };
    if (this.cacheFile && existsSync(this.cacheFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as FontIndexFile;
        if (parsed.version === 2) cache = parsed;
      } catch {
        // 壊れたキャッシュは作り直す
      }
    }

    const next: FontIndexFile = { version: 2, files: {} };
    let changed = false;
    for (const path of this.dirs.flatMap((dir) => listFontFiles(dir))) {
      const stat = statSync(path);
      const cached = cache.files[path];
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        next.files[path] = cached;
        continue;
      }
      changed = true;
      let fonts: FontIndexEntry[] = [];
      try {
        fonts = openFonts(path)
          .map((font) => describeFont(path, font))
          .filter((entry): entry is FontIndexEntry => entry !== null);
      } catch {
        // 読めないフォントは無視する
      }
      next.files[path] = { size: stat.size, mtimeMs: stat.mtimeMs, fonts };
    }
    if (Object.keys(cache.files).length !== Object.keys(next.files).length) changed = true;

    if (this.cacheFile && changed) {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(next));
    }
    // dirs の指定順（＝優先順）を保つ
    return Object.values(next.files).flatMap((file) => file.fonts);
  }

  private load(entry: FontIndexEntry): ResolvedFont | null {
    const key = `${entry.path}#${entry.postscriptName}`;
    const hit = this.loaded.get(key);
    if (hit) return hit;
    try {
      const font = openFonts(entry.path).find((f) => f.postscriptName === entry.postscriptName);
      if (!font) return null;
      const widths = new Map<string, number>();
      const outliner = new GlyphOutliner(font);
      const resolved: ResolvedFont = {
        family: font.familyName ?? entry.families[0],
        path: entry.path,
        postscriptName: entry.postscriptName,
        measure(text, fontSize) {
          let units = widths.get(text);
          if (units === undefined) {
            units = (font.layout(text).advanceWidth as number) / (font.unitsPerEm as number);
            if (widths.size > 5000) widths.clear();
            widths.set(text, units);
          }
          return units * fontSize;
        },
        hasGlyph: (codePoint) => Boolean(font.hasGlyphForCodePoint(codePoint)),
        outline(text) {
          const run = font.layout(text);
          const paths: OutlinedText['paths'] = [];
          let pen = 0;
          run.glyphs.forEach((glyph: AnyFont, i: number) => {
            const position = run.positions[i];
            const x = pen + (position.xOffset ?? 0);
            const y = position.yOffset ?? 0;
            // カラー絵文字（COLR）は色付きレイヤーの重ね合わせ。色指定の無いレイヤーは文字色で塗る
            const layers: { glyph: AnyFont; color?: AnyFont }[] = glyph.layers?.length ? glyph.layers : [{ glyph }];
            for (const layer of layers) {
              const d = outliner.path(layer.glyph);
              if (!d) continue;
              const color = layer.color;
              paths.push({
                d,
                x,
                y,
                fill: color ? `rgb(${color.red},${color.green},${color.blue})` : null,
                opacity: color ? Number(color.alpha ?? 255) / 255 : 1,
              });
            }
            pen += position.xAdvance;
          });
          return { unitsPerEm: font.unitsPerEm as number, advance: pen, paths };
        },
      };
      this.loaded.set(key, resolved);
      return resolved;
    } catch {
      return null;
    }
  }

  resolve(families: string[], weight = 400): ResolvedFont | null {
    this.index ??= this.buildIndex();
    for (const family of families) {
      const wanted = normalizeFamily(family);
      if (!wanted) continue;
      const candidates = this.index
        .filter((entry) => entry.families.some((name) => normalizeFamily(name) === wanted))
        .filter((entry) => !entry.variable || Math.abs(entry.weight - weight) <= VARIABLE_FONT_WEIGHT_TOLERANCE)
        .sort(
          (a, b) =>
            Number(a.italic) - Number(b.italic) || Math.abs(a.weight - weight) - Math.abs(b.weight - weight),
        );
      for (const candidate of candidates) {
        const font = this.load(candidate);
        if (!font) continue;
        // SVGへ書き出すファミリ名は、OS・ブラウザ・resvgが共通で解決できる「一致した名前」を使う
        const matched = candidate.families.find((name) => normalizeFamily(name) === wanted) ?? font.family;
        return { ...font, family: matched };
      }
    }
    return null;
  }
}

/** CSSの font-family 値を個々のファミリ名へ分割する。 */
export function splitFontFamily(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter((name) => name && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(name));
}

export function weightToNumber(weight: number | string | undefined): number {
  if (typeof weight === 'number') return weight;
  if (weight === 'bold') return 700;
  const n = Number(weight);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

/** 絵文字・記号・他言語の文字を表示するために試すフォント。PDFへ埋め込めるよう、輪郭を持つフォントを優先する。 */
export const SYMBOL_FALLBACK_FONTS = [
  'Noto Emoji',
  'Segoe UI Emoji',
  'Segoe UI Symbol',
  'Noto Sans Symbols 2',
  'Noto Sans Symbols',
  'Apple Symbols',
  'Noto Sans KR',
  'Malgun Gothic',
  'Noto Sans SC',
  'Microsoft YaHei',
  'Noto Sans',
  'Arial Unicode MS',
];

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** 書記素クラスタ（見た目上の1文字）へ分割する。結合絵文字や濁点付き文字を途中で切らないために使う。 */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** 字形を持たない制御用コードポイント（ZWJ・異体字セレクタ・タグ文字） */
function isInvisible(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function covers(font: ResolvedFont, cluster: string): boolean {
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (isInvisible(cp) || /\s/u.test(ch)) continue;
    if (!font.hasGlyph(cp)) return false;
  }
  return true;
}

const EMOJI_LIKE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export interface TextRun {
  text: string;
  font: ResolvedFont;
}

/**
 * 主フォントに無い文字（絵文字・機種依存文字・他言語の文字）を、代替フォントで補うための仕組み。
 * 文字ごとに「その文字を収録している最初のフォント」を選び、同じフォントが続く範囲を1つのrunにまとめる。
 */
export class FontStack {
  private readonly resolved = new Map<string, ResolvedFont | null>();
  private readonly choice = new Map<string, ResolvedFont | null>();
  /** 実際に使用した代替フォント */
  readonly used = new Map<string, ResolvedFont>();

  constructor(
    readonly primary: ResolvedFont,
    private readonly provider: FontProvider,
    private readonly textFallbacks: string[],
    private readonly symbolFallbacks: string[] = SYMBOL_FALLBACK_FONTS,
  ) {}

  private resolveFamily(family: string): ResolvedFont | null {
    if (!this.resolved.has(family)) this.resolved.set(family, this.provider.resolve([family], 400));
    return this.resolved.get(family) ?? null;
  }

  /** cluster を表示できるフォント。どのフォントにも無ければ null。 */
  fontFor(cluster: string): ResolvedFont | null {
    if (covers(this.primary, cluster)) return this.primary;
    if (this.choice.has(cluster)) return this.choice.get(cluster) ?? null;
    // 絵文字は記号用フォントを先に、それ以外の文字は本文用フォントを先に探す
    const order = EMOJI_LIKE.test(cluster)
      ? [...this.symbolFallbacks, ...this.textFallbacks]
      : [...this.textFallbacks, ...this.symbolFallbacks];
    let found: ResolvedFont | null = null;
    for (const family of order) {
      const font = this.resolveFamily(family);
      if (font && covers(font, cluster)) {
        found = font;
        this.used.set(`${font.path}#${font.postscriptName}`, font);
        break;
      }
    }
    this.choice.set(cluster, found);
    return found;
  }

  runs(text: string): TextRun[] {
    const runs: TextRun[] = [];
    for (const cluster of graphemes(text)) {
      const font = this.fontFor(cluster) ?? this.primary;
      const last = runs[runs.length - 1];
      if (last && last.font === font) last.text += cluster;
      else runs.push({ text: cluster, font });
    }
    return runs;
  }

  measure(text: string, fontSize: number): number {
    if (covers(this.primary, text)) return this.primary.measure(text, fontSize);
    return this.runs(text).reduce((sum, run) => sum + run.font.measure(run.text, fontSize), 0);
  }

  /** 代替フォントで表示する文字と、どのフォントでも表示できない文字を返す。 */
  inspect(text: string): { substituted: Map<string, string[]>; missing: string[] } {
    const substituted = new Map<string, string[]>();
    const missing = new Set<string>();
    for (const cluster of new Set(graphemes(text))) {
      if (cluster.trim() === '') continue;
      const font = this.fontFor(cluster);
      if (font === null) missing.add(cluster);
      else if (font !== this.primary) substituted.set(font.family, [...(substituted.get(font.family) ?? []), cluster]);
    }
    return { substituted, missing: [...missing] };
  }
}
