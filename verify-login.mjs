#!/usr/bin/env node
// verify-login.mjs — интерактивная проверка логина huevo.su шаг за шагом.
// Нужен только для диагностики: вводишь код капчи, а скрипт печатает статус/куки/ответ на каждом шаге.
//   node verify-login.mjs [--user X --pass Y]
import { fetch as undiciFetch } from 'undici';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';
const BASE = 'https://huevo.su';

let LOGIN = arg('user') || process.env.HUE_USER || 'epileptic';
let PASS = arg('pass') || process.env.HUE_PASS || '';
const credsFile = 'creds.txt';
if ((!LOGIN || !PASS) && existsSync(credsFile)) {
  const raw = readFileSync(credsFile, 'utf8');
  LOGIN ||= raw.match(/^\s*(?:user|login|username)\s*[:=]\s*(.+)$/im)?.[1]?.trim() ?? '';
  PASS ||= raw.match(/^\s*(?:pass|password)\s*[:=]\s*(.+)$/im)?.[1]?.trim() ?? '';
}

const jar = new Map();
const ck = () => [...jar].map(([k, c]) => `${k}=${c.v}`).join('; ');
const solve = (html) => {
  const a = html.match(/data-hchk-a="([^"]+)"/)?.[1], b = html.match(/data-hchk-b="([^"]+)"/)?.[1];
  if (!a || !b) return null;
  let t = '';
  for (let i = 0; i < a.length; i += 2) t += String.fromCharCode(parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16));
  return t;
};

let hop = 0;
async function step(label, url, opt = {}, follow = true) {
  const res = await undiciFetch(url, {
    redirect: 'manual', ...opt,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: ck(), ...(opt.headers || {}) },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [p] = c.split(';'); const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
    if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k);
    else jar.set(k, { v, raw: c });
  }
  const isImg = res.headers.get('content-type')?.startsWith('image/');
  const text = isImg ? '' : await res.text();
  console.log(`\n--- ${label}\n${(opt.method || 'GET').padEnd(5)} ${url}  →  ${res.status}  ${res.headers.get('content-type')}`);
  console.log(`    cookies: ${([...jar.keys()].join(', ') || '—')}`);

  if (res.status === 418) {
    const s = solve(typeof text === 'string' ? text : '');
    if (s) { jar.set('hchk', { v: s, raw: 'hchk=' + s }); console.log('    → челлендж решён, повтор'); hop++; return step(label, url, opt, follow); }
  }
  const loc = res.headers.get('location');
  if (follow && [301, 302, 303, 307, 308].includes(res.status) && loc && hop < 6) {
    console.log(`    → redirect: ${loc}`);
    hop++;
    return step(label, new URL(loc, url).href, {}, follow);
  }
  if (!isImg) console.log('    body: ' + text.slice(0, 240).replace(/\s+/g, ' '));
  return { status: res.status, text, isImg };
}

// ── 1. антибот + страница ──
const page = await step('страница логина', `${BASE}/login`, { headers: { Accept: 'text/html,*/*' } });
const dataK = page.text.match(/data-k="([^"]+)"/)?.[1];
console.log('    data-k:', dataK ? dataK.slice(0, 16) + '…' : 'НЕТ (не нашёл!)');

// ── 2. капча ──
const ref = await step('капча /refresh', `${BASE}/captcha/refresh/login`, { headers: { Accept: 'application/json' } });
let d = {}; try { d = JSON.parse(ref.text); } catch {}
writeFileSync('verify-captcha.png', Buffer.from(await (await undiciFetch(BASE + d.url, { headers: { 'User-Agent': UA, Cookie: ck() } })).arrayBuffer()));
console.log('    капча сохранена → verify-captcha.png');

const rl = createInterface({ input: process.stdin, terminal: true });
const code = await new Promise((r) => rl.question('    код с капчи: ', r));
rl.close();
console.log('    ввели:', code);

// ── 3. POST /login ──
const post = await step('POST /login', `${BASE}/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Origin: BASE, Referer: `${BASE}/login`,
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
  },
  body: new URLSearchParams({
    hv: dataK ? [...dataK].reverse().join('') : '',
    username: LOGIN, password: PASS,
    captcha_token: d.token, captcha: code, remember: 'on',
  }).toString(),
}, false);

// ── 4. проверки ──
const alive = await step('проверка /clicker', `${BASE}/clicker`, { headers: { Accept: 'text/html,*/*' } });
const api1 = await step('кликер clicks=1', `${BASE}/api/clicker`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*',
    Origin: BASE, Referer: `${BASE}/clicker`,
    'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
  },
  body: 'clicks=1', follow: false,
});
const api2 = await step('кликер clicks=400', `${BASE}/api/clicker`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*',
    Origin: BASE, Referer: `${BASE}/clicker`,
    'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
  },
  body: 'clicks=400', follow: false,
});
console.log('\nИТОГ:');
console.log('  сессия в jar:', [...jar.keys()].join(', '));
console.log('  /clicker:', alive.status, alive.text.includes('login-form') ? '(это форма логина → не залогинен)' : '(похоже залогинен)');
console.log('  кликер 1:', api1.status, api1.text);
console.log('  кликер 400:', api2.status, api2.text.slice(0, 200));
