/**
 * 自動改行と文字サイズ調整（仕様 §27〜§29）。
 * 文字数ではなく実際のレンダリング幅（measure 関数）で折り返しを判定する。
 */

import { graphemes } from './fonts.ts';

export type Measure = (text: string, fontSize: number) => number;

/** 行頭に置けない文字（行頭禁則） */
const NO_LINE_START = new Set(
  Array.from('、。，．,.・：；:;？！?!）)]］｝}〕〉》」』】〙〗ゝゞ々ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ…‥〜～'),
);
/** 行末に置けない文字（行末禁則） */
const NO_LINE_END = new Set(Array.from('（([［｛{〔〈《「『【〘〖'));

const WORD_CHAR = /^[\p{Script=Latin}\p{N}@#＃_'’\-./:%&+=~]$/u;

/** 分割可能な最小単位へ分ける。欧文の単語は途中で切らない。 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let word = '';
  for (const ch of graphemes(line)) {
    if (WORD_CHAR.test(ch)) {
      word += ch;
    } else {
      if (word) tokens.push(word);
      word = '';
      tokens.push(ch);
    }
  }
  if (word) tokens.push(word);

  // 禁則処理: 行頭禁則文字は前のトークンへ、行末禁則文字は次のトークンへ結合する
  const merged: string[] = [];
  let pendingPrefix = '';
  for (const token of tokens) {
    if (NO_LINE_START.has(token) && merged.length > 0 && !pendingPrefix) {
      merged[merged.length - 1] += token;
    } else if (NO_LINE_END.has(token)) {
      pendingPrefix += token;
    } else {
      merged.push(pendingPrefix + token);
      pendingPrefix = '';
    }
  }
  if (pendingPrefix) merged.push(pendingPrefix);
  return merged;
}

function breakLongToken(token: string, maxWidth: number, width: (text: string) => number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const ch of graphemes(token)) {
    if (current && width(current + ch) > maxWidth) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** テキストを maxWidth に収まる行へ分割する。明示的な改行は維持する。 */
export function wrapText(text: string, maxWidth: number, width: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let current = '';
    const push = () => {
      lines.push(current.replace(/\s+$/u, ''));
      current = '';
    };
    for (const token of tokenize(paragraph)) {
      if (current === '' && /^\s+$/u.test(token) && lines.length > 0) continue;
      if (width(current + token) <= maxWidth) {
        current += token;
        continue;
      }
      if (current !== '') push();
      if (/^\s+$/u.test(token)) continue;
      if (width(token) <= maxWidth) {
        current = token;
      } else {
        const parts = breakLongToken(token, maxWidth, width);
        current = parts.pop() ?? '';
        lines.push(...parts);
      }
    }
    if (current !== '') push();
  }
  return lines;
}

export interface FitOptions {
  maxWidth: number;
  maxLines: number;
  fontSize: number;
  minFontSize: number;
}

export interface FitResult {
  lines: string[];
  fontSize: number;
  /** 文字サイズを縮小したか */
  shrunk: boolean;
  /** 最小サイズまで縮小しても表示領域に収まらなかったか */
  overflow: boolean;
}

const SHRINK_STEP = 0.5;

/**
 * 処理優先順位（仕様 §29）:
 * 1. 通常表示 → 2. 自動改行 → 3. 許容範囲内で縮小 → 4. オーバーフロー警告
 * minFontSize より小さくはせず、収まらない場合は overflow を返して人間の修正に委ねる。
 */
export function fitText(text: string, options: FitOptions, measure: Measure): FitResult {
  const { maxWidth, maxLines, fontSize } = options;
  const minFontSize = Math.min(options.minFontSize, fontSize);

  const layout = (size: number) => wrapText(text, maxWidth, (t) => measure(t, size));
  const fits = (lines: string[], size: number) =>
    lines.length <= maxLines && lines.every((line) => measure(line, size) <= maxWidth + 0.01);

  let size = fontSize;
  let lines = layout(size);
  while (!fits(lines, size) && size - SHRINK_STEP >= minFontSize - 1e-9) {
    size = Math.round((size - SHRINK_STEP) * 100) / 100;
    lines = layout(size);
  }
  return { lines, fontSize: size, shrunk: size < fontSize, overflow: !fits(lines, size) };
}
