import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ValidationError,
  buildFileName,
  createDraft,
  displayEntryNumber,
  entriesToCsv,
  entriesToJson,
  normalizeEntryInput,
  normalizeUserId,
  padEntryNumber,
  parseEntriesCsv,
  parseEntriesJson,
  parseSheetPayload,
  toCaptionModel,
} from '../../../packages/core/index.ts';
import {
  DuplicateEntryNumberError,
  DuplicatePostError,
  SqliteEntryRepository,
  SqliteEventRepository,
  ensureCompatible,
  openDatabase,
} from '../../../packages/database/index.ts';
import {
  CONTENT_TYPES,
  CaptionRenderer,
  FontRegistry,
  OUTPUT_FORMATS,
  systemFontDirs,
  type FontProvider,
  type OutputFormat,
  type RenderWarning,
  type RenderedCaption,
} from '../../../packages/renderer/index.ts';
import {
  ENTRY_STATUSES,
  type CaptionEntry,
  type EntryDraft,
  type EntryInput,
  type EntryRepository,
  type EntryStatus,
  type EntryUpdate,
  type EventInput,
  type EventRecord,
  type EventRepository,
  type SourcePost,
} from '../../../packages/shared-types/index.ts';
import {
  FsTemplateRepository,
  type Template,
  type TemplateRepository,
} from '../../../packages/template-engine/index.ts';
import { loadConfig, type AppConfig, type AppPaths } from './config.ts';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type EntryView = CaptionEntry & { displayNumber: string };

export interface ExportRequest {
  eventId?: string;
  entryIds?: string[];
  formats: OutputFormat[];
  templateId?: string;
  /** captions-all.pdf / captions-all.html も生成する */
  combined?: boolean;
}

export interface ExportResult {
  directory: string;
  files: string[];
  warnings: { entryId: string; displayNumber: string; warnings: RenderWarning[] }[];
}

export interface ImportResult {
  created: number;
  skipped: { row: number; reason: string }[];
}

export interface SheetSyncResult extends ImportResult {
  /** シートから取得した行数 */
  fetched: number;
  /** 既に登録済みだった行数 */
  unchanged: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * アプリケーションの操作をまとめた層。HTTPには依存しない。
 * DB・テンプレート・レンダラーはそれぞれの境界（Repository / CaptionRenderer）越しにのみ扱う。
 */
export class CaptionService {
  readonly config: AppConfig;
  readonly db: DatabaseSync;
  readonly entries: EntryRepository;
  readonly events: EventRepository;
  readonly templates: TemplateRepository;
  readonly renderer: CaptionRenderer;

  constructor(
    readonly paths: AppPaths,
    options: { fonts?: FontProvider } = {},
  ) {
    this.config = loadConfig(paths);
    this.db = openDatabase(paths.databaseFile);
    ensureCompatible(this.db);
    this.entries = new SqliteEntryRepository(this.db);
    this.events = new SqliteEventRepository(this.db);
    // 探索優先順位: ユーザー指定 → data/templates → 同梱サンプル（仕様 §69）
    this.templates = new FsTemplateRepository([
      ...this.config.templateDirs,
      join(paths.dataDir, 'templates'),
      paths.bundledTemplatesDir,
    ]);
    const fonts =
      options.fonts ??
      new FontRegistry(
        [join(paths.dataDir, 'assets', 'fonts'), ...this.config.fontDirs, ...systemFontDirs()],
        join(paths.dataDir, 'cache', 'font-index.json'),
      );
    this.renderer = new CaptionRenderer(fonts, { pngDpi: this.config.output.pngDpi });
  }

  close(): void {
    this.db.close();
  }

  /** 操作ログ（仕様 §42）。個人情報を残さないよう、IDと管理番号のみ記録する。 */
  log(action: string, detail: Record<string, unknown> = {}): void {
    try {
      const dir = join(this.paths.dataDir, 'logs');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, 'operations.log'),
        JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + '\n',
      );
    } catch (error) {
      console.warn(`[log] 操作ログを書き込めません: ${(error as Error).message}`);
    }
  }

  // ---- イベント ---------------------------------------------------------

  /** 受付中のイベント。1件も無ければ設定ファイルの内容から作成する。 */
  currentEvent(): EventRecord {
    const all = this.events.list();
    const active = all.find((event) => event.status === 'active');
    if (active) return active;
    const { name, year, entryNumberPrefix } = this.config.event;
    return this.events.create({
      name: all.length === 0 ? name : `${name} (new)`,
      year: year ?? null,
      entryNumberPrefix,
      defaultTemplateId: this.config.caption.defaultTemplate,
    });
  }

  createEvent(raw: Record<string, unknown>): EventRecord {
    const input = this.parseEventInput(raw);
    if (!input.name) throw new HttpError(400, 'イベント名を入力してください。');
    const event = this.events.create(input as EventInput);
    this.log('event.create', { eventId: event.id });
    return event;
  }

  updateEvent(id: string, raw: Record<string, unknown>): EventRecord {
    const event = this.events.update(id, this.parseEventInput(raw));
    if (!event) throw new HttpError(404, 'イベントが見つかりません。');
    this.log('event.update', { eventId: id });
    return event;
  }

  private parseEventInput(raw: Record<string, unknown>): Partial<EventInput> {
    const input: Partial<EventInput> = {};
    if (typeof raw.name === 'string') input.name = raw.name.trim();
    if (raw.year === null || raw.year === '') input.year = null;
    else if (raw.year !== undefined) {
      const year = Number(raw.year);
      if (!Number.isInteger(year)) throw new HttpError(400, '年度は整数で入力してください。');
      input.year = year;
    }
    if (typeof raw.entryNumberPrefix === 'string') input.entryNumberPrefix = raw.entryNumberPrefix.trim();
    if (raw.defaultTemplateId === null || typeof raw.defaultTemplateId === 'string') {
      input.defaultTemplateId = raw.defaultTemplateId || null;
    }
    if (raw.status === 'active' || raw.status === 'archived') input.status = raw.status;
    return input;
  }

  // ---- 作品 -------------------------------------------------------------

  present(entry: CaptionEntry): EntryView {
    const event = this.events.get(entry.eventId);
    return { ...entry, displayNumber: displayEntryNumber(entry, event, this.config.event.entryNumberFormat) };
  }

  getEntry(id: string): CaptionEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new HttpError(404, '作品が見つかりません。');
    return entry;
  }

  /** 投稿データから登録確認画面用のドラフトを作る。登録済みの場合はその作品も返す。 */
  parseDraft(post: SourcePost): { draft: EntryDraft; existing: EntryView | null } {
    const draft = createDraft(
      { ...post, platform: post.platform || this.config.source.platform },
      this.config.parser,
    );
    const existing = draft.sourcePostId ? this.entries.findByPostId(draft.sourcePostId) : null;
    return { draft, existing: existing ? this.present(existing) : null };
  }

  createEntry(raw: unknown): EntryView {
    const input = this.normalize(raw);
    try {
      const entry = this.insert(input);
      this.log('entry.create', { entryId: entry.id, entryNumber: entry.entryNumber });
      return this.present(entry);
    } catch (error) {
      throw this.translate(error);
    }
  }

  private normalize(raw: unknown): EntryInput {
    try {
      return normalizeEntryInput(raw);
    } catch (error) {
      if (error instanceof ValidationError) throw new HttpError(400, error.message);
      throw error;
    }
  }

  private insert(input: EntryInput): CaptionEntry {
    if (!input.title && !input.userDisplayName && !input.userId && !input.comment) {
      throw new HttpError(400, 'タイトル・ユーザ名・ユーザID・コメントのいずれかを入力してください。');
    }
    const eventId = input.eventId ?? this.currentEvent().id;
    if (!this.events.get(eventId)) throw new HttpError(400, '指定されたイベントが存在しません。');
    const entryNumber =
      input.entryNumber ??
      padEntryNumber(this.entries.nextEntryNumber(eventId), this.config.event.entryNumberDigits);
    return this.entries.create({ ...input, eventId, entryNumber });
  }

  private translate(error: unknown): unknown {
    if (error instanceof DuplicatePostError) {
      return new HttpError(409, error.message, { code: 'duplicate-post', existing: this.present(error.existing) });
    }
    if (error instanceof DuplicateEntryNumberError) {
      return new HttpError(409, error.message, { code: 'duplicate-entry-number' });
    }
    return error;
  }

  updateEntry(id: string, raw: Record<string, unknown>): EntryView {
    const patch: EntryUpdate = {};
    for (const key of ['title', 'userDisplayName', 'comment'] as const) {
      const value = str(raw[key]);
      if (value !== undefined) patch[key] = value.replace(/\r\n?/g, '\n').trim();
    }
    if (typeof raw.userId === 'string') patch.userId = normalizeUserId(raw.userId);
    if (typeof raw.entryNumber === 'string' && raw.entryNumber.trim()) patch.entryNumber = raw.entryNumber.trim();
    if (raw.status !== undefined) {
      if (!ENTRY_STATUSES.includes(raw.status as EntryStatus)) throw new HttpError(400, '不正なステータスです。');
      patch.status = raw.status as EntryStatus;
    }
    if (raw.templateId === null || typeof raw.templateId === 'string') patch.templateId = raw.templateId || null;

    try {
      const entry = this.entries.update(id, patch);
      if (!entry) throw new HttpError(404, '作品が見つかりません。');
      this.log('entry.update', { entryId: id, entryNumber: entry.entryNumber });
      return this.present(entry);
    } catch (error) {
      throw this.translate(error);
    }
  }

  deleteEntry(id: string): void {
    const entry = this.getEntry(id);
    this.entries.delete(id);
    this.log('entry.delete', { entryId: id, entryNumber: entry.entryNumber });
  }

  // ---- レンダリング -----------------------------------------------------

  resolveTemplate(templateId: string | null | undefined, eventId?: string): Template {
    const candidates = [
      templateId,
      eventId ? this.events.get(eventId)?.defaultTemplateId : null,
      this.config.caption.defaultTemplate,
    ].filter((id): id is string => Boolean(id));
    for (const id of candidates) {
      const template = this.templates.get(id);
      if (template) return template;
      if (id === templateId) throw new HttpError(404, `テンプレート「${id}」が見つかりません。`);
    }
    const first = this.templates.list()[0];
    const fallback = first ? this.templates.get(first.id) : null;
    if (!fallback) throw new HttpError(500, '利用可能なテンプレートがありません。');
    return fallback;
  }

  renderEntry(entry: CaptionEntry, templateId?: string): RenderedCaption {
    const template = this.resolveTemplate(templateId ?? entry.templateId, entry.eventId);
    return this.renderer.render(toCaptionModel(entry, this.present(entry).displayNumber), template);
  }

  /** 未保存の編集内容をプレビューする。 */
  preview(raw: Record<string, unknown>): { svg: string; warnings: RenderWarning[]; templateId: string } {
    const base = typeof raw.id === 'string' ? this.entries.get(raw.id) : null;
    const eventId = base?.eventId ?? str(raw.eventId) ?? this.currentEvent().id;
    const event = this.events.get(eventId);
    const entryNumber =
      str(raw.entryNumber)?.trim() ||
      base?.entryNumber ||
      padEntryNumber(this.entries.nextEntryNumber(eventId), this.config.event.entryNumberDigits);
    const model = toCaptionModel(
      {
        title: str(raw.title) ?? '',
        userDisplayName: str(raw.userDisplayName) ?? '',
        userId: str(raw.userId) ?? '',
        comment: str(raw.comment) ?? '',
      },
      displayEntryNumber({ entryNumber }, event, this.config.event.entryNumberFormat),
    );
    const template = this.resolveTemplate(str(raw.templateId) || null, eventId);
    const caption = this.renderer.render(model, template);
    return { svg: caption.svg, warnings: caption.warnings, templateId: template.id };
  }

  async outputEntry(
    id: string,
    format: OutputFormat,
    templateId?: string,
  ): Promise<{ body: Buffer; fileName: string; contentType: string; warnings: RenderWarning[] }> {
    const entry = this.getEntry(id);
    const caption = this.renderEntry(entry, templateId);
    const body = await this.renderer.output(caption, format);
    this.log('caption.generate', { entryId: id, entryNumber: entry.entryNumber, format, template: caption.template.id });
    return {
      body,
      fileName: buildFileName(caption.model, format),
      contentType: CONTENT_TYPES[format],
      warnings: caption.warnings,
    };
  }

  /** 一括出力（仕様 §38, §39）。個別ファイルを正とし、必要に応じて合成ファイルも生成する。 */
  async exportCaptions(request: ExportRequest): Promise<ExportResult> {
    const formats = [...new Set(request.formats)];
    if (formats.length === 0 || formats.some((f) => !OUTPUT_FORMATS.includes(f))) {
      throw new HttpError(400, '出力形式は svg / pdf / png / html から指定してください。');
    }
    const eventId = request.eventId ?? this.currentEvent().id;
    const targets = request.entryIds?.length
      ? request.entryIds.map((id) => this.getEntry(id))
      : this.entries.list({ eventId });
    if (targets.length === 0) throw new HttpError(400, '出力対象の作品がありません。');

    const directory = this.paths.outputDir;
    mkdirSync(directory, { recursive: true });
    const result: ExportResult = { directory, files: [], warnings: [] };
    const captions: RenderedCaption[] = [];

    for (const entry of targets) {
      const caption = this.renderEntry(entry, request.templateId);
      captions.push(caption);
      for (const format of formats) {
        const fileName = buildFileName(caption.model, format);
        writeFileSync(join(directory, fileName), await this.renderer.output(caption, format));
        result.files.push(fileName);
      }
      if (caption.warnings.length > 0) {
        result.warnings.push({
          entryId: entry.id,
          displayNumber: caption.model.entry_number,
          warnings: caption.warnings,
        });
      }
      if (entry.status === 'confirmed') this.entries.update(entry.id, { status: 'exported' });
      this.log('caption.generate', {
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        formats,
        template: caption.template.id,
      });
    }

    if (request.combined) {
      const title = this.events.get(eventId)?.name ?? 'Captions';
      if (formats.includes('pdf')) {
        writeFileSync(join(directory, 'captions-all.pdf'), await this.renderer.toPdf(captions, { title }));
        result.files.push('captions-all.pdf');
      }
      if (formats.includes('html')) {
        writeFileSync(join(directory, 'captions-all.html'), this.renderer.toHtml(captions, { title }));
        result.files.push('captions-all.html');
      }
    }
    return result;
  }

  // ---- インポート・エクスポート・バックアップ ---------------------------

  exportData(format: 'json' | 'csv', eventId?: string): string {
    const entries = this.entries.list(eventId ? { eventId } : {});
    return format === 'csv' ? entriesToCsv(entries) : entriesToJson(entries);
  }

  importEntries(format: string, content: string, eventId?: string): ImportResult {
    let inputs: EntryInput[];
    try {
      if (format === 'csv') inputs = parseEntriesCsv(content);
      else if (format === 'json') inputs = parseEntriesJson(content);
      else throw new ValidationError('形式は json または csv を指定してください。');
    } catch (error) {
      if (error instanceof ValidationError) throw new HttpError(400, error.message);
      throw error;
    }

    const targetEventId = eventId ?? this.currentEvent().id;
    const result: ImportResult = { created: 0, skipped: [] };
    inputs.forEach((input, index) => {
      try {
        const entry = this.insert({ ...input, eventId: targetEventId });
        this.log('entry.create', { entryId: entry.id, entryNumber: entry.entryNumber, via: 'import' });
        result.created++;
      } catch (error) {
        result.skipped.push({ row: index + 1, reason: (error as Error).message });
      }
    });
    return result;
  }

  /**
   * スプレッドシートから新しい行を取り込む（GAS連携）。
   * 登録済みの行は変更しない。取り込み後の修正は管理画面側が正となる。
   */
  async syncSheet(fetcher: typeof fetch = fetch): Promise<SheetSyncResult> {
    const { url, token } = this.config.sheet;
    if (!url) throw new HttpError(400, 'スプレッドシート連携が設定されていません（data/config.json の sheet.url）。');
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new HttpError(400, 'sheet.url が正しいURLではありません。');
    }
    const local = ['127.0.0.1', 'localhost'].includes(target.hostname);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) {
      throw new HttpError(400, 'sheet.url は https:// で始まる必要があります。');
    }
    if (token) target.searchParams.set('token', token);

    let text: string;
    try {
      const response = await fetcher(target, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
    } catch (error) {
      throw new HttpError(502, `スプレッドシートを取得できませんでした: ${(error as Error).message}`);
    }

    let inputs: EntryInput[];
    try {
      inputs = parseSheetPayload(text);
    } catch (error) {
      if (error instanceof ValidationError) throw new HttpError(502, error.message);
      throw error;
    }

    const eventId = this.currentEvent().id;
    const result: SheetSyncResult = { fetched: inputs.length, created: 0, unchanged: 0, skipped: [] };
    inputs.forEach((input, index) => {
      try {
        const entry = this.insert({ ...input, eventId });
        this.log('entry.create', { entryId: entry.id, entryNumber: entry.entryNumber, via: 'sheet' });
        result.created++;
      } catch (error) {
        if (error instanceof DuplicatePostError) result.unchanged++;
        else result.skipped.push({ row: index + 1, reason: (error as Error).message });
      }
    });
    this.log('sheet.sync', { fetched: result.fetched, created: result.created, skipped: result.skipped.length });
    return result;
  }

  /** DBと entries.json を data/backups/<日時>/ へ保存する（仕様 §43）。 */
  backup(): { directory: string } {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = join(this.paths.dataDir, 'backups', stamp);
    mkdirSync(directory, { recursive: true });
    this.db.exec(`VACUUM INTO '${join(directory, 'database.sqlite').replace(/'/g, "''")}'`);
    writeFileSync(join(directory, 'entries.json'), this.exportData('json'));
    this.log('backup.create', { directory: stamp });
    return { directory };
  }
}
