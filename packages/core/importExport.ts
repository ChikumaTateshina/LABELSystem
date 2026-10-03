import type { CaptionEntry, EntryInput, EntryStatus } from '../shared-types/index.ts';
import { ENTRY_STATUSES } from '../shared-types/index.ts';
import { parseCsv, toCsv } from './csv.ts';
import { normalizeUserId } from './postParser.ts';

export class ValidationError extends Error {}

export const CSV_COLUMNS = [
  'entry_number',
  'title',
  'user_display_name',
  'user_id',
  'comment',
  'source_post_url',
  'source_post_id',
  'original_post_text',
  'status',
  'template_id',
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number] | 'row_id';

/** スプレッドシートで付けられがちな列名も受け付ける。 */
const HEADER_ALIASES: Record<string, CsvColumn> = {
  entry_number: 'entry_number',
  entrynumber: 'entry_number',
  no: 'entry_number',
  'no.': 'entry_number',
  番号: 'entry_number',
  管理番号: 'entry_number',
  title: 'title',
  タイトル: 'title',
  作品タイトル: 'title',
  作品名: 'title',
  user_display_name: 'user_display_name',
  userdisplayname: 'user_display_name',
  username: 'user_display_name',
  ユーザ名: 'user_display_name',
  ユーザー名: 'user_display_name',
  表示名: 'user_display_name',
  user_id: 'user_id',
  userid: 'user_id',
  ユーザid: 'user_id',
  ユーザーid: 'user_id',
  comment: 'comment',
  コメント: 'comment',
  source_post_url: 'source_post_url',
  sourceposturl: 'source_post_url',
  url: 'source_post_url',
  元投稿url: 'source_post_url',
  投稿url: 'source_post_url',
  source_post_id: 'source_post_id',
  sourcepostid: 'source_post_id',
  投稿id: 'source_post_id',
  original_post_text: 'original_post_text',
  originalposttext: 'original_post_text',
  元投稿本文: 'original_post_text',
  status: 'status',
  状態: 'status',
  template_id: 'template_id',
  templateid: 'template_id',
  テンプレート: 'template_id',
  id: 'row_id',
  row_id: 'row_id',
  rowid: 'row_id',
  行id: 'row_id',
  post_url: 'source_post_url',
  ポストurl: 'source_post_url',
  応募url: 'source_post_url',
  応募投稿url: 'source_post_url',
  xのユーザーid: 'user_id',
  xのid: 'user_id',
  アカウント: 'user_id',
  名前: 'user_display_name',
  お名前: 'user_display_name',
  entry_no: 'entry_number',
};

function columnOf(header: string): CsvColumn | undefined {
  return HEADER_ALIASES[header.trim().toLowerCase().replace(/\s+/g, '_')];
}

/**
 * 列名をキーにした1行分のデータ（スプレッドシートの行など）を、normalizeEntryInput へ渡せる形へ変換する。
 * 認識できない列は無視する。
 */
export function recordFromRow(row: Record<string, unknown>): { record: Record<string, unknown>; rowId: string } {
  const values: Partial<Record<CsvColumn, string>> = {};
  for (const [header, value] of Object.entries(row)) {
    const column = columnOf(header);
    if (column && values[column] === undefined) values[column] = str(value);
  }
  return {
    rowId: (values.row_id ?? '').trim(),
    record: {
      entryNumber: values.entry_number,
      title: values.title,
      userDisplayName: values.user_display_name,
      userId: values.user_id,
      comment: values.comment,
      sourcePostUrl: values.source_post_url,
      sourcePostId: values.source_post_id,
      originalPostText: values.original_post_text,
      status: values.status,
      templateId: values.template_id,
    },
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function optional(value: unknown): string | undefined {
  const s = str(value).trim();
  return s === '' ? undefined : s;
}

function parseStatus(value: unknown): EntryStatus | undefined {
  const s = str(value).trim().toLowerCase();
  return (ENTRY_STATUSES as readonly string[]).includes(s) ? (s as EntryStatus) : undefined;
}

/** 投稿URLから投稿IDを導出する（CSV手入力時の重複防止用）。 */
export function postIdFromUrl(url: string | undefined): string | undefined {
  const m = /\/status(?:es)?\/(\d+)/.exec(url ?? '');
  return m ? m[1] : undefined;
}

/**
 * 外部から受け取った値を EntryInput へ正規化する。
 * API形式（§20 のフラット形式）と、サンプルデータ形式（§91 の source ネスト形式）の両方を受け付ける。
 */
export function normalizeEntryInput(raw: unknown): EntryInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('作品データはオブジェクトで指定してください。');
  }
  const r = raw as Record<string, unknown>;
  const source = (typeof r.source === 'object' && r.source !== null ? r.source : {}) as Record<string, unknown>;

  const sourcePostUrl = optional(r.sourcePostUrl ?? source.postUrl);
  const input: EntryInput = {
    eventId: optional(r.eventId),
    entryNumber: optional(r.entryNumber),
    title: str(r.title).trim(),
    userDisplayName: str(r.userDisplayName).trim(),
    userId: normalizeUserId(str(r.userId)),
    comment: str(r.comment).replace(/\r\n?/g, '\n').trim(),
    status: parseStatus(r.status),
    templateId: optional(r.templateId) ?? null,
    sourcePlatform: optional(r.sourcePlatform ?? source.platform),
    originalPostText: optional(r.originalPostText ?? source.originalText),
    sourcePostId: optional(r.sourcePostId ?? source.postId) ?? postIdFromUrl(sourcePostUrl),
    sourcePostUrl,
  };
  if (sourcePostUrl && !/^https?:\/\//i.test(sourcePostUrl)) {
    throw new ValidationError('元投稿URLは http(s):// で始まる必要があります。');
  }
  return input;
}

export function entriesToJson(entries: CaptionEntry[]): string {
  return JSON.stringify({ format: 'label-system-entries', version: 1, entries }, null, 2);
}

export function entriesToCsv(entries: CaptionEntry[]): string {
  const rows: string[][] = [[...CSV_COLUMNS]];
  for (const e of entries) {
    rows.push([
      e.entryNumber,
      e.title,
      e.userDisplayName,
      e.userId,
      e.comment,
      e.source?.postUrl ?? '',
      e.source?.postId ?? '',
      e.source?.originalText ?? '',
      e.status,
      e.templateId ?? '',
    ]);
  }
  // ExcelでUTF-8として開けるようBOMを付ける
  return '\uFEFF' + toCsv(rows);
}

export function parseEntriesJson(text: string): EntryInput[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new ValidationError('JSONを解析できませんでした。');
  }
  const list = Array.isArray(data) ? data : (data as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) {
    throw new ValidationError('JSONは作品の配列、または { "entries": [...] } の形式で指定してください。');
  }
  return list.map(normalizeEntryInput);
}

export function parseEntriesCsv(text: string): EntryInput[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  if (!rows[0].some((h) => columnOf(h) && columnOf(h) !== 'row_id')) {
    throw new ValidationError('CSVのヘッダ行を認識できませんでした。1行目に列名を指定してください。');
  }
  return rows
    .slice(1)
    .map((cells) =>
      normalizeEntryInput(recordFromRow(Object.fromEntries(rows[0].map((h, i) => [h, cells[i] ?? '']))).record),
    );
}
