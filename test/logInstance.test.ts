import { Logger, getLogLines, INSTANCE_ID } from '../src/utils/logger';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

const quiet = console.log;
console.log = () => undefined;
Logger.info('first');
Logger.info('second');
Logger.info('third');
console.log = quiet;

const all = getLogLines(0);
check('the log names its instance', typeof all.instance === 'string' && all.instance === INSTANCE_ID && all.instance.length > 0);
check('everything is sent without a counter', all.lines.length >= 3, all.lines.length);

const afterOwn = getLogLines(all.last - 1, INSTANCE_ID);
check('the counter of this instance cuts the older lines', afterOwn.lines.length === 1 && /third/.test(afterOwn.lines[0].text), afterOwn.lines.length);

const afterOther = getLogLines(all.last, 'another-instance');
check('a counter from another instance means nothing: the whole buffer is sent', afterOther.lines.length === all.lines.length, afterOther.lines.length);

const oldClient = getLogLines(all.last);
check('an older page (no instance name) keeps working as before', oldClient.lines.length === 0);

if (failed) { console.error(`${failed} log instance check(s) failed`); process.exit(1); }
console.log('All log instance checks passed');
