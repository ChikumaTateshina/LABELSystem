import type { NewRow, SheetRow } from './types.ts';

/** スプレッドシート（GASウェブアプリ）との通信・応答に関するエラー */
export class SheetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SheetSettings {
  /** GASウェブアプリのURL（https://script.google.com/macros/s/…/exec） */
  url: string;
  /** gas/Code.gs の setup() が発行したトークン */
  token: string;
}

export interface AppendResult {
  added: SheetRow[];
  skipped: { index: number; reason: string; existing?: SheetRow }[];
}

type Response<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/**
 * スプレッドシートの読み取りと追記。exe とブラウザ拡張の両方から使う（Node / ブラウザ共通のAPIのみ使用）。
 * トークンはリクエスト本文に入れ、URLには含めない。
 */
export class SheetClient {
  private readonly url: URL;

  constructor(
    private readonly settings: SheetSettings,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    try {
      this.url = new URL(settings.url);
    } catch {
      throw new SheetError('bad-url', 'ウェブアプリのURLが正しくありません。');
    }
    const local = ['127.0.0.1', 'localhost'].includes(this.url.hostname);
    if (this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && local)) {
      throw new SheetError('bad-url', 'ウェブアプリのURLは https:// で始まる必要があります。');
    }
    if (!settings.token) throw new SheetError('bad-token', 'トークンを入力してください。');
  }

  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    let text: string;
    try {
      // GASは302でリダイレクトするため follow が必要。text/plain にすることで事前確認（プリフライト）を避ける
      const response = await this.fetcher(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...payload, token: this.settings.token, action }),
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
    } catch (error) {
      throw new SheetError(
        'network',
        `スプレッドシートへ接続できません（${(error as Error).message}）。ネットワークとURLを確認してください。`,
      );
    }

    let body: Response<T>;
    try {
      body = JSON.parse(text) as Response<T>;
    } catch {
      throw new SheetError(
        'bad-response',
        'スプレッドシートから想定外の応答が返されました。ウェブアプリのURL（末尾が /exec）と、アクセスできるユーザーが「全員」になっているかを確認してください。',
      );
    }
    if (body.ok) return body.data;

    const { code, message } = body.error ?? { code: 'internal', message: '不明なエラー' };
    if (code === 'unauthorized') throw new SheetError(code, 'トークンが一致しません。設定を確認してください。');
    if (code === 'unknown-action') {
      throw new SheetError(code, 'スプレッドシート側のスクリプトが古い形式です。gas/Code.gs を貼り直して再デプロイしてください。');
    }
    throw new SheetError(code, message);
  }

  /** 接続・トークン・シートの見出しを確認する。 */
  async ping(): Promise<void> {
    await this.call('ping');
  }

  async list(): Promise<SheetRow[]> {
    return (await this.call<{ rows: SheetRow[] }>('list')).rows;
  }

  /** 元投稿URLから登録済みの行を探す。 */
  async find(postUrl: string): Promise<SheetRow | null> {
    return (await this.call<{ row: SheetRow | null }>('find', { postUrl })).row;
  }

  /** 行を末尾へ追加する。No. の採番と重複判定はシート側で行う。 */
  append(rows: NewRow[]): Promise<AppendResult> {
    return this.call<AppendResult>('append', { rows });
  }
}
