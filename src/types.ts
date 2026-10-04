/**
 * スプレッドシートの1行。列の並びは次のとおり（gas/Code.gs の COLUMNS と対応）。
 *
 *   No. | テーマ | 部門 | タイトル | ユーザ名 | ユーザID | コメント | 投稿日 |
 *   画像url(GoogleDrive) | 元投稿URL(Twitter) | 賞など | 備考
 */
export interface SheetRow {
  /** シート上の行番号（2 以上）。出力対象の指定に使う */
  row: number;
  no: string;
  theme: string;
  category: string;
  title: string;
  username: string;
  userid: string;
  comment: string;
  date: string;
  imageUrl: string;
  postUrl: string;
  award: string;
  note: string;
  /**
   * このPCの中だけで加筆修正した項目について、スプレッドシート上の元の値。
   * 修正していない行には付かない。
   */
  original?: Partial<Record<EditableField, string>>;
}

/** exe の中で加筆修正できる項目（No. とURLは対象外）。 */
export const EDITABLE_FIELDS = ['theme', 'category', 'title', 'username', 'userid', 'comment', 'date', 'award', 'note'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** 新しく追記する行。No. はシート側で採番する。 */
export type NewRow = Partial<Omit<SheetRow, 'row' | 'no' | 'original'>>;

export const ROW_FIELDS = [
  'no',
  'theme',
  'category',
  'title',
  'username',
  'userid',
  'comment',
  'date',
  'imageUrl',
  'postUrl',
  'award',
  'note',
] as const;

/**
 * テンプレートへ渡す値。キーがそのままテンプレート変数になる（{{title}} など）。
 * entry_number は no の別名。
 */
export interface CaptionModel {
  no: string;
  entry_number: string;
  theme: string;
  category: string;
  title: string;
  username: string;
  userid: string;
  comment: string;
  date: string;
  award: string;
  note: string;
}

/** ブラウザ拡張がXのページから読み取った投稿。 */
export interface SourcePost {
  platform: string;
  postId?: string;
  postUrl?: string;
  userDisplayName: string;
  userId: string;
  text: string;
  /** 投稿日時（ISO 8601）。ページから取得できた場合のみ */
  postedAt?: string;
}
