// Entry point for Vercel: the same Express app as on a normal server, built by `npm run build` (dist/).
// Every request that is not a static file is rewritten to this function (see vercel.json).
const { createServer } = require('../dist/server');
const { configStorage } = require('../dist/storage/configStore');
const { startSourceBlockStore } = require('../dist/storage/sourceBlockStore');
const { startDownloadFailureStore } = require('../dist/storage/downloadFailureStore');
const { keepAlive } = require('../dist/utils/background');

const app = createServer();

// The start-up work of src/index.ts. It runs INSIDE a request, never at load time: the instance is frozen between
// requests, and a connection started in the background at load time can sit frozen for a minute and then time out.
let storage = null;
let backgroundStarted = false;

function ready() {
  if (!storage) {
    storage = configStorage.initialize().catch(() => { storage = null; });
  }
  return storage;
}

module.exports = async (req, res) => {
  // the first requests wait for the database to be connected (a few hundred ms); if it cannot be, the app answers
  // with its own error and the next request tries again
  await ready();
  if (!backgroundStarted) {
    backgroundStarted = true;
    keepAlive(startSourceBlockStore().catch(() => undefined));
    keepAlive(startDownloadFailureStore().catch(() => undefined));
  }
  return app(req, res);
};
