import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { OUTPUT_FORMATS, type OutputFormat } from '../../../packages/renderer/index.ts';
import { ENTRY_STATUSES, type EntryStatus, type SourcePost } from '../../../packages/shared-types/index.ts';
import { CaptionService, HttpError } from './service.ts';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<Record<string, unknown>>;
}

type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Content-Type は application/json を指定してください。');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'リクエストが大きすぎます。');
    chunks.push(chunk as Buffer);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not an object');
    return data as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'リクエストボディをJSONとして解析できません。');
  }
}

/** ブラウザ拡張（chrome-extension:// / moz-extension://）からのアクセスのみCORSを許可する。 */
function isExtensionOrigin(origin: string): boolean {
  return /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

function isLocalHost(host: string | undefined): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host ?? '');
}

function contentDisposition(fileName: string, download: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface App {
  service: CaptionService;
  server: Server;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export function createApp(service: CaptionService): App {
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/[.]/g, '\\.').replace(/:([A-Za-z]+)/g, (_, key: string) => {
          keys.push(key);
          return '([^/]+)';
        }) +
        '$',
    );
    routes.push({ method, pattern, keys, handler });
  };

  // ---- API（仕様 §19） --------------------------------------------------

  route('GET', '/api/health', ({ res }) => sendJson(res, 200, { ok: true, name: 'label-system' }));

  route('GET', '/api/config', ({ res }) => {
    const { event, caption, source } = service.config;
    sendJson(res, 200, {
      event,
      caption,
      source,
      outputDir: service.paths.outputDir,
      formats: OUTPUT_FORMATS,
      // URLとトークンは返さない（設定済みかどうかだけを伝える）
      sheet: { configured: Boolean(service.config.sheet.url), autoSyncMinutes: service.config.sheet.autoSyncMinutes },
      currentEventId: service.currentEvent().id,
    });
  });

  route('GET', '/api/events', ({ res }) => {
    const currentEventId = service.currentEvent().id;
    sendJson(res, 200, { events: service.events.list(), currentEventId });
  });
  route('POST', '/api/events', async ({ res, body }) => sendJson(res, 201, service.createEvent(await body())));
  route('PUT', '/api/events/:id', async ({ res, params, body }) =>
    sendJson(res, 200, service.updateEvent(params.id, await body())),
  );

  route('GET', '/api/templates', ({ res }) => sendJson(res, 200, { templates: service.templates.list() }));

  route('POST', '/api/parse', async ({ res, body }) => {
    const data = await body();
    const post = (data.post ?? data) as Partial<SourcePost>;
    sendJson(
      res,
      200,
      service.parseDraft({
        platform: typeof post.platform === 'string' ? post.platform : '',
        postId: typeof post.postId === 'string' ? post.postId : undefined,
        postUrl: typeof post.postUrl === 'string' ? post.postUrl : undefined,
        userDisplayName: typeof post.userDisplayName === 'string' ? post.userDisplayName : '',
        userId: typeof post.userId === 'string' ? post.userId : '',
        text: typeof post.text === 'string' ? post.text : '',
      }),
    );
  });

  route('GET', '/api/entries', ({ res, url }) => {
    const status = url.searchParams.get('status');
    const eventId = url.searchParams.get('eventId') ?? undefined;
    if (status && !ENTRY_STATUSES.includes(status as EntryStatus)) throw new HttpError(400, '不正なステータスです。');
    const entries = service.entries.list({ eventId, status: (status as EntryStatus) || undefined });
    sendJson(res, 200, { entries: entries.map((entry) => service.present(entry)) });
  });
  route('POST', '/api/entries', async ({ res, body }) => sendJson(res, 201, service.createEntry(await body())));
  route('GET', '/api/entries/by-post/:postId', ({ res, params }) => {
    const entry = service.entries.findByPostId(params.postId);
    if (!entry) throw new HttpError(404, 'この投稿は登録されていません。');
    sendJson(res, 200, service.present(entry));
  });
  route('GET', '/api/entries/:id', ({ res, params }) =>
    sendJson(res, 200, service.present(service.getEntry(params.id))),
  );
  route('PUT', '/api/entries/:id', async ({ res, params, body }) =>
    sendJson(res, 200, service.updateEntry(params.id, await body())),
  );
  route('DELETE', '/api/entries/:id', ({ res, params }) => {
    service.deleteEntry(params.id);
    res.writeHead(204).end();
  });

  // ---- プレビュー・出力 -------------------------------------------------

  route('POST', '/api/preview', async ({ res, body }) => sendJson(res, 200, service.preview(await body())));

  route('GET', '/api/entries/:id/caption.:format', async ({ res, params, url }) => {
    const format = params.format as OutputFormat;
    if (!OUTPUT_FORMATS.includes(format)) throw new HttpError(400, '未対応の出力形式です。');
    const output = await service.outputEntry(params.id, format, url.searchParams.get('template') ?? undefined);
    res.writeHead(200, {
      'Content-Type': output.contentType,
      'Content-Length': output.body.length,
      'Content-Disposition': contentDisposition(output.fileName, url.searchParams.has('download')),
      'Cache-Control': 'no-store',
      // HTML出力をこのオリジン上で開いても、スクリプトは実行させない
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      'X-Caption-Warnings': encodeURIComponent(JSON.stringify(output.warnings)),
    });
    res.end(output.body);
  });

  route('POST', '/api/export', async ({ res, body }) => {
    const data = await body();
    sendJson(
      res,
      200,
      await service.exportCaptions({
        eventId: typeof data.eventId === 'string' ? data.eventId : undefined,
        entryIds: Array.isArray(data.entryIds) ? data.entryIds.filter((id) => typeof id === 'string') : undefined,
        formats: (Array.isArray(data.formats) ? data.formats : ['pdf']) as OutputFormat[],
        templateId: typeof data.templateId === 'string' && data.templateId ? data.templateId : undefined,
        combined: data.combined === true,
      }),
    );
  });

  // ---- インポート・エクスポート・バックアップ ---------------------------

  route('GET', '/api/data/entries.:format', ({ res, params, url }) => {
    if (params.format !== 'json' && params.format !== 'csv') throw new HttpError(400, '未対応の形式です。');
    const text = service.exportData(params.format, url.searchParams.get('eventId') ?? undefined);
    res.writeHead(200, {
      'Content-Type': params.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': contentDisposition(`entries.${params.format}`, true),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  });

  route('POST', '/api/import', async ({ res, body }) => {
    const data = await body();
    if (typeof data.content !== 'string') throw new HttpError(400, 'content を指定してください。');
    sendJson(
      res,
      200,
      service.importEntries(
        String(data.format ?? 'json'),
        data.content,
        typeof data.eventId === 'string' ? data.eventId : undefined,
      ),
    );
  });

  route('POST', '/api/sheet/sync', async ({ res }) => sendJson(res, 200, await service.syncSheet()));

  route('POST', '/api/backup', ({ res }) => sendJson(res, 200, service.backup()));

  // ---- 管理UI（静的ファイル） -------------------------------------------

  const serveStatic = (res: ServerResponse, pathname: string): boolean => {
    const base = service.paths.adminWebDir;
    const file = normalize(join(base, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(readFileSync(file));
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DNSリバインディング対策: ローカルホスト名以外でのアクセスを拒否する
    if (!isLocalHost(req.headers.host)) throw new HttpError(403, 'このサーバはローカルからのみ利用できます。');

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const origin = req.headers.origin;
    if (origin) {
      if (isExtensionOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin');
      } else if (origin !== url.origin) {
        // 一般のWebサイトからローカルサーバを操作させない
        throw new HttpError(403, '許可されていないオリジンからのリクエストです。');
      }
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));
      await r.handler({ req, res, url, params, body: () => readJsonBody(req) });
      return;
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(res, url.pathname)) return;
    throw new HttpError(404, 'Not Found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, ...error.details });
      } else {
        console.error(error);
        sendJson(res, 500, { error: `内部エラーが発生しました: ${(error as Error).message}` });
      }
    });
  });

  return {
    service,
    server,
    listen: (port = service.config.server.port, host = service.config.server.host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          service.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
