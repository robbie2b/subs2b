import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import QRCode from 'qrcode';

import { ENV } from './config/env';
import { APP_NAME, APP_VERSION, USER_AGENT } from './config/version';
import { StremioManifest } from './types/stremio';
import { DEFAULT_USER_CONFIG, decodeUserConfigAsync, mergeWithDefaults } from './config/userConfig';
import {
  handleOpenSubtitlesRestDownload,
  handleRegieLiveDownload,
  handleUnifiedSubtitleProxy,
  handleVttConvert
} from './proxy/subtitleProxy';
import { globalSubtitleCache } from './utils/cache';
import { Logger, getLogLines } from './utils/logger';
import { configStorage, isUuid } from './storage/configStore';
import { parseSubtitleQuery, getAggregatedSubtitles } from './core/aggregator';
import { SUPPORTED_LANGUAGES } from './utils/languages';
import { getDebug } from './utils/debugLog';
import { getUsage, getProviderStats } from './storage/usageStore';
import { createAlignedHandler, createFallbackHandler } from './proxy/alignedProxy';
import { databaseActivity } from './storage/dbTools';
import { probeSite, probeAllowed, PROBE_HOSTS } from './proxy/siteProbe';
import { getAlignments } from './core/alignment';
import { REGIELIVE_SEARCH_URL, regieLiveHeaders } from './providers/regielive';

interface KeyValidation {
  valid: boolean;
  error?: string;
}

const KEY_VALIDATORS: Record<string, (apiKey: string) => Promise<KeyValidation>> = {
  // The key is optional for RegieLive (a shared one is used without it); a personal key is checked with one small search
  async regielive(apiKey) {
    try {
      const res = await axios.get(REGIELIVE_SEARCH_URL, {
        params: { nume: 'Friends', sezon: 1, episod: 1 },
        headers: regieLiveHeaders(apiKey),
        timeout: 8000,
        validateStatus: () => true
      });
      if (res.status === 200 && res.data && typeof res.data === 'object' && res.data.rezultate) return { valid: true };
      if (res.status === 403 || res.status === 401) return { valid: false, error: 'RegieLive did not accept this key.' };
      return { valid: false, error: `RegieLive answered HTTP ${res.status}.` };
    } catch (err: any) {
      return { valid: false, error: `Could not reach RegieLive: ${err?.code || err?.message || 'error'}.` };
    }
  },

  async opensubtitles(apiKey) {
    if (apiKey.length < 16) {
      return { valid: false, error: 'The OpenSubtitles key looks invalid or incomplete.' };
    }
    try {
      await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
        params: { imdb_id: '0133093', _t: Date.now() },
        headers: { 'Api-Key': apiKey, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
        timeout: 6000
      });
      return { valid: true };
    } catch (err: any) {
      Logger.warn(`OpenSubtitles key validation failed: ${err.response?.status ?? ''} ${err.message}`);
      const status = err.response?.status;
      return {
        valid: false,
        error: status === 403 || status === 401
          ? 'Key not authorized or unknown to OpenSubtitles. Check that you enabled "Under development" for the key on OpenSubtitles.com.'
          : 'Could not communicate with OpenSubtitles.'
      };
    }
  },

  async subdl(apiKey) {
    try {
      const response = await axios.get('https://api.subdl.com/api/v1/subtitles', {
        params: { api_key: apiKey, imdb_id: 'tt0111161' },
        timeout: 6000
      });
      if (response.status === 200 && response.data?.status !== false) {
        return { valid: true };
      }
      return { valid: false, error: response.data?.error || 'Invalid SubDL key.' };
    } catch {
      return { valid: false, error: 'Invalid SubDL key or connection error.' };
    }
  },

  async subsource(apiKey) {
    if (apiKey.length < 6) {
      return { valid: false, error: 'Invalid API key.' };
    }
    try {
      await axios.get('https://api.subsource.net/api/v1/subtitles/search?imdb=tt0111161', {
        headers: { 'X-API-Key': apiKey, 'Referer': 'https://subsource.net/' },
        timeout: 6000
      });
      return { valid: true };
    } catch {
      // The Subsource endpoint is unreliable for validation: a plausible-looking key is accepted
      return apiKey.length >= 8 ? { valid: true } : { valid: false, error: 'Invalid API key.' };
    }
  }
};

export function createServer(): express.Application {
  const app = express();

  // Render (and most hosts) sit behind a reverse proxy: needed for correct client IPs / rate limiting
  app.set('trust proxy', 1);

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const subtitlesLimiter = rateLimit({
    windowMs: ENV.RATE_LIMIT_WINDOW_MS,
    max: ENV.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
  });

  // The configuration API triggers outbound calls (key validation, manifest checks), so it is limited too
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
  }));

  const getBaseUrl = (req: Request): string => {
    if (ENV.BASE_URL && ENV.BASE_URL.trim() !== '') {
      return ENV.BASE_URL.replace(/\/+$/, '');
    }
    const host = req.get('host') || `localhost:${ENV.PORT}`;
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    return `${protocol}://${host}`;
  };

  const buildManifest = async (configEncoded?: string): Promise<StremioManifest> => {
    let name = DEFAULT_USER_CONFIG.instanceName as string;
    let description = 'Subtitle aggregator with automatic best-match scoring for Stremio and Nuvio.';
    let logo = DEFAULT_USER_CONFIG.instanceLogo as string;
    const version = APP_VERSION;

    if (configEncoded) {
      try {
        const userCfg = await decodeUserConfigAsync(configEncoded);
        name = userCfg.instanceName?.trim() || name;
        description = userCfg.instanceDesc?.trim() || description;
        logo = userCfg.instanceLogo?.trim() || logo;
      } catch {
        // Use default branding on decode failure
      }
    }

    return {
      id: 'org.subs2b.addon',
      version,
      name,
      description,
      logo,
      resources: [
        {
          name: 'subtitles',
          types: ['movie', 'series', 'anime', 'other'],
          idPrefixes: ['tt', 'kitsu'],
          // The player sends these so subtitles can be matched to the exact file being played
          extra: [
            { name: 'filename', isRequired: false },
            { name: 'videoHash', isRequired: false },
            { name: 'videoSize', isRequired: false }
          ]
        }
      ],
      types: ['movie', 'series', 'anime', 'other'],
      catalogs: [],
      behaviorHints: {
        configurable: true,
        configurationRequired: false
      }
    };
  };

  const distPublic = path.join(__dirname, 'web', 'public');
  const srcPublic = path.join(__dirname, '..', 'src', 'web', 'public');
  const publicDir = fs.existsSync(distPublic) ? distPublic : srcPublic;
  app.use(express.static(publicDir));

  const healthHandler = (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      addon: APP_NAME,
      version: APP_VERSION,
      uptime: process.uptime(),
      cacheSize: globalSubtitleCache.size,
      nodeVersion: process.version
    });
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // The configuration page is also served under /<uuid>/..., so relative asset links resolve there too
  app.use('/:config', (req: Request, res: Response, next: NextFunction) => {
    if (['manifest.json', 'subtitles', 'api', 'sub', 'proxy', 'health', 'assets'].includes(req.params.config)) {
      return next();
    }
    return express.static(publicDir, { index: false })(req, res, next);
  });

  app.get('/api/languages', (_req: Request, res: Response) => {
    res.json({ languages: SUPPORTED_LANGUAGES });
  });

  app.post('/api/manifest/validate', async (req: Request, res: Response): Promise<void> => {
    let inputUrl = ((req.body?.url as string) || '').trim();
    if (!inputUrl) {
      res.status(400).json({ valid: false, error: 'The manifest URL cannot be empty.' });
      return;
    }

    inputUrl = inputUrl.replace(/^stremio:\/\//, 'https://');
    if (!inputUrl.toLowerCase().endsWith('/manifest.json')) {
      inputUrl = `${inputUrl.replace(/\/+$/, '')}/manifest.json`;
    }

    try {
      const response = await axios.get(inputUrl, {
        timeout: 8000,
        headers: { 'User-Agent': `${USER_AGENT} (Stremio Addon Validator)`, 'Accept': 'application/json' }
      });

      const manifest = response.data;
      if (!manifest || typeof manifest !== 'object') {
        res.status(400).json({ valid: false, error: 'The endpoint did not return a valid manifest JSON.' });
        return;
      }

      const declaredResources: string[] = Array.isArray(manifest.resources)
        ? manifest.resources.map((r: unknown) => {
          if (typeof r === 'string') return r;
          if (typeof r === 'object' && r !== null && 'name' in r) {
            return String((r as { name: string }).name);
          }
          return '';
        }).filter(Boolean)
        : [];

      if (!declaredResources.some(r => r.toLowerCase() === 'subtitles')) {
        res.status(400).json({
          valid: false,
          error: `The addon "${manifest.name || manifest.id || 'External'}" does not declare the 'subtitles' resource. Only addons that provide subtitles are supported.`
        });
        return;
      }

      const addonName = manifest.name && String(manifest.name).trim() !== ''
        ? String(manifest.name).trim()
        : (manifest.id ? String(manifest.id).trim() : 'External Subtitles Addon');

      const isConfigurable = Boolean(manifest.behaviorHints?.configurable || manifest.configurationURL);
      const configurationURL = manifest.configurationURL || (manifest.behaviorHints?.configurable ? inputUrl.replace(/\/manifest\.json$/i, '/configure') : '');

      res.json({
        valid: true,
        id: manifest.id || `custom-${Math.random().toString(36).substring(2, 9)}`,
        name: addonName,
        description: manifest.description || '',
        logo: manifest.logo || '',
        manifestUrl: inputUrl,
        resources: declaredResources,
        configurable: isConfigurable,
        configurationURL
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ valid: false, error: `Could not reach the manifest at "${inputUrl}": ${msg}` });
    }
  });

  app.get('/api/qrcode', async (req: Request, res: Response): Promise<void> => {
    const text = String(req.query.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'No text provided for the QR code.' });
      return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(text, {
        width: 220,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      res.json({ dataUrl });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Error generating the QR code: ${msg}` });
    }
  });

  app.post('/api/validate-key/:service', async (req: Request, res: Response): Promise<void> => {
    const service = (req.params.service || '').toLowerCase();
    const apiKey = (req.body?.apiKey as string || '').trim().replace(/^["']|["']$/g, '');

    if (!apiKey) {
      res.json({ valid: false, error: 'No key provided.' });
      return;
    }

    const validator = KEY_VALIDATORS[service];
    if (!validator) {
      res.status(400).json({ valid: false, error: 'Unknown service.' });
      return;
    }

    res.json(await validator(apiKey));
  });

  const handleConfigSave = async (req: Request, res: Response): Promise<void> => {
    const uuid = String(req.params?.uuid || req.body?.uuid || '').trim();
    const password = String(req.body?.password || '').trim();
    const config = req.body?.config;

    if (!uuid || !isUuid(uuid)) {
      res.status(400).json({ success: false, error: 'Invalid UUID.' });
      return;
    }

    if (!password) {
      res.status(400).json({ success: false, error: 'A password is required to save the configuration.' });
      return;
    }

    if (!config || typeof config !== 'object') {
      res.status(400).json({ success: false, error: 'Invalid configuration.' });
      return;
    }

    const saveResult = await configStorage.saveConfigAsync(uuid, password, mergeWithDefaults(config));
    if (!saveResult.success) {
      const isDbError = saveResult.error?.includes('Database write failed');
      res.status(isDbError ? 500 : 401).json({ success: false, error: saveResult.error || 'Could not save the configuration.' });
      return;
    }

    const manifestUrl = `${getBaseUrl(req)}/${uuid}/manifest.json`;

    res.status(200).json({
      success: true,
      uuid,
      manifestUrl,
      stremioUrl: `stremio://${manifestUrl.replace(/^https?:\/\//i, '')}`,
      stremioWebUrl: `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`
    });
  };

  app.post(['/api/config/save', '/api/config/create', '/api/save'], handleConfigSave);
  app.put('/api/config/:uuid', handleConfigSave);

  app.post('/api/config/load', async (req: Request, res: Response): Promise<void> => {
    const uuid = String(req.body?.uuid || '').trim();
    const password = String(req.body?.password || '').trim();

    if (!uuid || !isUuid(uuid) || !password) {
      res.status(401).json({ success: false, error: 'Invalid UUID or password.' });
      return;
    }

    const authResult = await configStorage.authenticateAndGetConfigAsync(uuid, password);
    if (!authResult.success || !authResult.config) {
      res.status(401).json({ success: false, error: 'Invalid UUID or password.' });
      return;
    }

    res.status(200).json({ success: true, uuid, config: authResult.config });
  });

  app.get(['/', '/configure', '/dashboard', '/:config/configure'], (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.get('/manifest.json', async (_req: Request, res: Response) => {
    res.json(await buildManifest());
  });

  app.get('/:config/manifest.json', async (req: Request, res: Response) => {
    res.json(await buildManifest(req.params.config));
  });

  const handleSubtitles = async (req: Request, res: Response): Promise<void> => {
    try {
      const configParam = req.params.config;
      const userConfig = await decodeUserConfigAsync(configParam);
      const { type, id, extra } = req.params;

      // Merge the query string with the arguments Stremio puts in the path (":extra", e.g. filename=...&videoHash=...)
      const extraArgs: Record<string, string> = { ...(req.query as Record<string, string>) };
      if (extra) {
        for (const [key, value] of new URLSearchParams(extra).entries()) {
          extraArgs[key] = value;
        }
      }

      const query = parseSubtitleQuery(type, id, extraArgs);
      const debugKey = configParam && isUuid(configParam) ? configParam : undefined;
      const response = await getAggregatedSubtitles(query, userConfig, getBaseUrl(req), debugKey);

      res.setHeader('Cache-Control', 'max-age=1800, public');
      res.json(response);
    } catch (err: unknown) {
      Logger.error('Failed to handle subtitles request', err);
      res.json({ subtitles: [] });
    }
  };

  app.get(['/:config/subtitles/:type/:id.json', '/subtitles/:type/:id.json'], subtitlesLimiter, handleSubtitles);
  app.get(['/:config/subtitles/:type/:id/:extra.json', '/subtitles/:type/:id/:extra.json'], subtitlesLimiter, handleSubtitles);

  // ---- Diagnostics: only reachable with the UUID of a stored configuration (which is already the addon's credential) ----
  const requireStoredConfig = async (req: Request, res: Response): Promise<string | null> => {
    const key = req.params.config;
    if (!key || !isUuid(key) || !(await configStorage.getConfigByUuidAsync(key))) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    return key;
  };

  // Latest requests and how their subtitles were scored
  app.get('/:config/debug/recent.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ entries: getDebug(key) });
  });

  // When the addon is used: counts per weekday/hour plus the latest requests
  app.get('/:config/debug/usage.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(await getUsage(key, typeof req.query.tz === 'string' ? req.query.tz : undefined));
  });

  // Per-provider status: response times, success rate and how often each one supplies the best subtitles
  app.get('/:config/debug/providers.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(await getProviderStats(key));
  });

  // What the automatic re-timing decided lately
  app.get('/:config/debug/alignments.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ entries: await getAlignments(key) });
  });

  // What the database is doing: sessions running or waiting (and who blocks whom), which tables exist, the pool
  app.get('/:config/debug/db.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;
    res.setHeader('Cache-Control', 'no-store');
    const pool = await configStorage.getPool();
    if (!pool) {
      res.json({ database: false });
      return;
    }
    try {
      res.json({ database: true, ...(await databaseActivity(pool) as object) });
    } catch (err: unknown) {
      res.status(500).json({ database: true, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // A page of a subtitle site being considered as a new source, fetched from this server (only those sites)
  app.get('/:config/debug/probe.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;
    res.setHeader('Cache-Control', 'no-store');
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!probeAllowed(url)) {
      res.status(400).json({ error: 'only these sites can be probed', sites: PROBE_HOSTS });
      return;
    }
    const q = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
    res.json(await probeSite(url, {
      as: q('as') === 'addon' ? 'addon' : 'browser',
      referer: q('referer'),
      warm: q('warm'),
      form: q('form'),
      ajax: q('ajax') === '1'
    }));
  });

  // Live server log (poll with ?after=<last seq received>)
  app.get('/:config/debug/logs.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(getLogLines(parseInt(String(req.query.after || '0'), 10) || 0));
  });

  // Which OpenSubtitles subtitles exist for an exact file hash, in ALL languages
  app.get('/:config/debug/hash.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;

    const hash = String(req.query.hash || '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(hash)) {
      res.status(400).json({ error: 'hash must be 16 hex characters' });
      return;
    }
    const cfg = await decodeUserConfigAsync(key);
    const apiKey = cfg.providers.opensubtitles?.apiKey;
    if (!apiKey) {
      res.status(400).json({ error: 'OpenSubtitles key not configured' });
      return;
    }
    try {
      const params: Record<string, string | number> = { moviehash: hash };
      if (req.query.imdb) params.imdb_id = String(req.query.imdb).replace(/^tt/i, '');
      const r = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
        params,
        headers: { 'Api-Key': apiKey, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
        timeout: 10000
      });
      const data = Array.isArray(r.data?.data) ? r.data.data : [];
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        hash,
        total: r.data?.total_count ?? data.length,
        results: data.map((d: any) => ({
          lang: d.attributes?.language,
          release: d.attributes?.release,
          moviehash_match: d.attributes?.moviehash_match === true,
          fps: d.attributes?.fps,
          hearing_impaired: d.attributes?.hearing_impaired === true,
          downloads: d.attributes?.download_count
        }))
      });
    } catch (err: any) {
      res.status(502).json({ error: err.response?.status ? 'HTTP ' + err.response.status : String(err.message) });
    }
  });

  // The same search a player would trigger, for another language (used by offline sync experiments)
  app.get('/:config/debug/search.json', async (req: Request, res: Response): Promise<void> => {
    const key = await requireStoredConfig(req, res);
    if (!key) return;

    const lang = String(req.query.lang || '').toLowerCase();
    const id = String(req.query.id || '');
    const type = String(req.query.type || 'movie');
    if (!/^[a-z]{3}$/.test(lang) || !id) {
      res.status(400).json({ error: 'lang (3 letters) and id are required' });
      return;
    }
    const extra: Record<string, string> = {};
    for (const name of ['filename', 'videoHash', 'videoSize']) {
      if (typeof req.query[name] === 'string') extra[name] = req.query[name] as string;
    }
    const baseConfig = await decodeUserConfigAsync(key);
    const overridden = { ...baseConfig, languages: [lang], language_remapping: {}, languageRemap: {}, maxSubtitles: 0 };
    const response = await getAggregatedSubtitles(parseSubtitleQuery(type, id, extra), overridden, getBaseUrl(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json(response);
  });

  // ---- Subtitle download endpoints (the URLs handed to the player) ----
  // /sub/proxy?url=...  generic proxy for SubDL / Subsource (allowed sites only)
  // /sub/proxy/:data and /proxy/subtitle/:data  legacy links with a base64 URL
  app.get(['/sub/proxy', '/sub/proxy/:data', '/proxy/subtitle/:data'], handleUnifiedSubtitleProxy);
  app.get('/proxy/download/os-rest/:fileId', handleOpenSubtitlesRestDownload);
  app.get('/proxy/download/regielive/:data', handleRegieLiveDownload);
  app.get(['/:config/sub/convert/:data.srt', '/:config/sub/convert.srt'], subtitlesLimiter, handleVttConvert);
  app.get('/:config/sub/aligned/:data.srt', subtitlesLimiter, createAlignedHandler(getBaseUrl));
  // a subtitle offered by several providers: the sources are tried in order
  app.get('/:config/sub/fallback/:data.srt', subtitlesLimiter, createFallbackHandler(getBaseUrl));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found', path: req.path });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    Logger.error('Unhandled server exception', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
