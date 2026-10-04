import type { CaptionModel } from '../../types.ts';
import { escapeXml, substituteVariables, type FieldSpec, type Template } from '../../template.ts';
import {
  DEFAULT_FALLBACK_FONTS,
  FontStack,
  graphemes,
  splitFontFamily,
  weightToNumber,
  type FontProvider,
  type ResolvedFont,
} from '../fonts.ts';
import { fitText, type Measure } from '../textLayout.ts';

export type WarningCode =
  | 'overflow'
  | 'shrunk'
  | 'required-empty'
  | 'font-missing'
  | 'glyph-fallback'
  | 'glyph-missing';

export interface RenderWarning {
  code: WarningCode;
  /** info は通知のみ。warning は人間による確認・修正が必要。 */
  level: 'info' | 'warning';
  field?: string;
  message: string;
}

export interface RenderedCaption {
  model: CaptionModel;
  template: Template;
  svg: string;
  warnings: RenderWarning[];
  /** このSVGの描画に必要なフォント（PDF埋め込み・PNG生成で使用） */
  fonts: ResolvedFont[];
}

const TEXT_FIELD_PATTERN = /<text\b([^>]*)>\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*<\/text>/g;
const ATTRIBUTE_PATTERN = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DEFAULT_FONT_SIZE = 40;
const DEFAULT_LINE_HEIGHT = 1.5;
const DEFAULT_MIN_FONT_RATIO = 0.8;
/** 文字の見た目の中心が、ベースラインからどれだけ上にあるか（文字サイズに対する比） */
const EM_CENTER = 0.38;

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(ATTRIBUTE_PATTERN)) attrs.set(m[1], m[2] ?? m[3] ?? '');
  return attrs;
}

function serializeAttributes(attrs: Map<string, string>): string {
  return [...attrs].map(([name, value]) => `${name}="${escapeXml(value).replace(/&#39;/g, "'")}"`).join(' ');
}

function viewBoxWidth(svg: string): number | null {
  const m = /<svg\b[^>]*\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+/.exec(svg);
  return m ? Number(m[1]) : null;
}

function defaultMaxWidth(x: number, anchor: string, totalWidth: number | null): number {
  if (totalWidth === null) return Number.POSITIVE_INFINITY;
  const width =
    anchor === 'middle' ? 2 * Math.min(x, totalWidth - x) : anchor === 'end' ? 2 * x - totalWidth : totalWidth - 2 * x;
  return width > 0 ? width : totalWidth;
}

/** フォントが1つも見つからない環境向けの概算。全角1em・半角0.55emとして見積もる。 */
const estimateWidth: Measure = (text, fontSize) =>
  Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) < 0x2000 ? 0.55 : 1), 0) * fontSize;

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * CaptionModel をSVGテンプレートへ差し込む。
 * `<text ...>{{field}}</text>` の形で書かれた要素は、template.json の設定に従って
 * 行分割（tspan化）・文字サイズ調整を行う。それ以外の場所の {{変数}} は単純置換する。
 */
export interface RenderOptions {
  /**
   * すべての文字を輪郭（ベクター図形）として描く。
   * フォントが入っていない環境でも同じ見た目になる（SVG出力へフォントを「埋め込む」用途）。
   */
  outlineText?: boolean;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 文字列を輪郭として描く。幅（字間を含む）も返す。 */
function outlineRun(
  font: ResolvedFont,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fill: string,
  letterSpacing: number,
): string {
  const outlined = font.outline(text);
  const scale = fontSize / outlined.unitsPerEm;
  const paths = outlined.paths.map((path) => {
    const px = path.x + (path.glyph * letterSpacing) / scale;
    const paint = (path.fill ? ` fill="${path.fill}"` : '') + (path.opacity < 1 ? ` fill-opacity="${fmt(path.opacity)}"` : '');
    const move = px || path.y ? ` transform="translate(${fmt(px)} ${fmt(path.y)})"` : '';
    return `<path${move}${paint} d="${path.d}"/>`;
  });
  return (
    `<g fill="${escapeXml(fill)}" transform="translate(${fmt(x)} ${fmt(y)}) scale(${scale} ${-scale})">` +
    `<title>${escapeXml(text)}</title>${paths.join('')}</g>`
  );
}

export function renderSvg(
  model: CaptionModel,
  template: Template,
  fontProvider: FontProvider,
  options: RenderOptions = {},
): RenderedCaption {
  const warnings: RenderWarning[] = [];
  const usedFonts = new Map<string, ResolvedFont>();
  const variables = model as unknown as Record<string, string>;
  const totalWidth = viewBoxWidth(template.svg);
  const fallbacks = [...template.fallbackFonts, ...DEFAULT_FALLBACK_FONTS];
  const reportedMissingFonts = new Set<string>();

  const resolveFont = (families: string[], weight: number): ResolvedFont | null => {
    let font = fontProvider.resolve(families, weight);
    if (!font) {
      font = fontProvider.resolve(fallbacks, weight);
      const requested = families.join(', ') || '(未指定)';
      if (!reportedMissingFonts.has(requested)) {
        reportedMissingFonts.add(requested);
        warnings.push({
          code: 'font-missing',
          level: 'warning',
          message: font
            ? `フォント「${requested}」を利用できません（未導入、またはウェイトの合わない可変フォントのみ）。「${font.family}」で代替しました。`
            : `フォント「${requested}」も代替フォントも見つかりません。文字幅は概算です。`,
        });
      }
    }
    if (font) usedFonts.set(`${font.path}#${font.postscriptName}`, font);
    return font;
  };

  for (const [name, spec] of Object.entries(template.fields)) {
    if (spec.required && !(variables[name] ?? '').trim()) {
      warnings.push({ code: 'required-empty', level: 'warning', field: name, message: `必須項目「${name}」が空です。` });
    }
  }

  let svg = template.svg.replace(TEXT_FIELD_PATTERN, (_whole, rawAttrs: string, name: string) => {
    const spec: FieldSpec = template.fields[name] ?? {};
    const attrs = parseAttributes(rawAttrs);
    const value = variables[name] ?? '';

    const x = Number(attrs.get('x') ?? 0) || 0;
    const fontSize = spec.fontSize ?? (Number.parseFloat(attrs.get('font-size') ?? '') || DEFAULT_FONT_SIZE);
    const weight = weightToNumber(spec.fontWeight ?? attrs.get('font-weight'));
    // 項目やSVG要素に指定が無ければ、テンプレートの fonts を先頭から順に試す
    const families = spec.fontFamily
      ? splitFontFamily(spec.fontFamily)
      : attrs.has('font-family')
        ? splitFontFamily(attrs.get('font-family')!)
        : template.fonts;
    const font = resolveFont(families, weight);
    // 主フォントに無い文字（絵文字・機種依存文字など）は、収録している代替フォントで補う
    const stack = font ? new FontStack(font, fontProvider, fallbacks) : null;
    const measure: Measure = stack ? (text, size) => stack.measure(text, size) : estimateWidth;

    const fit = fitText(
      value,
      {
        maxWidth: spec.maxWidth ?? defaultMaxWidth(x, attrs.get('text-anchor') ?? 'start', totalWidth),
        maxLines: spec.maxLines ?? 1,
        fontSize,
        minFontSize: spec.minFontSize ?? fontSize * DEFAULT_MIN_FONT_RATIO,
      },
      measure,
    );

    if (fit.overflow) {
      warnings.push({
        code: 'overflow',
        level: 'warning',
        field: name,
        message: `「${name}」が表示領域に収まりません（${fit.lines.length}行 / 最大${spec.maxLines ?? 1}行）。文章を修正してください。`,
      });
    } else if (fit.shrunk) {
      warnings.push({
        code: 'shrunk',
        level: 'info',
        field: name,
        message: `「${name}」の文字サイズを ${fmt(fontSize)} → ${fmt(fit.fontSize)} に縮小しました。`,
      });
    }
    if (stack) {
      const { substituted, missing } = stack.inspect(value);
      for (const [family, chars] of substituted) {
        warnings.push({
          code: 'glyph-fallback',
          level: 'info',
          field: name,
          message: `「${name}」の ${chars.join(' ')} は「${family}」の字形で表示します。`,
        });
      }
      if (missing.length > 0) {
        warnings.push({
          code: 'glyph-missing',
          level: 'warning',
          field: name,
          message: `「${name}」に、利用できるどのフォントでも表示できない文字があります: ${missing.join(' ')}`,
        });
      }
    }

    attrs.set('font-size', fmt(fit.fontSize));
    if (font) attrs.set('font-family', `${font.family}, sans-serif`);
    else if (families.length > 0) attrs.set('font-family', families.join(', '));
    if (spec.fontWeight !== undefined) attrs.set('font-weight', String(spec.fontWeight));

    const lineAdvance = fit.fontSize * (spec.lineHeight ?? DEFAULT_LINE_HEIGHT);
    // 上下方向の揃え: 枠は「基準の文字サイズで最大行数ぶん」。実際の行数が少ない分だけ、1行目を下へずらす
    let shift = 0;
    const maxLines = spec.maxLines ?? 1;
    if ((spec.valign === 'middle' || spec.valign === 'bottom') && fit.lines.length <= maxLines) {
      const room = (maxLines - 1) * fontSize * (spec.lineHeight ?? DEFAULT_LINE_HEIGHT) - (fit.lines.length - 1) * lineAdvance;
      // 中央揃えでは、文字を縮小した分だけ文字の中心（ベースラインの少し上）がずれるのを補う
      shift = spec.valign === 'bottom' ? room : room / 2 - EM_CENTER * (fontSize - fit.fontSize);
    }
    const lineRuns = fit.lines.map((line) => (stack && line !== '' ? stack.runs(line) : null));
    const mixed = options.outlineText || lineRuns.some((runs) => runs?.some((run) => run.font !== stack!.primary));

    if (!stack || !mixed) {
      // 空行はtspanを出力せず、次の行のdyへ行送りを積み増す（空のtspanのdyは無視されるため）
      const tspans: string[] = [];
      let pendingAdvance = shift;
      for (const line of fit.lines) {
        if (line !== '') {
          tspans.push(`<tspan x="${fmt(x)}" dy="${fmt(pendingAdvance)}">${escapeXml(line)}</tspan>`);
          pendingAdvance = 0;
        }
        pendingAdvance += lineAdvance;
      }
      return `<text ${serializeAttributes(attrs)}>${tspans.join('')}</text>`;
    }

    // 代替フォントの文字を含む場合は、各runの位置を計算して絶対座標で配置する。
    // 主フォントの文字は通常のテキスト、代替フォントの文字（絵文字など）は輪郭として描く。
    const anchor = attrs.get('text-anchor') ?? 'start';
    const baseY = (Number(attrs.get('y') ?? 0) || 0) + shift;
    const fill = attrs.get('fill') ?? '#000000';
    const letterSpacing = Number.parseFloat(attrs.get('letter-spacing') ?? '') || 0;
    attrs.set('text-anchor', 'start');
    const tspans: string[] = [];
    const outlines: string[] = [];
    let previousTextLine = 0;
    lineRuns.forEach((runs, lineIndex) => {
      if (!runs) return;
      const widths = runs.map(
        (run) => run.font.measure(run.text, fit.fontSize) + letterSpacing * graphemes(run.text).length,
      );
      const total = widths.reduce((sum, w) => sum + w, 0);
      let cursor = anchor === 'middle' ? x - total / 2 : anchor === 'end' ? x - total : x;
      const lineY = baseY + lineIndex * lineAdvance;
      runs.forEach((run, runIndex) => {
        if (run.font === stack.primary && !options.outlineText) {
          const dy = (lineIndex - previousTextLine) * lineAdvance + (tspans.length === 0 ? shift : 0);
          previousTextLine = lineIndex;
          tspans.push(`<tspan x="${fmt(cursor)}" dy="${fmt(dy)}">${escapeXml(run.text)}</tspan>`);
        } else {
          outlines.push(outlineRun(run.font, run.text, cursor, lineY, fit.fontSize, fill, letterSpacing));
        }
        cursor += widths[runIndex];
      });
    });
    return (
      (tspans.length > 0 ? `<text ${serializeAttributes(attrs)}>${tspans.join('')}</text>` : '') +
      `<g data-field="${escapeXml(name)}" data-glyph-outlines="true">${outlines.join('')}</g>`
    );
  });

  svg = substituteVariables(svg, variables, escapeXml);

  // 固定の文字（変数ではない <text>）も輪郭にする
  if (options.outlineText) {
    svg = svg.replace(/<text\b([^>]*)>([^<]+)<\/text>/g, (whole, rawAttrs: string, content: string) => {
      const attrs = parseAttributes(rawAttrs);
      const text = unescapeXml(content).trim();
      const families = attrs.has('font-family') ? splitFontFamily(attrs.get('font-family')!) : template.fonts;
      const font = resolveFont(families, weightToNumber(attrs.get('font-weight')));
      if (!font || text === '') return whole;
      const stack = new FontStack(font, fontProvider, fallbacks);
      const fontSize = Number.parseFloat(attrs.get('font-size') ?? '') || DEFAULT_FONT_SIZE;
      const letterSpacing = Number.parseFloat(attrs.get('letter-spacing') ?? '') || 0;
      const runs = stack.runs(text);
      const widths = runs.map((run) => run.font.measure(run.text, fontSize) + letterSpacing * graphemes(run.text).length);
      const total = widths.reduce((sum, w) => sum + w, 0);
      const x = Number(attrs.get('x') ?? 0) || 0;
      const anchor = attrs.get('text-anchor') ?? 'start';
      let cursor = anchor === 'middle' ? x - total / 2 : anchor === 'end' ? x - total : x;
      const y = Number(attrs.get('y') ?? 0) || 0;
      const fill = attrs.get('fill') ?? '#000000';
      const parts = runs.map((run, index) => {
        const markup = outlineRun(run.font, run.text, cursor, y, fontSize, fill, letterSpacing);
        cursor += widths[index];
        return markup;
      });
      return `<g data-glyph-outlines="true">${parts.join('')}</g>`;
    });
  }

  // テンプレート内の固定文字列が使うフォントも、PDF埋め込み・PNG生成用に解決しておく
  for (const m of svg.matchAll(/font-family\s*=\s*"([^"]*)"/g)) {
    const families = splitFontFamily(m[1].replace(/&#39;|&quot;/g, ''));
    if (families.length > 0) resolveFont(families, 400);
  }

  return { model, template, svg, warnings, fonts: [...usedFonts.values()] };
}
