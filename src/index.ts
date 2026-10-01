import { createServer } from './server';
import { ENV } from './config/env';
import { APP_NAME, APP_VERSION } from './config/version';
import { Logger } from './utils/logger';
import { configStorage } from './storage/configStore';
import { warmUpAlignWorker } from './core/alignPool';
import { startSourceBlockStore } from './storage/sourceBlockStore';

async function bootstrap(): Promise<void> {
  try {
    await configStorage.initialize();
  } catch (err) {
    Logger.error('Storage initialization warning:', err);
  }

  // the sources refusing this server are remembered across restarts (before the first request is answered)
  await startSourceBlockStore();

  const app = createServer();

  app.listen(ENV.PORT, ENV.HOST, () => {
    Logger.info(`🚀 ${APP_NAME} v${APP_VERSION} listening on http://${ENV.HOST}:${ENV.PORT}`);
    Logger.info(`👉 Configure UI: http://localhost:${ENV.PORT}/configure`);
    Logger.info(`👉 Manifest: http://localhost:${ENV.PORT}/manifest.json`);
    warmUpAlignWorker();
  });
}

bootstrap().catch(err => {
  Logger.error('Failed to start server bootstrap', err);
  process.exit(1);
});
