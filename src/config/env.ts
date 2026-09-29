import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  PORT: parseInt(process.env.PORT || '7000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  // Public URL of the addon (only needed when it cannot be detected from the request)
  BASE_URL: process.env.BASE_URL || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  DATA_DIR: process.env.DATA_DIR || '',
  // Optional relay (e.g. a Cloudflare Worker) for the Subs.ro API, for hosts whose IP Subs.ro blocks
  SUBSRO_PROXY_URL: (process.env.SUBSRO_PROXY_URL || '').replace(/\/+$/, ''),
  SUBSRO_PROXY_TOKEN: process.env.SUBSRO_PROXY_TOKEN || '',
  // "parallel" (default): OpenSubtitles addons run together with the direct integration.
  // "fallback": they run only if the direct integration fails.
  OPENSUBTITLES_ADDON_MODE: (process.env.OPENSUBTITLES_ADDON_MODE || 'parallel').trim().toLowerCase() === 'fallback' ? 'fallback' : 'parallel',
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '150', 10)
};
