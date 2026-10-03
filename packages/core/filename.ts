import type { CaptionModel } from '../shared-types/index.ts';

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PART_LENGTH = 60;

/** ファイルシステム上危険な文字を除去する。 */
export function sanitizeFileNamePart(value: string): string {
  let part = (value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^[._]+|[._]+$/g, '');
  part = Array.from(part).slice(0, MAX_PART_LENGTH).join('');
  if (RESERVED_NAMES.test(part)) part = `_${part}`;
  return part;
}

/**
 * 出力ファイル名を生成する（仕様 §40）。
 * {entry_number}_{user_id}_{title}.{ext}
 */
export function buildFileName(
  model: Pick<CaptionModel, 'entry_number' | 'userid' | 'title'>,
  extension: string,
): string {
  const parts = [
    sanitizeFileNamePart(model.entry_number),
    sanitizeFileNamePart(model.userid.replace(/^@/, '')),
    sanitizeFileNamePart(model.title) || 'untitled',
  ].filter(Boolean);
  return `${parts.join('_')}.${extension.replace(/^\./, '')}`;
}
