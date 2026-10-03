import { Resvg } from '@resvg/resvg-js';
import { lengthToMm, mmToPx } from '../../template-engine/index.ts';
import type { RenderedCaption } from '../svg/svgRenderer.ts';

export interface PngOptions {
  /** 出力解像度。既定は印刷相当の300dpi。 */
  dpi?: number;
}

/** レンダリング済みSVGをラスタライズする（仕様 §36）。SVGで使ったフォントファイルのみを読み込む。 */
export function renderPng(caption: RenderedCaption, options: PngOptions = {}): Buffer {
  const widthPx = mmToPx(lengthToMm(caption.template.width), options.dpi ?? 300);
  const resvg = new Resvg(caption.svg, {
    fitTo: { mode: 'width', value: widthPx },
    font: {
      loadSystemFonts: false,
      fontFiles: caption.fonts.map((font) => font.path),
      defaultFontFamily: caption.fonts[0]?.family,
    },
  });
  return Buffer.from(resvg.render().asPng());
}
