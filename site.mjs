// site.mjs — HTTP-клиент для huevo.su: антибот-челлендж, логин, кликер.
// Одиночный аккаунт, без прокси, куки в памяти.

import { fetch as undiciFetch } from 'undici';

export const BASE = (process.env.HUE_BASE || 'https://huevo.su').replace(/\/$/, '');
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── антибот-челлендж: 418 + data-hchk-a/b, значение куки = XOR побайтно по 2 hex-символа ──
export function solveChallenge(html) {
  const a = html.match(/data-hchk-a="([^"]+)"/)?.[1];
  const b = html.match(/data-hchk-b="([^"]+)"/)?.[1];
  if (!a || !b || a.length !== b.length) return null;
  let t = '';
  for (let i = 0; i < a.length; i += 2) {
    t += String.fromCharCode(parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16));
  }
  return { name: html.match(/document\.cookie\s*=\s*"([^=]+)=/)?.[1] ?? 'hchk', value: t };
}

// ── клиент одного аккаунта ──
export class Account {
  constructor({ login, pass, log = () => {}, timeout = 30000 }) {
    this.login = login;
    this.pass = pass;
    this.log = log;
    this.timeout = timeout;
    this.jar = new Map();
    this.stats = { clicks: 0, ok: 0, errors: 0, earned: 0, relogins: 0 };
    this.balance = null;
    this.online = false;
  }

  get label() {
    return this.login;
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // Один HTTP-запрос: сам решает челлендж, сам идёт по редиректам, обновляет jar.
  async req(url, opt = {}) {
    const { follow = true, maxHops = 8, timeout = this.timeout } = opt;
    let { headers: extra = {}, ...rest } = opt;
    delete extra.headers;
    let target = url;
    let hops = 0;

    for (;;) {
      let res, text;
      try {
        res = await undiciFetch(target, {
          redirect: 'manual',
          ...rest,
          headers: {
            'User-Agent': UA,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            Cookie: this.cookieHeader(),
            ...extra,
          },
          signal: AbortSignal.timeout(timeout),
        });
        for (const c of res.headers.getSetCookie?.() ?? []) {
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          if (i < 0) continue;
          const k = pair.slice(0, i).trim();
          const v = pair.slice(i + 1).trim();
          if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k);
          else this.jar.set(k, v);
        }
        text = await res.text();
      } catch (e) {
        const err = new Error(`сеть: ${e.cause?.code || e.name}: ${e.cause?.message || e.message}`);
        err.net = true;
        throw err;
      }

      if (res.status === 418) {
        const c = solveChallenge(text);
        if (c && hops < maxHops) {
          this.jar.set(c.name, c.value);
          hops++;
          continue;
        }
      }

      const loc = res.headers.get('location');
      if (follow && [301, 302, 303, 307, 308].includes(res.status) && loc && hops < maxHops) {
        target = new URL(loc, target).href;
        hops++;
        if (rest.method === 'POST' && res.status !== 307 && res.status !== 308) {
          rest = {};
          extra = {};
        }
        continue;
      }

      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, text, json, url: target, headers: res.headers };
    }
  }

  async signIn() {
    const page = await this.req(`${BASE}/login`, { headers: { Accept: 'text/html,application/xhtml+xml,*/*' } });
    const dataK = page.text.match(/data-k="([^"]+)"/)?.[1];
    if (!dataK) throw new Error('не нашёл data-k на /login — сайт поменялся?');
    const hv = [...dataK].reverse().join(''); // ровно как их JS: split('').reverse().join('')
    const r = await this.req(`${BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Origin: BASE,
        Referer: `${BASE}/login`,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams({ hv, username: this.login, password: this.pass, remember: 'on' }).toString(),
      follow: false,
    });
    if (!this.jar.get('session')) throw new Error('логин не удался (нет session cookie)');
    if (r.status >= 400 && r.status !== 302) throw new Error(`логин: HTTP ${r.status} ${r.text.slice(0, 100)}`);
    this.online = true;
    this.log(`логин OK (HTTP ${r.status})`);
    return r;
  }

  // POST /api/clicker
  async click(clicks = 400) {
    this.stats.clicks++;
    const r = await this.req(`${BASE}/api/clicker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        Origin: BASE,
        Referer: `${BASE}/clicker`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams({ clicks: String(clicks) }).toString(),
      follow: false,
    });
    const j = r.json;
    if (r.status === 200 && j?.ok === true) {
      this.stats.ok++;
      this.balance = j.balance;
      this.stats.earned += j.earned ?? 0;
      return j;
    }
    this.stats.errors++;
    return { __http: r.status, __text: r.text, ...(j ?? {}) };
  }

  // баланс читается из ответа кликера; при "slow" ждём retry
  async fetchBalance(attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      const j = await this.click(1);
      if (typeof j.balance === 'number') return j.balance;
      await sleep(((Number(j.retry) || 5) + 1) * 1000);
    }
    return this.balance;
  }
}