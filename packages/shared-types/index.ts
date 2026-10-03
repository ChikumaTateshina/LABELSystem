/**
 * パッケージ間で共有するデータ型。
 * ここには型のみを置き、ロジックや特定プラットフォーム（X等）への依存を持ち込まない。
 */

/** 投稿取得機構が返す、入力元に依存しない投稿データ（仕様 §65） */
export interface SourcePost {
  platform: string;
  postId?: string;
  postUrl?: string;
  userDisplayName: string;
  userId: string;
  text: string;
  capturedAt?: string;
}

/** 入力元インターフェース。X以外の入力元を追加する場合はこれを実装する。 */
export interface PostExtractor {
  extract(): Promise<SourcePost>;
}

export type EntryStatus = 'draft' | 'confirmed' | 'exported';
export const ENTRY_STATUSES: readonly EntryStatus[] = ['draft', 'confirmed', 'exported'];

export interface EntrySource {
  platform: string;
  postId?: string;
  postUrl?: string;
  originalText?: string;
}

/** 作品1件（仕様 §63）。X固有情報は source 以下に格納する。 */
export interface CaptionEntry {
  id: string;
  eventId: string;
  entryNumber: string;
  title: string;
  userDisplayName: string;
  userId: string;
  comment: string;
  status: EntryStatus;
  templateId: string | null;
  source?: EntrySource;
  createdAt: string;
  updatedAt: string;
}

/** 登録・更新時の入力（仕様 §20 のAPI形式）。 */
export interface EntryInput {
  eventId?: string;
  entryNumber?: string;
  title: string;
  userDisplayName: string;
  userId: string;
  comment: string;
  status?: EntryStatus;
  templateId?: string | null;
  sourcePlatform?: string;
  originalPostText?: string;
  sourcePostId?: string;
  sourcePostUrl?: string;
}

/** 表示情報の更新。元投稿情報（source）は更新対象に含めない（仕様 §41）。 */
export type EntryUpdate = Partial<
  Pick<
    EntryInput,
    'entryNumber' | 'title' | 'userDisplayName' | 'userId' | 'comment' | 'status' | 'templateId'
  >
>;

/** 投稿本文の解析結果。登録確認画面の初期値になる。 */
export interface EntryDraft {
  title: string;
  userDisplayName: string;
  userId: string;
  comment: string;
  originalPostText: string;
  sourcePlatform: string;
  sourcePostId?: string;
  sourcePostUrl?: string;
}

/** テンプレートへ渡す中間モデル（仕様 §22）。 */
export interface CaptionModel {
  title: string;
  username: string;
  userid: string;
  comment: string;
  entry_number: string;
}

export type EventStatus = 'active' | 'archived';

export interface EventRecord {
  id: string;
  name: string;
  year: number | null;
  entryNumberPrefix: string;
  defaultTemplateId: string | null;
  status: EventStatus;
  createdAt: string;
}

export interface EventInput {
  name: string;
  year?: number | null;
  entryNumberPrefix?: string;
  defaultTemplateId?: string | null;
  status?: EventStatus;
}

export interface EntryListFilter {
  eventId?: string;
  status?: EntryStatus;
}

/** DB方式を交換可能にするための境界（仕様 §17, §97）。 */
export interface EntryRepository {
  create(input: EntryInput & { eventId: string; entryNumber: string }): CaptionEntry;
  update(id: string, patch: EntryUpdate): CaptionEntry | null;
  delete(id: string): boolean;
  get(id: string): CaptionEntry | null;
  list(filter?: EntryListFilter): CaptionEntry[];
  findByPostId(postId: string): CaptionEntry | null;
  nextEntryNumber(eventId: string): number;
}

export interface EventRepository {
  create(input: EventInput): EventRecord;
  update(id: string, patch: Partial<EventInput>): EventRecord | null;
  get(id: string): EventRecord | null;
  list(): EventRecord[];
}
