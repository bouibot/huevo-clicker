#!/usr/bin/env node
// clicker.mjs — автокликер huevo.su: автологин с капчей, автосохранение и переиспользование кук.
//
//   node clicker.mjs --user login --pass pass
//   node clicker.mjs --login-only          # войти и сохранить куки в cookie.txt
//   node clicker.mjs --captcha-mode api --captcha-key KEY   # капча через платный сервис
//   node clicker.mjs --captcha-code ABC12  # неинтерактивно: готовый код капчи
//
// Флаги:
//   --user, --pass       логин/пароль (или creds.txt / env HUE_USER/HUE_PASS)
//   --clicks N           кликов за запрос (400 — макс. сервера)
//   --delay S            пауза между запросами в сек (8 — MIN_GAP_SECONDS сервера)
//   --limit N            макс. запросов (0 = бесконечно)
//   --duration M         минут работы (0 = до Ctrl+C)
//   --login-only         только войти и сохранить куки
//   --dry-run            показать что бы сделали, не делая сетевых запросов
//   --no-cookies         не читать/писать cookie.txt
//   --captcha-mode M     manual (по умолчанию) | api | ocr
//   --captcha-key KEY    ключ 2captcha/rucaptcha для mode=api
//   --captcha-endpoint U сервер капчи для mode=api (2captcha.com)
//   --captcha-code CODE  готовый код капчи (для неинтерактивного запуска)

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, makeSolver, BASE, sleep } from './site.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const flag = (n) => argv.includes(`--${n}`);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// креды: --user/--pass -> env HUE_USER/HUE_PASS -> creds.txt
let USER = typeof arg('user') === 'string' ? arg('user') : process.env.HUE_USER || '';
let PASS = typeof arg('pass') === 'string' ? arg('pass') : process.env.HUE_PASS || '';
const credsFile = join(__dirname, 'creds.txt');
if ((!USER || !PASS) && existsSync(credsFile)) {
  const raw = readFileSync(credsFile, 'utf8');
  USER ||= raw.match(/^\s*(?:user|login|username)\s*[:=]\s*(.+)$/im)?.[1]?.trim() ?? '';
  PASS ||= raw.match(/^\s*(?:pass|password)\s*[:=]\s*(.+)$/im)?.[1]?.trim() ?? '';
  process.env.CAPTCHA_MODE ||= raw.match(/^\s*captcha_mode\s*[:=]\s*(.+)$/im)?.[1]?.trim();
  process.env.CAPTCHA_KEY ||= raw.match(/^\s*captcha_key\s*[:=]\s*(.+)$/im)?.[1]?.trim();
}
if (!USER || !PASS) {
  console.error('Нет логина/пароля: укажи --user/--pass или заполни creds.txt');
  process.exit(1);
}

const CLICKS = Number(arg('clicks', 400));
const DELAY = Number(arg('delay', 8));
const LIMIT = Number(arg('limit', 0));
const DURATION = Number(arg('duration', 0));

// ── солвер капчи ──
const mode = arg('captcha-mode') || process.env.CAPTCHA_MODE || 'manual';
const key = arg('captcha-key') || process.env.CAPTCHA_KEY || '';
let solver;
try {
  if (flag('captcha-code')) {
    const code = String(arg('captcha-code'));
    solver = { solve: async () => code };
  } else {
    solver = makeSolver({
      mode,
      key,
      endpoint: typeof arg('captcha-endpoint') === 'string' ? arg('captcha-endpoint')
        : process.env.CAPTCHA_ENDPOINT || 'https://2captcha.com',
    });
  }
} catch (e) {
  console.error(`⚠️ Солвер капчи: ${e.message}`);
  process.exit(1);
}

const acc = new Account({
  login: USER,
  pass: PASS,
  log,
  solver,
  cookieFile: flag('no-cookies') ? null : join(__dirname, 'cookie.txt'),
});

if (flag('dry-run')) {
  log(`подготовил бы: логин → POST ${BASE}/api/clicker clicks=${CLICKS}, пауз ${DELAY}s (капча: ${mode})`);
  process.exit(0);
}

await acc.signIn();

if (flag('login-only')) {
  log(`вошёл; куки сохранены в ${acc.cookieFile || '— (--no-cookies)'}`);
  process.exit(0);
}

const deadline = DURATION ? Date.now() + DURATION * 60_000 : Infinity;
let stop = false;
process.on('SIGINT', () => { stop = true; log('Ctrl+C — стоп'); });

let netFails = 0;
while (!stop && Date.now() < deadline && (!LIMIT || acc.stats.clicks < LIMIT)) {
  let j;
  try {
    j = await acc.click(CLICKS);
    netFails = 0;
  } catch (e) {
    netFails++;
    log(`сеть: ${e.message} → пауза 10с`);
    if (netFails >= 2) {
      netFails = 0;
      acc.stats.relogins++;
      log(`перелогин #${acc.stats.relogins}`);
      await acc.signIn().catch((e2) => log('логин не удался:', e2.message));
    }
    await sleep(10000);
    continue;
  }

  if (j?.ok === true) {
    if (j.capped) log(`⚠️ дневной кап: ${j.balance_text} (cap ${j.cap})`);
    await sleep(DELAY * 1000 + Math.random() * 2000);
    continue;
  }

  if (j?.__http === 401 || j?.__http === 403) {
    // сессия умерла — чистим куки и логинимся заново (новая капча)
    acc.jar.clear();
    acc.stats.relogins++;
    log(`HTTP ${j.__http} — перелогин #${acc.stats.relogins}`);
    await acc.signIn().catch((e) => log('логин не удался:', e.message));
    continue;
  }

  const wait = Number(j?.retry) || 10;
  log(`${j?.error || `HTTP ${j?.__http}`} → ждём ${wait}s`);
  await sleep((wait + 1) * 1000);
}

const s = acc.stats;
log(
  `готово: кликов=${s.clicks} ok=${s.ok} ошибок=${s.errors} заработано=${s.earned} ` +
    `релогинов=${s.relogins} баланс=${acc.balance ?? '?'}`
);
