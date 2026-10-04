import type { CaptionModel } from '../types.ts';
import type { Template } from '../template.ts';
import { readFontFile, type FontProvider, type ResolvedFont } from './fonts.ts';
import { renderHtml, type HtmlOptions } from './html/htmlRenderer.ts';
import { renderPdf, type PdfOptions } from './pdf/pdfRenderer.ts';
import { renderPng, setResvgWasm, type PngOptions } from './png/pngRenderer.ts';
import { renderSvg, type RenderOptions, type RenderedCaption } from './svg/svgRenderer.ts';

export * from './fonts.ts';
export * from './textLayout.ts';
export * from './svg/svgRenderer.ts';
export { renderHtml, renderPdf, renderPng, setResvgWasm };

export const OUTPUT_FORMATS = ['svg', 'pdf', 'png', 'html'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * CaptionModel + Template → RenderedCaption（仕様 §34）。
 * SVGをマスターとし、PDF・PNG・HTMLはレンダリング済みキャプションから生成する。
 */
export class CaptionRenderer {
  constructor(
    private readonly fonts: FontProvider,
    private readonly options: { pngDpi?: number } = {},
  ) {}

  render(model: CaptionModel, template: Template, options?: RenderOptions): RenderedCaption {
    return renderSvg(model, template, this.fonts, options);
  }

  /** このPCで利用できるフォントのファミリ名。 */
  fontFamilies(): string[] {
    return this.fonts.families?.() ?? [];
  }

  /** すべての文字を輪郭にしたSVG。フォントが無い環境でも同じ見た目になる。 */
  outlinedSvg(caption: RenderedCaption): string {
    return this.render(caption.model, caption.template, { outlineText: true }).svg;
  }

  /**
   * フォントを内包したHTML。
   * HTMLテンプレートを持つ場合はフォントファイルを @font-face で埋め込み、
   * 持たない場合（SVGを埋め込むHTML）は文字を輪郭にする。
   * notEmbedded には、読み込めず内包できなかったフォントのファミリ名を返す。
   */
  toHtmlEmbedded(captions: RenderedCaption[], options?: HtmlOptions): { html: string; notEmbedded: string[] } {
    if (captions[0]?.template.html === null) {
      const outlined = captions.map((caption) => this.render(caption.model, caption.template, { outlineText: true }));
      return { html: renderHtml(outlined, options), notEmbedded: [] };
    }
    const used = new Map<string, ResolvedFont>();
    for (const caption of captions) for (const font of caption.fonts) used.set(font.family, font);
    const fontFaces: NonNullable<HtmlOptions['fontFaces']> = [];
    const notEmbedded: string[] = [];
    for (const font of used.values()) {
      const file = readFontFile(font);
      if (file) fontFaces.push({ family: font.family, ...file });
      else notEmbedded.push(font.family);
    }
    return { html: renderHtml(captions, { ...options, fontFaces }), notEmbedded };
  }

  toPdf(captions: RenderedCaption[], options?: PdfOptions): Promise<Buffer> {
    return renderPdf(captions, this.fonts, options);
  }

  toPng(caption: RenderedCaption, options?: PngOptions): Promise<Buffer> {
    return renderPng(caption, { dpi: this.options.pngDpi, ...options });
  }

  toHtml(captions: RenderedCaption[], options?: HtmlOptions): string {
    return renderHtml(captions, options);
  }

  /** 単一キャプションを指定形式のファイル内容へ変換する。 */
  async output(caption: RenderedCaption, format: OutputFormat): Promise<Buffer> {
    switch (format) {
      case 'svg':
        return Buffer.from(caption.svg, 'utf8');
      case 'pdf':
        return this.toPdf([caption], { title: caption.model.title });
      case 'png':
        return this.toPng(caption);
      case 'html':
        return Buffer.from(this.toHtml([caption]), 'utf8');
    }
  }
}

export const CONTENT_TYPES: Record<OutputFormat, string> = {
  svg: 'image/svg+xml; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  html: 'text/html; charset=utf-8',
};
