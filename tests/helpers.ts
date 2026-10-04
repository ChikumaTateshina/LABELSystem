import type { FontProvider, ResolvedFont } from '../src/render/index.ts';

/** テスト用の固定幅フォント: 全角 1em / 半角 0.5em。U+1F000以降（絵文字）は収録していない扱い。 */
export function fakeFont(family: string): ResolvedFont {
  return {
    family,
    path: `/fonts/${family}.otf`,
    postscriptName: family.replace(/\s+/g, ''),
    measure: (text, fontSize) =>
      Array.from(text).reduce((sum, ch) => sum + (ch.codePointAt(0)! < 0x2000 ? 0.5 : 1), 0) * fontSize,
    // 名前に Emoji を含むフォントは絵文字だけを、それ以外は絵文字以外を収録している扱い
    hasGlyph: (codePoint) => (family.includes('Emoji') ? codePoint >= 0x1f000 : codePoint < 0x1f000),
    // 1文字 = 1000単位の正方形として輪郭化する
    outline: (text) => {
      const count = Array.from(new Intl.Segmenter('ja').segment(text)).length;
      return {
        unitsPerEm: 1000,
        advance: count * 1000,
        paths: Array.from({ length: count }, (_, i) => ({
          d: 'M0 0H1000V1000H0Z',
          x: i * 1000,
          y: 0,
          fill: i === 0 ? 'rgb(255,176,46)' : null,
          opacity: 1,
          glyph: i,
        })),
      };
    },
  };
}

/** installed に含まれるファミリだけが「インストール済み」のFontProvider。 */
export function fakeFonts(installed: string[]): FontProvider {
  return {
    families: () => [...installed].sort(),
    resolve(families) {
      const hit = families.find((family) => installed.includes(family));
      return hit ? fakeFont(hit) : null;
    },
  };
}
