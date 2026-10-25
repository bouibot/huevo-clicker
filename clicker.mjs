#!/usr/bin/env node
// clicker.mjs — автокликер huevo.su с автологином.
// Одиночный аккаунт, без прокси, без фермы.
//
// Использование:
//   node clicker.mjs --user login --pass pass
//   node clicker.mjs --login-only          # просто войти и показать куки
//   node clicker.mjs --clicks 400 --delay 8 --limit 100
//
// Флаги:
//   --user, --pass        логин/пароль (или через creds.txt / env HUE_USER/HUE_PASS)
//   --clicks N            кликов за запрос (400 — макс. сервера)
//   --delay S             пауза между запросами в секундах (8 — MIN_GAP_SECONDS сервера)
//   --limit N             макс. запросов (0 = бесконечно)
//   --duration M          минут работы (0 = до Ctrl+C)
//   --login-only          только войти и выйти
//   --dry-run             показать что бы сделали, не делая запрос

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, BASE, sleep } from './site.mjs';

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
}
if (!USER || !PASS) {
  console.error('Нет логина/пароля: укажи --user/--pass или заполни creds.txt');
  process.exit(1);
}

const CLICKS = Number(arg('clicks', 400));
const DELAY = Number(arg('delay', 8));     // серверный MIN_GAP_SECONDS = 8000мс
const LIMIT = Number(arg('limit', 0));
const DURATION = Number(arg('duration', 0));

const acc = new Account({ login: USER, pass: PASS, log });

await acc.signIn();

if (flag('login-only')) {
  const out = join(__dirname, 'cookie.txt');
  writeFileSync(out, acc.cookieHeader() + '\n', 'utf8');
  log(`вошёл, куки сохранены в ${out}`);
  process.exit(0);
}

if (flag('dry-run')) {
  log(`подготовил бы запрос: POST ${BASE}/api/clicker clicks=${CLICKS}, пауз ${DELAY}s`);
  process.exit(0);
}

const deadline = DURATION ? Date.now() + DURATION * 60_000 : Infinity;
let stop = false;
process.on('SIGINT', () => { stop = true; log('Ctrl+C — стоп'); });

let relogins = 0, netFails = 0;
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
      relogins++;
      log(`перелогин (${relogins})`);
      await acc.signIn().catch((e) => log('логин не удался:', e.message));
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
    relogins++;
    log(`HTTP ${j.__http} — перелогин (${relogins})`);
    await acc.signIn().catch((e) => log('логин не удался:', e.message));
    continue;
  }

  const wait = Number(j?.retry) || 10;
  log(`${j?.error || `HTTP ${j?.__http}`} → ждём ${wait}s`);
  await sleep((wait + 1) * 1000);
}

const s = acc.stats;
log(`готово: кликов=${s.clicks} ok=${s.ok} ошибок=${s.errors} заработано=${s.earned} релогинов=${s.relogins} баланс=${acc.balance ?? '?'}`);