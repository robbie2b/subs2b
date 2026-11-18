import iconv from 'iconv-lite';
import { toCleanUtf8, guessLegacyCharset } from '../src/proxy/subtitleProxy';

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`  ok  ${name}`); else { failed++; console.log(`  FAIL  ${name}`, detail ?? ''); }
};

const ro = 'Ţi-am spus că mâine ţinem şedinţa. Ştiu ce faci şi ţi-o spun: nu ţine, ţine-te bine, ţară, înţeles.';
check('Romanian in Windows-1250 is read right without being told', toCleanUtf8(iconv.encode(ro, 'win1250')) === ro, toCleanUtf8(iconv.encode(ro, 'win1250')));

const pl = 'Żółć gęślą jaźń, łódź, ćma, żył. Zażółć gęślą jaźń. Ładny dzień, łatwo, błąd.';
check('Polish in Windows-1250 is read right', toCleanUtf8(iconv.encode(pl, 'win1250')) === pl);

const pt = 'Não sei o que você quer, ação é coração. 1º lugar, 2º lugar, 3º lugar. À noite, é só isso.';
check('Portuguese in Windows-1252 stays Windows-1252 (ã º are not Romanian)', toCleanUtf8(iconv.encode(pt, 'win1252')) === pt);

const fr = 'Où êtes-vous allé ? Ça va très bien, merci. À demain, déjà fait, être ou ne pas être.';
check('French in Windows-1252 is read right', toCleanUtf8(iconv.encode(fr, 'win1252')) === fr);

const ru = 'Привет, как дела? Я не знаю, что тебе сказать. Это очень длинное предложение для проверки кодировки, '.repeat(4);
check('Russian in Windows-1251 is read right', toCleanUtf8(iconv.encode(ru, 'win1251')) === ru.trim());

check('UTF-8 is untouched', toCleanUtf8(Buffer.from(ro, 'utf8')) === ro);
check('a caller that knows the charset decides', toCleanUtf8(iconv.encode('ţ', 'win1250'), 'win1250') === 'ţ');
check('the guess is Windows-1252 for plain ASCII-ish bytes', guessLegacyCharset(Buffer.from('plain text é', 'latin1')) === 'win1252');

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log('All charset checks passed');
