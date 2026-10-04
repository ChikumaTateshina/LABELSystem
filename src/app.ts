import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, type AppConfig, type AppPaths } from './config.ts';
import { openExternal, openFolder } from './desktop.ts';
import { buildFileName } from './filename.ts';
import { normalizeUserId } from './parser.ts';
import {
  CaptionRenderer,
  FontRegistry,
  OUTPUT_FORMATS,
  systemFontDirs,
  type FontProvider,
  type OutputFormat,
  type RenderWarning,
  type RenderedCaption,
} from './render/index.ts';
import { SheetClient } from './sheet.ts';
import {
  FsTemplateRepository,
  TEMPLATE_FILE_NAMES,
  TemplateError,
  parseTemplate,
  readTemplateFiles,
  type Template,
  type TemplateFiles,
  type TemplateRepository,
} from './template.ts';
import { EDITABLE_FIELDS, type CaptionModel, type EditableField, type SheetRow } from './types.ts';

/** スプレッドシートの1行を、テンプレートへ渡す値へ変換する。データの加工はここで済ませる。 */
export function toCaptionModel(row: Partial<SheetRow>): CaptionModel {
  // 複数行の項目: 前後の空行と末尾の空白は取り除くが、先頭の字下げ（空白）は残す
  const text = (value: string | undefined) =>
    (value ?? '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t\u3000]*\n)+/, '').trimEnd();
  const line = (value: string | undefined) => text(value).trim().replace(/\n+/g, ' ');
  return {
    no: line(row.no),
    entry_number: line(row.no),
    theme: line(row.theme),
    category: line(row.category),
    title: line(row.title),
    username: line(row.username),
    userid: normalizeUserId(row.userid ?? ''),
    comment: text(row.comment),
    date: line(row.date),
    award: line(row.award),
    note: text(row.note),
  };
}

type Edit = Partial<Record<EditableField, string>>;
type Edits = Record<string, Edit>;

/**
 * 修正を行へ結び付けるための鍵。No. を使う（シートで行を並べ替えても対応が崩れないように）。
 * No. が空の行は、シート上の行番号で代用する。
 */
function editKey(row: Pick<SheetRow, 'no' | 'row'>): string {
  return row.no.trim() ? `no:${row.no.trim()}` : `row:${row.row}`;
}

/** シートの行に修正を重ねる。修正した項目の元の値は original に残す。 */
function applyEdit(row: SheetRow, edit: Edit | undefined): SheetRow {
  if (!edit) return row;
  const merged: SheetRow = { ...row };
  const original: Edit = {};
  for (const field of EDITABLE_FIELDS) {
    const value = edit[field];
    if (typeof value !== 'string' || value === row[field]) continue;
    original[field] = row[field];
    merged[field] = value;
  }
  return Object.keys(original).length > 0 ? { ...merged, original } : row;
}

/** 修正を重ねた行から、スプレッドシート上の元の行を取り出す。 */
function stripEdit(row: SheetRow): SheetRow {
  const { original, ...rest } = row;
  return { ...rest, ...(original ?? {}) };
}

export interface OutputResult {
  directory: string;
  files: string[];
  warnings: { no: string; title: string; messages: string[] }[];
  /** 出力全体についての注意（フォントを内包できなかった場合など） */
  notes: string[];
}

/**
 * 画面から呼び出される処理。やることは3つだけ:
 * スプレッドシートを読む / テンプレートへ差し込んでプレビューする / ファイルへ出力する。
 */
export class LabelApp {
  private config: AppConfig;
  private readonly templates: TemplateRepository;
  private readonly renderer: CaptionRenderer;

  constructor(
    private readonly paths: AppPaths,
    private readonly options: { fonts?: FontProvider; fetcher?: typeof fetch } = {},
  ) {
    this.config = loadConfig(paths);
    // 探索優先順位: ユーザー指定 → data/templates → 同梱サンプル
    this.templates = new FsTemplateRepository([
      ...this.config.templateDirs,
      join(paths.dataDir, 'templates'),
      paths.templatesDir,
    ]);
    const fonts =
      options.fonts ??
      new FontRegistry(
        [join(paths.dataDir, 'fonts'), ...this.config.fontDirs, ...systemFontDirs()],
        join(paths.dataDir, 'cache', 'font-index.json'),
      );
    this.renderer = new CaptionRenderer(fonts, { pngDpi: this.config.pngDpi });
  }

  /** 画面からの呼び出しを、名前で振り分ける。ここに無い名前は呼び出せない。 */
  handle = async (method: string, params?: unknown): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'state':
        return this.state();
      case 'saveSettings':
        return this.saveSettings(String(p.url ?? ''), String(p.token ?? ''));
      case 'rows':
        return this.rows();
      case 'saveEdit':
        return this.saveEdit(p.row as SheetRow, (p.changes ?? {}) as Record<string, unknown>);
      case 'clearEdit':
        return this.clearEdit(p.row as SheetRow);
      case 'preview':
        return this.preview(p.row as SheetRow, String(p.templateId ?? ''));
      case 'output':
        return this.output(
          p.rows as SheetRow[],
          p.formats as OutputFormat[],
          String(p.templateId ?? ''),
          p.combined === true,
          p.embedFonts === true,
        );
      case 'fonts':
        return this.renderer.fontFamilies();
      case 'templateFiles':
        return this.templateFiles(String(p.templateId ?? ''));
      case 'previewTemplate':
        return this.previewTemplate(p.row as SheetRow, p.files as TemplateFiles);
      case 'saveTemplate':
        return this.saveTemplate(p.files as TemplateFiles);
      case 'openOutput':
        mkdirSync(this.paths.outputDir, { recursive: true });
        return openFolder(this.paths.outputDir);
      case 'openUrl':
        return openExternal(String(p.url ?? ''));
      default:
        throw new Error(`不明な操作です: ${method}`);
    }
  };

  state() {
    return {
      configured: Boolean(this.config.sheet.url && this.config.sheet.token),
      sheetUrl: this.config.sheet.url,
      templates: this.templates.list(),
      template: this.config.template,
      formats: OUTPUT_FORMATS,
      outputDir: this.paths.outputDir,
    };
  }

  private sheet(): SheetClient {
    return new SheetClient(this.config.sheet, this.options.fetcher);
  }

  /** 接続を確認してから保存する。 */
  async saveSettings(url: string, token: string) {
    const sheet = { url: url.trim(), token: token.trim() };
    await new SheetClient(sheet, this.options.fetcher).ping();
    saveConfig(this.paths, { sheet });
    this.config = { ...this.config, sheet };
    return this.state();
  }

  /** スプレッドシートの行を読み、このPCでの加筆修正を重ねて返す。 */
  async rows(): Promise<SheetRow[]> {
    const edits = this.loadEdits();
    return (await this.sheet().list()).map((row) => applyEdit(row, edits[editKey(row)]));
  }

  // ---- このPCの中だけでの加筆修正 ------------------------------------------
  //
  // スプレッドシートは書き換えず、修正した項目だけを data/edits.json に保存する。
  // 読み込むたびにシートの値へ重ねるので、プレビューにも出力にも反映される。

  private get editsFile(): string {
    return join(this.paths.dataDir, 'edits.json');
  }

  private loadEdits(): Edits {
    if (!existsSync(this.editsFile)) return {};
    try {
      return JSON.parse(readFileSync(this.editsFile, 'utf8')) as Edits;
    } catch {
      return {};
    }
  }

  private storeEdits(edits: Edits): void {
    mkdirSync(this.paths.dataDir, { recursive: true });
    writeFileSync(this.editsFile, JSON.stringify(edits, null, 2) + '\n');
  }

  /**
   * 行の加筆修正を保存する。row は画面に表示している行（修正を重ねた状態）。
   * シートの値と同じに戻した項目は、修正の記録から外す。
   */
  saveEdit(row: SheetRow, changes: Record<string, unknown>): SheetRow {
    const sheetRow = stripEdit(row);
    const edits = this.loadEdits();
    const next: Edit = { ...(edits[editKey(sheetRow)] ?? {}) };
    for (const field of EDITABLE_FIELDS) {
      const value = changes[field];
      if (typeof value !== 'string') continue;
      const normalized = value.replace(/\r\n?/g, '\n');
      if (normalized === sheetRow[field]) delete next[field];
      else next[field] = normalized;
    }
    if (Object.keys(next).length > 0) edits[editKey(sheetRow)] = next;
    else delete edits[editKey(sheetRow)];
    this.storeEdits(edits);
    return applyEdit(sheetRow, edits[editKey(sheetRow)]);
  }

  /** 行の加筆修正をすべて取り消し、スプレッドシートの内容へ戻す。 */
  clearEdit(row: SheetRow): SheetRow {
    const sheetRow = stripEdit(row);
    const edits = this.loadEdits();
    delete edits[editKey(sheetRow)];
    this.storeEdits(edits);
    return sheetRow;
  }

  private render(row: SheetRow, templateId: string): RenderedCaption {
    // 指定があればそのテンプレート、無ければ前回使ったもの（それも無ければ最初に見つかったもの）
    const fallback = this.templates.get(this.config.template) ?? this.templates.get(this.templates.list()[0]?.id ?? '');
    const template = templateId ? this.templates.get(templateId) : fallback;
    if (!template) throw new Error(`テンプレート「${templateId || this.config.template}」が見つかりません。`);
    return this.renderer.render(toCaptionModel(row), template);
  }

  // ---- テンプレートの編集 --------------------------------------------------

  /** テンプレートを構成するファイルの中身（編集画面の初期値）。 */
  templateFiles(templateId: string): TemplateFiles {
    const template = this.templates.get(templateId);
    if (!template) throw new Error(`テンプレート「${templateId}」が見つかりません。`);
    return readTemplateFiles(template.dir);
  }

  private checkFiles(files: TemplateFiles): Template {
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const clean: TemplateFiles = {
      json: text(files?.json),
      svg: text(files?.svg),
      html: text(files?.html) || null,
      css: text(files?.css) || null,
    };
    // template.svg には画像を埋め込めるため、ほかのファイルより上限を大きくしている
    const tooLarge = (value: string | null, limit: number) => (value?.length ?? 0) > limit;
    if (tooLarge(clean.svg, 40_000_000) || [clean.json, clean.html, clean.css].some((value) => tooLarge(value, 20_000_000))) {
      throw new TemplateError('テンプレートのファイルが大きすぎます。埋め込む画像を小さくしてください。');
    }
    return parseTemplate(clean);
  }

  /**
   * 保存前の編集内容でプレビューする。
   * SVG（PDF・PNGの元になる）と、HTML出力で実際に書き出されるコード一式を返す。
   */
  previewTemplate(row: SheetRow, files: TemplateFiles): { svg: string; html: string; warnings: RenderWarning[] } {
    const caption = this.renderer.render(toCaptionModel(row ?? {}), this.checkFiles(files));
    return { svg: caption.svg, html: this.renderer.toHtml([caption]), warnings: caption.warnings };
  }

  /**
   * テンプレートを data/templates/<id>/ へ保存する（画面での編集・新規作成・インポート共通）。
   * 同梱のサンプルと同じ id で保存した場合は、data/templates 側が優先して使われる。
   */
  saveTemplate(files: TemplateFiles) {
    const template = this.checkFiles(files);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(template.id)) {
      throw new TemplateError('template.json の "id" は、半角英数字・ハイフン・アンダースコアで指定してください。');
    }
    const dir = join(this.paths.dataDir, 'templates', template.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, TEMPLATE_FILE_NAMES.json), files.json);
    writeFileSync(join(dir, TEMPLATE_FILE_NAMES.svg), files.svg);
    for (const key of ['html', 'css'] as const) {
      const path = join(dir, TEMPLATE_FILE_NAMES[key]);
      if (template[key] !== null) writeFileSync(path, template[key]);
      else rmSync(path, { force: true });
    }
    saveConfig(this.paths, { template: template.id });
    this.config = { ...this.config, template: template.id };
    return { ...this.state(), saved: template.id };
  }

  preview(row: SheetRow, templateId: string): { svg: string; warnings: RenderWarning[] } {
    const caption = this.render(row, templateId);
    return { svg: caption.svg, warnings: caption.warnings };
  }

  /** 選択した行を出力フォルダへ書き出す。個別ファイルを正とし、必要なら1ファイルにまとめたものも作る。 */
  async output(
    rows: SheetRow[],
    formats: OutputFormat[],
    templateId: string,
    combined: boolean,
    embedFonts = false,
  ): Promise<OutputResult> {
    const wanted = [...new Set(formats ?? [])];
    if (wanted.length === 0 || wanted.some((format) => !OUTPUT_FORMATS.includes(format))) {
      throw new Error('出力形式を1つ以上選択してください。');
    }
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('出力する行を選択してください。');

    const directory = this.paths.outputDir;
    mkdirSync(directory, { recursive: true });
    const result: OutputResult = { directory, files: [], warnings: [], notes: [] };
    const notEmbedded = new Set<string>();
    // フォントの埋め込み: PDFは常に埋め込む。SVGは文字を輪郭にし、HTMLはフォントファイルを内包する
    const content = async (caption: RenderedCaption, format: OutputFormat): Promise<Buffer> => {
      if (embedFonts && format === 'svg') return Buffer.from(this.renderer.outlinedSvg(caption), 'utf8');
      if (embedFonts && format === 'html') {
        const embedded = this.renderer.toHtmlEmbedded([caption]);
        embedded.notEmbedded.forEach((family) => notEmbedded.add(family));
        return Buffer.from(embedded.html, 'utf8');
      }
      return this.renderer.output(caption, format);
    };
    const captions: RenderedCaption[] = [];

    for (const row of rows) {
      const caption = this.render(row, templateId);
      captions.push(caption);
      for (const format of wanted) {
        const fileName = buildFileName(caption.model, format);
        writeFileSync(join(directory, fileName), await content(caption, format));
        result.files.push(fileName);
      }
      const messages = caption.warnings.filter((w) => w.level === 'warning').map((w) => w.message);
      if (messages.length > 0) result.warnings.push({ no: caption.model.no, title: caption.model.title, messages });
    }

    if (combined) {
      if (wanted.includes('pdf')) {
        writeFileSync(join(directory, 'captions-all.pdf'), await this.renderer.toPdf(captions, { title: 'Captions' }));
        result.files.push('captions-all.pdf');
      }
      if (wanted.includes('html')) {
        const embedded = embedFonts ? this.renderer.toHtmlEmbedded(captions, { title: 'Captions' }) : null;
        embedded?.notEmbedded.forEach((family) => notEmbedded.add(family));
        writeFileSync(
          join(directory, 'captions-all.html'),
          embedded?.html ?? this.renderer.toHtml(captions, { title: 'Captions' }),
        );
        result.files.push('captions-all.html');
      }
    }
    if (notEmbedded.size > 0) {
      result.notes.push(
        `フォント「${[...notEmbedded].join('」「')}」のファイルを読み込めなかったため、HTMLへ内包できませんでした。`,
      );
    }
    if (templateId && templateId !== this.config.template && this.templates.get(templateId)) {
      saveConfig(this.paths, { template: templateId });
      this.config = { ...this.config, template: templateId };
    }
    return result;
  }
}
