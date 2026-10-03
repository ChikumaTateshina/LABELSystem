import { escapeXml, substituteVariables } from '../../template-engine/index.ts';
import type { RenderedCaption } from '../svg/svgRenderer.ts';

export interface HtmlOptions {
  title?: string;
  lang?: string;
}

function baseCss(width: string, height: string): string {
  return `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8mm;
  padding: 8mm;
  background: #e8e8e4;
}
.caption {
  flex: none;
  position: relative;
  width: var(--caption-width);
  height: var(--caption-height);
  overflow: hidden;
  background: #fff;
}
.caption--svg > svg { display: block; width: 100%; height: 100%; }
@page { size: ${width} ${height}; margin: 0; }
@media print {
  body { display: block; padding: 0; background: none; }
  .caption { break-after: page; break-inside: avoid; }
}`;
}

/** <style> 内に書いても要素が閉じられないようにする。 */
function safeCss(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

function fieldVariables(caption: RenderedCaption): string {
  const lines = [
    `--caption-width: ${caption.template.width};`,
    `--caption-height: ${caption.template.height};`,
  ];
  for (const [name, spec] of Object.entries(caption.template.fields)) {
    if (spec.maxLines) lines.push(`--${name.replace(/_/g, '-')}-max-lines: ${spec.maxLines};`);
  }
  return `:root {\n  ${lines.join('\n  ')}\n}`;
}

function captionBody(caption: RenderedCaption): string {
  const number = escapeXml(caption.model.entry_number);
  if (caption.template.html !== null) {
    const body = substituteVariables(
      caption.template.html.replace(/<!--[\s\S]*?-->/g, ''),
      caption.model as unknown as Record<string, string>,
      escapeXml,
    );
    return `<article class="caption" data-entry-number="${number}">\n${body.trim()}\n</article>`;
  }
  // HTMLテンプレートを持たないテンプレートは、レイアウト済みSVGをそのまま埋め込む
  const svg = caption.svg.replace(/^\s*<\?xml[^>]*\?>\s*/, '').replace(/<!DOCTYPE[^>]*>\s*/i, '');
  return `<article class="caption caption--svg" data-entry-number="${number}">\n${svg.trim()}\n</article>`;
}

/**
 * CSSを内包した単一ファイルのHTMLを生成する。
 * テンプレートに template.html / template.css があればそれを使い、
 * 文字はHTMLのテキストとして出力する（選択・コピー・読み上げが可能）。
 * 複数キャプションを渡すと1つのHTMLへまとめる。
 */
export function renderHtml(captions: RenderedCaption[], options: HtmlOptions = {}): string {
  if (captions.length === 0) throw new Error('HTML出力には1件以上のキャプションが必要です。');
  const first = captions[0];
  const title = options.title ?? (first.model.title || 'Caption');
  const templateCss = first.template.html !== null ? (first.template.css ?? '') : '';
  const style = [baseCss(first.template.width, first.template.height), fieldVariables(first), templateCss]
    .filter(Boolean)
    .join('\n\n');

  return `<!DOCTYPE html>
<html lang="${escapeXml(options.lang ?? 'ja')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="LABELSystem">
<title>${escapeXml(title)}</title>
<style>
${safeCss(style)}
</style>
</head>
<body>
${captions.map(captionBody).join('\n')}
</body>
</html>
`;
}
