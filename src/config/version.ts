import fs from 'fs';
import path from 'path';

/** Application name and version, used by the manifest, health check, web interface and outgoing User-Agent headers */
export const APP_NAME = 'subs2b';

/** The version is read from package.json, so bumping it there (npm version) is the only place to change */
function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // fall through
  }
  return '0.0.0';
}

export const APP_VERSION = readVersion();
export const USER_AGENT = `${APP_NAME} v${APP_VERSION}`;
