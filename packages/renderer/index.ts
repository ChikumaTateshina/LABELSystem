import type { CaptionModel } from '../shared-types/index.ts';
import type { Template } from '../template-engine/index.ts';
import type { FontProvider } from './fonts.ts';
import { renderHtml, type HtmlOptions } from './html/htmlRenderer.ts';
import { renderPdf, type PdfOptions } from './pdf/pdfRenderer.ts';
import { renderPng, type PngOptions } from './png/pngRenderer.ts';
import { renderSvg, type RenderedCaption } from './svg/svgRenderer.ts';

export * from './fonts.ts';
export * from './textLayout.ts';
export * from './svg/svgRenderer.ts';
export { renderHtml, renderPdf, renderPng };

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

  render(model: CaptionModel, template: Template): RenderedCaption {
    return renderSvg(model, template, this.fonts);
  }

  toPdf(captions: RenderedCaption[], options?: PdfOptions): Promise<Buffer> {
    return renderPdf(captions, this.fonts, options);
  }

  toPng(caption: RenderedCaption, options?: PngOptions): Buffer {
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
