import type { CaptionEntry, CaptionModel, EventRecord } from '../shared-types/index.ts';
import { normalizeUserId } from './postParser.ts';

export interface EntryNumberFormat {
  /** 例: "{prefix}-{number}" / "No.{number}" / "{number}" */
  format?: string;
  prefix?: string;
}

/** 管理番号を連番から生成する（例: 42 → "042"）。 */
export function padEntryNumber(n: number, digits = 3): string {
  return String(n).padStart(digits, '0');
}

/** 管理番号の表示形式を適用する（仕様 §15 entry_number）。 */
export function formatEntryNumber(entryNumber: string, options: EntryNumberFormat = {}): string {
  const prefix = options.prefix ?? '';
  const format = options.format ?? (prefix ? '{prefix}-{number}' : '{number}');
  return format.replaceAll('{prefix}', prefix).replaceAll('{number}', entryNumber);
}

export function displayEntryNumber(
  entry: Pick<CaptionEntry, 'entryNumber'>,
  event: Pick<EventRecord, 'entryNumberPrefix'> | null,
  format?: string,
): string {
  return formatEntryNumber(entry.entryNumber, { prefix: event?.entryNumberPrefix ?? '', format });
}

function cleanText(value: string): string {
  return (value ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * DBレコードをテンプレート用の中間モデルへ変換する（仕様 §22）。
 * データ加工はここで完了させ、テンプレート側には加工ロジックを持たせない。
 */
export function toCaptionModel(
  entry: Pick<CaptionEntry, 'title' | 'userDisplayName' | 'userId' | 'comment'>,
  displayNumber = '',
): CaptionModel {
  return {
    title: cleanText(entry.title).replace(/\n+/g, ' '),
    username: cleanText(entry.userDisplayName).replace(/\n+/g, ' '),
    userid: normalizeUserId(entry.userId ?? ''),
    comment: cleanText(entry.comment),
    entry_number: displayNumber,
  };
}
