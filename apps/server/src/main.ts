import { MigrationRequiredError } from '../../../packages/database/index.ts';
import { createApp } from './app.ts';
import { resolvePaths } from './config.ts';
import { CaptionService } from './service.ts';

async function main(): Promise<void> {
  const paths = resolvePaths();
  let service: CaptionService;
  try {
    service = new CaptionService(paths);
  } catch (error) {
    if (error instanceof MigrationRequiredError) {
      console.error(error.message);
      console.error('バックアップを取得したうえで `npm run migrate` を実行してください。');
      process.exit(1);
    }
    throw error;
  }

  const app = createApp(service);
  const { host } = service.config.server;
  const port = await app.listen();
  const event = service.currentEvent();

  console.log('LABELSystem caption server');
  console.log(`  管理画面 : http://${host}:${port}/`);
  console.log(`  イベント : ${event.name}`);
  console.log(`  データ   : ${paths.dataDir}`);
  console.log(`  出力先   : ${paths.outputDir}`);
  const { url, autoSyncMinutes } = service.config.sheet;
  if (url && autoSyncMinutes > 0) {
    console.log(`  シート同期: ${autoSyncMinutes}分ごと`);
    const sync = () => {
      service
        .syncSheet()
        .then((r) => {
          if (r.created > 0) console.log(`[sheet] ${r.created}件を取り込みました。`);
        })
        .catch((error: Error) => console.warn(`[sheet] ${error.message}`));
    };
    sync();
    setInterval(sync, autoSyncMinutes * 60_000).unref();
  }
  console.log('終了するには Ctrl+C を押してください。');

  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error((error as Error).message ?? error);
  process.exit(1);
});
