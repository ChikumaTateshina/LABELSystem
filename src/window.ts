/**
 * アプリのウィンドウ。
 *
 * OSに標準で入っている Edge（無ければ Chrome）を、タブもアドレスバーも無い「アプリモード」で起動し、
 * 画面（HTML）の表示だけに使う。画面と本体のやり取りは、起動したウィンドウとの間のパイプ
 * （Chrome DevTools Protocol）で行うため、サーバを立てたりポートを開いたりはしない。
 *
 *   画面 → 本体 : window.labelSend(JSON)       （Runtime.addBinding）
 *   本体 → 画面 : window.__labelReceive(JSON)  （Runtime.evaluate）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const BINDING = 'labelSend';

/** 画面からの呼び出しを処理する関数。戻り値が画面へ返る。 */
export type Handler = (method: string, params: unknown) => Promise<unknown>;

export function findBrowser(): string | null {
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].flatMap((base) =>
          base
            ? [
                join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
              ]
            : [],
        )
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((path) => existsSync(path)) ?? null;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

/** パイプ上のプロトコル: JSON を NUL 文字で区切って送受信する。 */
class Pipe {
  private nextId = 1;
  private buffer = '';
  private readonly waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly output: Writable,
    input: Readable,
    private readonly onEvent: (message: Message) => void,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, end)) as Message;
        this.buffer = this.buffer.slice(end + 1);
        const waiter = message.id !== undefined ? this.waiting.get(message.id) : undefined;
        if (waiter) {
          this.waiting.delete(message.id!);
          if (message.error) waiter.reject(new Error(message.error.message));
          else waiter.resolve(message.result ?? {});
        } else if (message.method) {
          this.onEvent(message);
        }
      }
    });
    output.on('error', () => undefined);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.output.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
}

export interface WindowOptions {
  /** 画面のHTMLファイル */
  page: string;
  /** ウィンドウ専用のプロファイル置き場（普段使いのブラウザとは分離される） */
  profileDir: string;
  handler: Handler;
  /** ウィンドウが閉じられたときに呼ばれる */
  onClose: () => void;
}

export async function openWindow(options: WindowOptions): Promise<void> {
  const browser = findBrowser();
  if (!browser) throw new Error('画面の表示に必要な Microsoft Edge（または Google Chrome）が見つかりません。');

  const pageUrl = pathToFileURL(options.page).href;
  const child: ChildProcess = spawn(
    browser,
    [
      `--app=${pageUrl}`,
      `--user-data-dir=${options.profileDir}`,
      '--remote-debugging-pipe',
      '--window-size=1280,860',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--disable-sync',
      '--disable-extensions',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    child.kill();
    options.onClose();
  };
  child.on('exit', close);
  child.on('error', close);

  let sessionId = '';
  let targetId = '';
  let currentUrl = pageUrl;

  const pipe = new Pipe(child.stdio[3] as Writable, child.stdio[4] as Readable, (message) => {
    const params = message.params ?? {};
    if (message.method === 'Target.targetDestroyed' && params.targetId === targetId) {
      void pipe.send('Browser.close').catch(() => undefined);
      close();
    } else if (message.method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string; url: string };
      if (!frame.parentId) currentUrl = frame.url;
    } else if (message.method === 'Runtime.bindingCalled' && params.name === BINDING) {
      // 画面が別のページへ移動してしまった場合、そのページからの呼び出しには応じない
      if (currentUrl.split('#')[0] !== pageUrl) return;
      void answer(String(params.payload));
    }
  });

  const answer = async (payload: string): Promise<void> => {
    let id = 0;
    let reply: Record<string, unknown>;
    try {
      const request = JSON.parse(payload) as { id: number; method: string; params: unknown };
      id = request.id;
      reply = { id, result: (await options.handler(request.method, request.params)) ?? null };
    } catch (error) {
      reply = { id, error: (error as Error).message || String(error) };
    }
    const expression = `window.__labelReceive(${JSON.stringify(JSON.stringify(reply))})`;
    await pipe.send('Runtime.evaluate', { expression }, sessionId).catch(() => undefined);
  };

  // 起動したウィンドウ（ページ）を見つけて接続する
  const targets = (await pipe.send('Target.getTargets')).targetInfos as { targetId: string; type: string }[];
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('ウィンドウを開けませんでした。');
  targetId = page.targetId;
  sessionId = (await pipe.send('Target.attachToTarget', { targetId, flatten: true })).sessionId as string;
  await pipe.send('Target.setDiscoverTargets', { discover: true });
  await pipe.send('Page.enable', {}, sessionId);
  await pipe.send('Runtime.enable', {}, sessionId);
  await pipe.send('Runtime.addBinding', { name: BINDING }, sessionId);
}
