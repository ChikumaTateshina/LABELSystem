import type { EntryInput } from '../shared-types/index.ts';
import { parseCsv } from './csv.ts';
import { ValidationError, normalizeEntryInput, recordFromRow } from './importExport.ts';

/** スプレッドシート由来の作品に付ける入力元の名前 */
export const SHEET_PLATFORM = 'spreadsheet';

/** 依存ライブラリ無しで使える短いハッシュ（FNV-1a 32bit を2系統）。行IDが無い行の識別に使う。 */
function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function toRecords(text: string): Record<string, unknown>[] {
  const body = text.replace(/^\uFEFF/, '').trim();
  if (body.startsWith('{') || body.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ValidationError('シートの応答をJSONとして解析できませんでした。');
    }
    if (!Array.isArray(data) && typeof (data as { error?: unknown })?.error === 'string') {
      throw new ValidationError(`シート側でエラーが発生しました: ${(data as { error: string }).error}`);
    }
    const rows = Array.isArray(data) ? data : ((data as { entries?: unknown })?.entries ?? null);
    if (!Array.isArray(rows)) throw new ValidationError('シートの応答に entries がありません。');
    return rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
  }
  if (body.startsWith('<')) {
    throw new ValidationError(
      'シートからHTMLが返されました。URLと公開設定（ウェブアプリのアクセス権）を確認してください。',
    );
  }
  const [header, ...rows] = parseCsv(body);
  if (!header) return [];
  return rows.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

/**
 * スプレッドシート（GASウェブアプリのJSON、または「ウェブに公開」したCSV）の内容を EntryInput へ変換する。
 *
 * 再同期しても二重登録にならないよう、各行に重複判定用のキーを付ける:
 * - 元投稿URLがある行 … 投稿ID（拡張機能からの登録とも重複しない）
 * - それ以外の行 … id 列の値。id 列が無ければ タイトル・ユーザ名・ユーザID のハッシュ
 */
export function parseSheetPayload(text: string): EntryInput[] {
  const inputs: EntryInput[] = [];
  for (const raw of toRecords(text)) {
    const { record, rowId } = recordFromRow(raw);
    const input = normalizeEntryInput(record);
    if (!input.title && !input.userDisplayName && !input.userId && !input.comment) continue;
    if (!input.sourcePostId) {
      const key = rowId || shortHash([input.title, input.userDisplayName, input.userId].join('\n'));
      input.sourcePostId = `sheet:${key}`;
      input.sourcePlatform = SHEET_PLATFORM;
    }
    inputs.push(input);
  }
  return inputs;
}
