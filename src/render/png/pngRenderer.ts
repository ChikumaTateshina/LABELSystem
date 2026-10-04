import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { lengthToMm, mmToPx } from '../../template.ts';
import type { RenderedCaption } from '../svg/svgRenderer.ts';

export interface PngOptions {
  /** 出力解像度。既定は印刷相当の300dpi。 */
  dpi?: number;
}

/**
 * resvg のWASM本体の入手方法。
 * ソースから起動する場合は node_modules から読み込み、単一exeでは同梱したものを setResvgWasm で渡す。
 */
let wasmSource: () => Uint8Array = () =>
  readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'));
let ready: Promise<void> | null = null;

export function setResvgWasm(wasm: Uint8Array): void {
  wasmSource = () => wasm;
}

const fontBuffers = new Map<string, Uint8Array>();

/** フォントファイルを読み込む。読めないファイルは無視する（その文字は描画されない）。 */
function fontBuffer(path: string): Uint8Array | null {
  let buffer = fontBuffers.get(path);
  if (!buffer) {
    try {
      buffer = readFileSync(path);
    } catch {
      return null;
    }
    fontBuffers.set(path, buffer);
  }
  return buffer;
}

/** レンダリング済みSVGをラスタライズする（仕様 §36）。SVGで使ったフォントファイルのみを読み込む。 */
export async function renderPng(caption: RenderedCaption, options: PngOptions = {}): Promise<Buffer> {
  ready ??= initWasm(wasmSource());
  await ready;

  // 用紙サイズがピクセルで指定されているテンプレートは、その画素数ちょうどで出力する
  const pixels = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(caption.template.width);
  const widthPx = pixels ? Math.round(Number(pixels[1])) : mmToPx(lengthToMm(caption.template.width), options.dpi ?? 300);
  const resvg = new Resvg(caption.svg, {
    fitTo: { mode: 'width', value: widthPx },
    font: {
      loadSystemFonts: false,
      fontBuffers: caption.fonts.map((font) => fontBuffer(font.path)).filter((b): b is Uint8Array => b !== null),
      defaultFontFamily: caption.fonts[0]?.family,
    },
  });
  try {
    return Buffer.from(resvg.render().asPng());
  } finally {
    resvg.free();
  }
}
