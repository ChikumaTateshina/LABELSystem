export interface ParseOptions {
  /** all: すべてのハッシュタグを除去 / contest: contestHashtags のみ除去 / none: 除去しない */
  removeHashtags?: 'all' | 'contest' | 'none';
  /** コンテスト指定ハッシュタグ（# の有無・大文字小文字は問わない） */
  contestHashtags?: string[];
  removeUrls?: boolean;
}

export interface ParsedPostText {
  title: string;
  comment: string;
}

/**
 * 明示的なタイトル記述のみを対象とする（仕様 §11）。
 * 「タイトル：○○」「題名: ○○」「Title: ○○」「【タイトル】○○」の形式。
 * 曖昧な本文からタイトルを推測することはしない。
 */
const TITLE_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:作品)?(?:タイトル|題名|作品名|title)\s*[:：]\s*(.+?)\s*$/i,
  /^\s*[【[［]\s*(?:作品)?(?:タイトル|題名|作品名|title)\s*[】\]］]\s*(.+?)\s*$/i,
];

const URL_PATTERN = /(?:https?:\/\/|pic\.(?:x|twitter)\.com\/)\S+/gi;
const HASHTAG_PATTERN = /[#＃][\p{L}\p{N}_ー・]+/gu;

function stripQuotes(title: string): string {
  const m = /^[「『"“](.+)[」』"”]$/.exec(title);
  return m ? m[1].trim() : title;
}

function normalizeTag(tag: string): string {
  return tag.replace(/^[#＃]/, '').toLowerCase();
}

/** 投稿本文からタイトルとコメント候補を取り出す（仕様 §11, §12）。 */
export function parsePostText(text: string, options: ParseOptions = {}): ParsedPostText {
  const removeHashtags = options.removeHashtags ?? 'all';
  const removeUrls = options.removeUrls ?? true;
  const contestTags = new Set((options.contestHashtags ?? []).map(normalizeTag));

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  const rest: string[] = [];

  for (const line of lines) {
    if (!title) {
      const match = TITLE_LINE_PATTERNS.map((p) => p.exec(line)).find(Boolean);
      if (match) {
        title = stripQuotes(match[1].trim());
        continue;
      }
    }
    rest.push(line);
  }

  let comment = rest.join('\n');
  if (removeUrls) comment = comment.replace(URL_PATTERN, '');
  if (removeHashtags === 'all') {
    comment = comment.replace(HASHTAG_PATTERN, '');
  } else if (removeHashtags === 'contest' && contestTags.size > 0) {
    comment = comment.replace(HASHTAG_PATTERN, (tag) => (contestTags.has(normalizeTag(tag)) ? '' : tag));
  }

  comment = comment
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+$/g, '').replace(/[ \t]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, comment };
}

/** ユーザIDを「@example」形式へ揃える。空の場合は空のまま。 */
export function normalizeUserId(userId: string): string {
  const trimmed = userId.trim().replace(/^[@＠]+/, '');
  return trimmed ? `@${trimmed}` : '';
}

/** 投稿日時（ISO 8601）を、シートへ書き込む「yyyy/MM/dd」形式（このPCのタイムゾーン）へ変換する。 */
export function formatPostDate(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}
