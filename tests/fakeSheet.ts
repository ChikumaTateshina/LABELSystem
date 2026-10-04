/**
 * gas/Code.gs を、Googleのサービスを模したモック上で実行するテスト用ハーネス。
 *
 * 実際の Apps Script 環境の代わりに、スクリプトが使うAPI（SpreadsheetApp など）の最小限の実装を用意し、
 * ウェブアプリと同じ形（POST → 302 → GET）で応答するHTTPサーバとして公開する。
 * スプレッドシート特有の挙動も再現する:
 *   - 数字だけの文字列を書くと数値へ変換される（"007" → "7"）
 *   - 「=」「+」で始まる文字列は数式として解釈される
 *   - 先頭の「'」は文字列の印として消費される
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCRIPT_PATH = fileURLToPath(new URL('../gas/Code.gs', import.meta.url));

export const HEADERS = [
  'No.',
  'テーマ',
  '部門',
  'タイトル',
  'ユーザ名',
  'ユーザID',
  'コメント',
  '投稿日',
  '画像url(GoogleDrive)',
  '元投稿URL(Twitter)',
  '賞など',
  '備考',
];

export class FakeSheet {
  cells: string[][] = [];
  maxRows = 1000;
  frozenRows = 0;
  /** setValues / setValue で書き込まれたセル（「行,列」）。既存の行を書き換えていないことの確認に使う */
  writes: string[] = [];

  constructor(rows: string[][] = []) {
    this.cells = rows.map((row) => [...row]);
  }

  getLastRow(): number {
    for (let r = this.cells.length; r > 0; r--) if (this.cells[r - 1]?.some((c) => c !== '')) return r;
    return 0;
  }

  getLastColumn(): number {
    return this.cells.reduce((max, row) => {
      for (let c = row.length; c > max; c--) if (row[c - 1] !== '') return c;
      return max;
    }, 0);
  }

  getMaxRows(): number {
    return this.maxRows;
  }

  insertRowsAfter(_after: number, count: number): void {
    this.maxRows += count;
  }

  setFrozenRows(count: number): void {
    this.frozenRows = count;
  }

  private store(row: number, column: number, value: unknown): void {
    while (this.cells.length < row) this.cells.push([]);
    const cells = this.cells[row - 1];
    while (cells.length < column) cells.push('');
    let text = value === null || value === undefined ? '' : String(value);
    if (text.startsWith("'")) text = text.slice(1);
    else if (/^[=+]/.test(text)) text = '#FORMULA!';
    else if (/^-?\d+(\.\d+)?$/.test(text)) text = String(Number(text));
    cells[column - 1] = text;
    this.writes.push(`${row},${column}`);
  }

  getRange(row: number, column: number, numRows = 1, numColumns = 1) {
    if (row + numRows - 1 > this.maxRows) throw new Error('範囲がシートの行数を超えています。');
    return {
      getDisplayValues: (): string[][] =>
        Array.from({ length: numRows }, (_, r) =>
          Array.from({ length: numColumns }, (_, c) => this.cells[row - 1 + r]?.[column - 1 + c] ?? ''),
        ),
      setValues: (values: unknown[][]) => {
        values.forEach((cells, r) => cells.forEach((value, c) => this.store(row + r, column + c, value)));
      },
      setValue: (value: unknown) => this.store(row, column, value),
    };
  }
}

export interface FakeGas {
  url: string;
  token: string;
  sheet: FakeSheet;
  /** ウェブアプリが受け取ったリクエスト数 */
  requests: number;
  close(): Promise<void>;
}

/** rows: シートに最初から入っている内容（1行目は見出し）。省略すると空のシート。 */
export async function startFakeGas(rows: string[][] = []): Promise<FakeGas> {
  const sheet = new FakeSheet(rows);
  const properties = new Map<string, string>();
  const logs: string[] = [];

  const context = vm.createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, getSheets: () => [sheet] }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => properties.get(key) ?? null,
        setProperty: (key: string, value: string) => void properties.set(key, value),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => undefined, releaseLock: () => undefined }) },
    Utilities: { getUuid: () => randomUUID() },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }),
    },
    Logger: { log: (message: string) => void logs.push(String(message)) },
  });
  vm.runInContext(readFileSync(SCRIPT_PATH, 'utf8'), context, { filename: 'Code.gs' });

  // 利用者が行う初期設定と同じく setup() を実行し、ログに出たトークンを読み取る
  vm.runInContext('setup()', context);
  const token = /: ([0-9a-f]{64})$/.exec(logs[logs.length - 1] ?? '')?.[1];
  if (!token) throw new Error('setup() がトークンを出力しませんでした。');

  const pending = new Map<string, string>();
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/echo') {
      const body = pending.get(url.searchParams.get('id') ?? '');
      pending.delete(url.searchParams.get('id') ?? '');
      res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(body ?? '');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.requests++;
      const contents = Buffer.concat(chunks).toString('utf8');
      (context as { __event?: unknown }).__event = { postData: { contents }, parameter: {} };
      const output = vm.runInContext(req.method === 'POST' ? 'doPost(__event)' : 'doGet(__event)', context) as {
        text: string;
      };
      // 実際のウェブアプリと同じく、結果は別URLへのリダイレクトで返す
      const id = randomUUID();
      pending.set(id, output.text);
      res.writeHead(302, { Location: `/echo?id=${id}` });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/macros/s/test/exec`,
    token,
    sheet,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
