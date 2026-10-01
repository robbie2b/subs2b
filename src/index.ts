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

  const app = createServer();

  app.listen(ENV.PORT, ENV.HOST, () => {
    Logger.info(`🚀 ${APP_NAME} v${APP_VERSION} listening on http://${ENV.HOST}:${ENV.PORT}`);
    Logger.info(`👉 Configure UI: http://localhost:${ENV.PORT}/configure`);
    Logger.info(`👉 Manifest: http://localhost:${ENV.PORT}/manifest.json`);
    warmUpAlignWorker();
    // the sources refusing this server are remembered across restarts; read in the background, so the database can
    // never keep the server from starting (Render only switches to a new version once it answers)
    void Promise.race([
      startSourceBlockStore(),
      new Promise<void>(resolve => setTimeout(() => { Logger.warn('[SOURCES] the saved source blocks were not read within 5 s, going on without them'); resolve(); }, 5000).unref())
    ]);
  });
}

bootstrap().catch(err => {
  Logger.error('Failed to start server bootstrap', err);
  process.exit(1);
});
