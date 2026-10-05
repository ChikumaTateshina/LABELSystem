import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { lengthToMm, mmToPt } from '../../template.ts';
import { DEFAULT_FALLBACK_FONTS, splitFontFamily, type FontProvider } from '../fonts.ts';
import type { RenderedCaption } from '../svg/svgRenderer.ts';

export interface PdfOptions {
  title?: string;
}

/**
 * レンダリング済みSVGからPDFを生成する（仕様 §36, §37）。
 * 1キャプション = 1ページ。ページサイズはテンプレートの実寸、フォントは埋め込む。
 */
export function renderPdf(
  captions: RenderedCaption[],
  fontProvider: FontProvider,
  options: PdfOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: { Title: options.title ?? 'Caption', Creator: 'LABELSystem' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const registered = new Map<string, string>();
    const fontCallback = (family: string, bold: boolean): string => {
      const weight = bold ? 700 : 400;
      const font =
        fontProvider.resolve(splitFontFamily(family ?? ''), weight) ??
        fontProvider.resolve(DEFAULT_FALLBACK_FONTS, weight);
      if (!font) return bold ? 'Helvetica-Bold' : 'Helvetica';
      const key = `${font.path}#${font.postscriptName}`;
      let alias = registered.get(key);
      if (!alias) {
        alias = `label-font-${registered.size}`;
        // フォントコレクション（.ttc/.otc）の場合のみ、収録フォントをPostScript名で指定する
        if (/\.(ttc|otc)$/i.test(font.path)) doc.registerFont(alias, font.path, font.postscriptName);
        else doc.registerFont(alias, font.path);
        registered.set(key, alias);
      }
      return alias;
    };

    try {
      for (const caption of captions) {
        const width = mmToPt(lengthToMm(caption.template.width));
        const height = mmToPt(lengthToMm(caption.template.height));
        doc.addPage({ size: [width, height], margin: 0 });
        SVGtoPDF(doc, inlineSvgImages(caption.svg), 0, 0, {
          width,
          height,
          preserveAspectRatio: 'xMidYMid meet',
          fontCallback,
        });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** SVG画像を入れ子のSVGに展開し、PDFのベクター描画へ渡す。 */
export function inlineSvgImages(svg: string): string {
  return svg.replace(/<image\b([^>]*)(?:\/>|>\s*<\/image>)/g, (whole, attributes: string) => {
    const href = /(?:^|\s)(?:xlink:)?href\s*=\s*(["'])(.*?)\1/.exec(attributes);
    if (!href || !/^data:image\/svg\+xml[;,]/i.test(href[2])) return whole;
    const comma = href[2].indexOf(',');
    const source = /;base64/i.test(href[2].slice(0, comma))
      ? Buffer.from(href[2].slice(comma + 1), 'base64').toString('utf8')
      : decodeURIComponent(href[2].slice(comma + 1));
    const root = /<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(source);
    if (!root) throw new Error('埋め込みSVG画像を解析できませんでした。');
    // 外側のimageの位置と大きさを保ち、元SVGのviewBox・定義・図形を保持する。
    const placement = attributes.replace(href[0], '').replace(/\/\s*$/, '');
    const inner = root[1].replace(/\s(?:x|y|width|height|preserveAspectRatio)\s*=\s*(["']).*?\1/g, '');
    return `<svg ${inner} ${placement}>${inlineSvgImages(root[2])}</svg>`;
  });
}
