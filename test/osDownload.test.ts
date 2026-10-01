import axios from 'axios';
import { handleOpenSubtitlesRestDownload, serverCanDownload } from '../src/proxy/subtitleProxy';
import { clearSourceHealth, isBlocked, recoveryFromMessage } from '../src/utils/sourceHealth';

// OpenSubtitles download: the order of the sources and the reasons that reach the log

let failures = 0;
function check(ok: boolean, label: string, details?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL ${label}`, details !== undefined ? JSON.stringify(details) : '');
  }
}

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nhello there, this is a subtitle\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond line of the subtitle\n';
const rateLimited = (status: number, data?: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

const respond = () => {
  const out: { status: number; body: string } = { status: 200, body: '' };
  const res: any = {
    status(c: number) { out.status = c; return res; },
    type() { return res; },
    setHeader() { /* not checked */ },
    send(b: string) { out.body = String(b); return res; },
    json(b: unknown) { out.body = JSON.stringify(b); return res; }
  };
  return { res, out };
};

async function main(): Promise<void> {
  const calls: string[] = [];
  let apiAnswer: () => unknown = () => ({ data: { link: 'https://dl.example/api-file' } });
  let mirrorsWork = false;
  (axios as any).post = async (url: string) => { calls.push('api'); return apiAnswer(); };
  (axios as any).get = async (url: string) => {
    calls.push(new URL(url).hostname);
    if (url === 'https://dl.example/api-file') return { data: new Uint8Array(Buffer.from(SRT)).buffer };
    if (!mirrorsWork) throw rateLimited(469);
    return { data: new Uint8Array(Buffer.from(SRT)).buffer };
  };
  const errors: string[] = [];
  const realError = console.error;
  const logs: string[] = [];
  const realLog = console.log;
  const capture = (...a: unknown[]) => { const t = a.map(String).join(' '); logs.push(t); if (!t.includes('[DOWNLOAD]') && !t.includes('download failed')) realLog(...a); };
  const req = (query: Record<string, string>) => ({ params: { fileId: '123' }, query: { apiKey: 'k', legacyId: '456', filename: 'x.srt', ...query } } as any);

  console.log = capture;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };

  // normal pick: the API first
  let r = respond();
  await handleOpenSubtitlesRestDownload(req({}), r.res);
  check(r.out.status === 200 && calls[0] === 'api' && calls.length === 2, 'a normal download uses the API first', calls);

  // the API refuses (daily quota): its reason reaches the log, then the mirrors are tried
  calls.length = 0;
  apiAnswer = () => { throw rateLimited(406, { message: 'You have downloaded your allowed 5 subtitles for 24h', remaining: 0, reset_time_utc: '2026-10-02T00:00:00Z' }); };
  mirrorsWork = false;
  r = respond();
  await handleOpenSubtitlesRestDownload(req({}), r.res);
  const failure = errors.find(e => e.includes('download failed')) || '';
  check(r.out.status === 502, 'every source failing gives an error', r.out.status);
  check(failure.includes('api: HTTP 406') && failure.includes('allowed 5 subtitles') && failure.includes('remaining 0') && failure.includes('reset 2026-10-02'), 'the log has the API reason with the quota message', failure);
  check(failure.includes('dl.opensubtitles.org (legacy id): HTTP 469') && failure.includes('subs5.strem.io: HTTP 469'), 'and the reason of every mirror', failure);

  const back = recoveryFromMessage('You have downloaded your allowed 100 subtitles for 24h.Your quota will be renewed in 15 hours and 49 minutes (2026-10-02 00:00:00 UTC)');
  check(back !== null && Math.abs(back - (Date.now() + (15 * 60 + 50) * 60000)) < 5000, 'the quota message tells when it comes back (15 h 49 min)', back && new Date(back).toISOString());

  // the refusals are remembered: the next download does not try them again, and fails at once
  check(isBlocked('api.opensubtitles.com') && isBlocked('dl.opensubtitles.org') && isBlocked('subs5.strem.io'), 'the refusing sources are remembered');
  check(!serverCanDownload({ url: '/proxy/download/os-rest/1?apiKey=k' }), 'an OpenSubtitles subtitle counts as not downloadable by this server for now');
  calls.length = 0;
  const t0 = Date.now();
  r = respond();
  await handleOpenSubtitlesRestDownload(req({}), r.res);
  check(r.out.status === 502 && calls.length === 0 && Date.now() - t0 < 100, 'the next download skips them (no request, no waiting)', calls);
  clearSourceHealth();
  check(serverCanDownload({ url: '/proxy/download/os-rest/1?apiKey=k' }), 'once they recover, it is downloadable again');

  // Subsync reference: the mirrors first, the API is not used when a mirror works
  calls.length = 0;
  apiAnswer = () => ({ data: { link: 'https://dl.example/api-file' } });
  mirrorsWork = true;
  r = respond();
  await handleOpenSubtitlesRestDownload(req({ mirrorFirst: '1' }), r.res);
  check(r.out.status === 200 && calls[0] === 'dl.opensubtitles.org' && !calls.includes('api'), 'a reference download (mirrorFirst) does not spend the API quota', calls);

  // ... and still falls back to the API when the mirrors fail
  clearSourceHealth();
  calls.length = 0;
  mirrorsWork = false;
  r = respond();
  await handleOpenSubtitlesRestDownload(req({ mirrorFirst: '1' }), r.res);
  check(r.out.status === 200 && calls.includes('api') && calls.indexOf('api') > 0, 'mirrors failing: the API is the backup', calls);
  check(logs.some(l => l.includes('[DOWNLOAD] OpenSubtitles file 123 downloaded after')), 'a download that needed a backup is logged');

  console.log = realLog;
  console.error = realError;
  if (failures) {
    console.error(`${failures} OpenSubtitles download check(s) failed`);
    process.exit(1);
  }
  console.log('All OpenSubtitles download checks passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
