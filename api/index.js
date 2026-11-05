// Entry point for Vercel: the same Express app as on a normal server, built by `npm run build` (dist/).
// Every request that is not a static file is rewritten to this function (see vercel.json).
const { createServer } = require('../dist/server');
const { configStorage } = require('../dist/storage/configStore');
const { startSourceBlockStore } = require('../dist/storage/sourceBlockStore');
const { startDownloadFailureStore } = require('../dist/storage/downloadFailureStore');

const app = createServer();

// The start-up work of src/index.ts, in the background (the first request does not wait for it; storage waits for
// itself when it is needed)
void configStorage.initialize().catch(() => undefined);
void startSourceBlockStore().catch(() => undefined);
void startDownloadFailureStore().catch(() => undefined);

module.exports = app;
