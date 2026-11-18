// A visitor must not be able to make the server fetch internal addresses (loopback, private networks, link-local
// metadata addresses): the manifest check, imported addons and the subtitle downloads only go to public ones.
import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';

process.env.DATABASE_URL = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-pub-'));
delete process.env.ALLOW_PRIVATE_HOSTS; // (the other tests serve from 127.0.0.1 and switch it on)
delete process.env.VERCEL;

import { isPrivateAddress, assertPublicUrl } from '../src/utils/publicUrl';
import { createServer } from '../src/server';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}
const refuses = async (url: string): Promise<boolean> => { try { await assertPublicUrl(url); return false; } catch { return true; } };

(async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    check(`${ip} is private`, isPrivateAddress(ip));
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111']) {
    check(`${ip} is public`, !isPrivateAddress(ip));
  }
  for (const url of ['http://localhost/manifest.json', 'http://127.0.0.1:8080/x', 'http://10.0.0.5/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://printer.local/x', 'http://db.internal/x', 'file:///etc/passwd', 'ftp://example.com/x', 'not a url']) {
    check(`refused: ${url}`, await refuses(url));
  }
  check('a public address is let through', !(await refuses('https://8.8.8.8/x')));
  check('a name that does not resolve is let through (the request fails by itself)', !(await refuses('https://this-name-does-not-exist.invalid/x')));

  // the manifest check on the real route
  const internal = http.createServer((_q, r) => { r.setHeader('Content-Type', 'application/json'); r.end('{"id":"secret","name":"internal","resources":["subtitles"]}'); });
  await new Promise<void>(r => internal.listen(0, '127.0.0.1', r));
  const port = (internal.address() as AddressInfo).port;
  const app = http.createServer(createServer());
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const client = axios.create({ baseURL: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, validateStatus: () => true, timeout: 5000 });
  try {
    const res = await client.post('/api/manifest/validate', { url: `http://127.0.0.1:${port}/manifest.json` });
    check('the manifest check does not read an internal service', res.status === 400 && res.data.valid === false && !JSON.stringify(res.data).includes('secret'), res.data);
    const meta = await client.post('/api/manifest/validate', { url: 'http://169.254.169.254/latest/meta-data/manifest.json' });
    check('nor the cloud metadata address', meta.status === 400 && /not public/.test(meta.data.error), meta.data);
  } finally {
    app.close(); internal.close();
  }
  if (failed) { console.error(`${failed} FAIL`); process.exit(1); }
  console.log('publicUrl: all ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
