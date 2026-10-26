// site.mjs — HTTP-клиент huevo.su: антибот(418), логин с капчей, кликер.
// Куки автоматически сохраняются в файл (cookie.txt) и переиспользуются между запусками.
// Солвер капчи подключаемый: manual / api (2captcha, rucaptcha, anticaptcha...) / ocr.

import { fetch as undiciFetch } from 'undici';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASE = (process.env.HUE_BASE || 'https://huevo.su').replace(/\/$/, '');
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── антибот: 418 + data-hchk-a/b, кука = XOR байтов попарно - ровно как их JS ──
export function solveChallenge(html) {
  const a = html.match(/data-hchk-a="([^"]+)"/)?.[1];
  const b = html.match(/data-hchk-b="([^"]+)"/)?.[1];
  if (!a || !b) return null;
  let t = '';
  for (let i = 0; i < a.length; i += 2) {
    t += String.fromCharCode(parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16));
  }
  return { name: html.match(/document\.cookie\s*=\s*"([^=]+)=/)?.[1] ?? 'hchk', value: t };
}

// ── подключаемые солверы капчи: забирают base64 PNG, отдают текст ──
// mode 'manual': сохраняет капчу в файл и спрашивает код из stdin (или падает, если stdin не консоль).
// mode 'api':    2captcha/rucaptcha/anticaptcha-совместимый HTTP API (нужен --captcha-key).
// mode 'ocr':    локальный tesseract.js (низкая точность на этом стиле, не рекомендую).
import { makeSolver } from './captcha-solver.mjs';

// ── клиент одного аккаунта ──
export class Account {
  constructor({ login, pass, log = () => {}, timeout = 30000, cookieFile = null, solver = null }) {
    this.login = login;
    this.pass = pass;
    this.log = log;
    this.timeout = timeout;
    this.cookieFile = cookieFile || join(__dirname, 'cookie.txt');
    this.solver = solver; // {mode,key}
    this.jar = new Map(); // k -> {v, raw}   raw = полный Set-Cookie для сохранения
    this.stats = { clicks: 0, ok: 0, errors: 0, earned: 0, relogins: 0, captchaRetries: 0 };
    this.balance = null;
    this.online = false;
    // последний раз когда отправляли запрос клика (для MIN_GAP_SECONDS)
    this.nextClickAt = 0;
    // загружаем куки из файла, если есть
    this.loadCookies();
  }

  get label() {
    return this.login;
  }

  // ── файловые куки ──
  cookieHeader() {
    return [...this.jar].map(([k, { v }]) => `${k}=${v}`).join('; ');
  }
  saveCookies(file = this.cookieFile) {
    try {
      const lines = [...this.jar].map(([, c]) => c.raw).filter(Boolean);
      writeFileSync(file, lines.join('\n') + '\n', 'utf8');
      this.log(`куки сохранены → ${file}`);
    } catch (e) {
      this.log(`⚠️ не удалось сохранить куки: ${e.message}`);
    }
  }
  loadCookies(file = this.cookieFile) {
    try {
      if (!existsSync(file)) return false;
      const raw = readFileSync(file, 'utf8');
      let n = 0;
      for (let line of raw.split('\n')) {
        line = line.trim();
        if (!line.includes('=')) continue;
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        if (i < 0) continue;
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (v === '') { this.jar.delete(k); continue; }
        // не тащим устаревшие
        const exp = /expires=([^;]+)/i.exec(line);
        if (exp) {
          const d = new Date(exp[1]);
          if (!isNaN(d) && d.getTime() < Date.now()) continue;
        }
        this.jar.set(k, { v, raw: line });
        n++;
      }
      if (n) this.log(`куки загружены из ${file} (${n} шт)`);
      return n > 0;
    } catch {
      return false;
    }
  }

  // проверяем: жив ли текущий сеанс? (дёшево — GET /clicker: аноним получит страницу логина)
  async sessionAlive() {
    if (!this.jar.get('session')) return false;
    const r = await this.req(`${BASE}/clicker`, {
      headers: { Accept: 'text/html,*/*' },
      follow: false,
    }).catch(() => null);
    if (!r) return false;
    // аноним: 302 на /login либо страница с формой логина
    if (r.status === 302) return false;
    if (r.status === 200) {
      return !r.text.includes('id="login-form"') && !r.text.includes('name="username"');
    }
    return false;
  }

  // ── HTTP с авто-челленджем и редиректами ──
  async req(url, opt = {}) {
    const { follow = true, maxHops = 8, timeout = this.timeout } = opt;
    let { headers: extra = {}, ...rest } = opt;
    delete extra.headers;
    let target = url;
    let hops = 0;

    for (;;) {
      let res, text, buffer = null;
      try {
        res = await undiciFetch(target, {
          redirect: 'manual',
          ...rest,
          headers: {
            'User-Agent': UA,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            Cookie: this.cookieHeader(),
            ...extra,
          },
          signal: AbortSignal.timeout(timeout),
        });
        // куки в jar + запоминаем полные Set-Cookie для файла
        for (const c of res.headers.getSetCookie?.() ?? []) {
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          if (i < 0) continue;
          const k = pair.slice(0, i).trim();
          const v = pair.slice(i + 1).trim();
          if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k);
          else this.jar.set(k, { v, raw: c });
        }
        if (opt.binary) {
          buffer = Buffer.from(await res.arrayBuffer());
        } else {
          text = await res.text();
        }
      } catch (e) {
        const err = new Error(`сеть: ${e.cause?.code || e.name}: ${e.cause?.message || e.message}`);
        err.net = true;
        throw err;
      }

      // антибот: решаем XOR-челлендж и повторяем тот же запрос
      if (res.status === 418 && !opt.binary) {
        const c = solveChallenge(text);
        if (c && hops < maxHops) {
          this.jar.set(c.name, { v: c.value, raw: `${c.name}=${c.value}; Path=/; Max-Age=259200; SameSite=Lax` });
          hops++;
          continue;
        }
      }

      if (opt.binary) {
        return { status: res.status, buffer, headers: res.headers };
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
      if (process.env.HUE_DEBUG) {
        this.log(`[dbg] ${rest.method || 'GET'} ${url} → ${res.status}${json ? ' ' + JSON.stringify(json).slice(0, 120) : ''}${!json && text ? ' | ' + text.slice(0, 100).replace(/\s+/g, ' ') : ''}`);
      }
      return { status: res.status, text, json, url: target, headers: res.headers };
    }
  }

  // ── капча: токен+картинка. Сначала из HTML страницы логина, потом через refresh. ──
  static parsePageCaptcha(html) {
    const token = html.match(/name="captcha_token"\s+value="([^"]+)"/i)?.[1]
      ?? html.match(/captcha_token" value="([^"]+)"/i)?.[1]
      ?? html.match(/name="captcha_token" value="([^"]+)"/)?.[1];
    const url = html.match(/src="(\/captcha\/[a-f0-9]+\.png)"/i)?.[1];
    return token && url ? { token, url } : null;
  }

  async fetchImageB64(url) {
    const img = await this.req(`${BASE}${url}`, {
      headers: { Accept: 'image/png,image/webp,*/*' },
      follow: false,
      binary: true,
    });
    return img.buffer.toString('base64');
  }

  // свежие токен+картинка через /captcha/refresh/login (с бэкоффом на 429)
  async refreshCaptcha() {
    for (let i = 0; i < 4; i++) {
      const ref = await this.req(`${BASE}/captcha/refresh/login`, {
        headers: { Accept: 'application/json' },
        follow: false,
      }).catch((e) => { throw new Error(`captcha/refresh: ${e.message}`); });
      const d = ref.json && ref.json.url ? ref.json : (() => { try { return JSON.parse(ref.text); } catch { return {}; } })();
      if (!d.url) {
        if (ref.status === 429) {
          this.log(`⚠️ капча-сервис просит подождать (429) — пауза 30с (${i + 1}/4)`);
          await sleep(30000);
          continue;
        }
        throw new Error(`captcha/refresh: HTTP ${ref.status} ${ref.text.slice(0, 100)}`);
      }
      const b64 = await this.fetchImageB64(d.url);
      return { token: d.token, base64: b64, url: d.url };
    }
    throw new Error('captcha/refresh: так и не пустил (429)');
  }

  // ── собственно логин ──
  async signIn() {
    if (this.jar.get('session') && await this.sessionAlive()) {
      this.online = true;
      this.log('сессия жива, логин не нужен');
      return { reused: true };
    }

    const MAX_TRY = 4;
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      // свежая страница логина на КАЖДУЮ попытку: свежий hchk (антибот) и data-k.
      // копить их в прошлой попытке нельзя — протухшие куки дают 403 на POST.
      let page, dataK;
      try {
        page = await this.req(`${BASE}/login`, {
          headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
        });
        dataK = page.text.match(/data-k="([^"]+)"/)?.[1];
      } catch (e) {
        this.log(`⚠️ страница логина: ${e.message}; пауза 5с`);
        await sleep(5000);
        continue;
      }
      if (!dataK) throw new Error('не нашёл data-k на /login — сайт поменялся?');

      // капча: из формы на свежей странице, либо /captcha/refresh
      const pageCap = Account.parsePageCaptcha(page.text);
      let cap;
      try {
        cap = pageCap
          ? { ...pageCap, base64: await this.fetchImageB64(pageCap.url) }
          : await this.refreshCaptcha();
      } catch (e) {
        this.log(`⚠️ ${e.message}; пауза 10с`);
        await sleep(10000);
        continue;
      }

      let code = null;
      try {
        code = await this.solver.solve({
          image: cap.base64,
          prompt: `huevo.su логин (${this.login}), попытка ${attempt}/${MAX_TRY}`,
        });
      } catch (e) {
        // например manual без консоли или нет ключа API
        throw new Error(`солвер капчи: ${e.message}`);
      }
      if (!code) { await sleep(2000); continue; }

      // свежий data-k → hv (их JS: data-k.split('').reverse().join(''))
      const hv = [...dataK].reverse().join('');
      const form = new URLSearchParams({
        hv, username: this.login, password: this.pass,
        captcha_token: cap.token, captcha: code.trim(),
        remember: 'on',
      });
      this.log(`логин с капчей «${code.trim()}» (попытка ${attempt})`);
      const r = await this.req(`${BASE}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Origin: BASE, Referer: `${BASE}/login`,
          'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
        },
        body: form.toString(),
        follow: false,
      });

      // успех: редирект (302)
      if (r.status === 302 && r.headers.get('location')) {
        const alive = await this.sessionAlive();
        if (alive) {
          this.online = true;
          this.saveCookies();
          this.log(`логин OK; куки сохранены в ${this.cookieFile}`);
          return r;
        }
        this.log('⚠️ логин прошёл, но сессия не подтвердилась — пробую ещё раз');
        await sleep(2000);
        continue;
      }

      // 429 = слишком много неудачных попыток (или лимит на вход) — стоп, не долбим
      const msg = r.text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const lock = /через\s+(\d+)\s*сек/i.exec(msg);
      if (r.status === 429 || /слишком много неудачных попыток/i.test(msg)) {
        throw new Error(
          `сервер залочил попытки входа${lock ? ` на ${lock[1]} сек` : ''} (HTTP ${r.status})`
        );
      }

      // неверная капча — сервер вернул форму с флешкой
      if (/капч/i.test(msg)) {
        this.stats.captchaRetries++;
        this.log(`⚠️ капча неверная — новая капча`);
        await sleep(8000 + Math.random() * 3000);
        continue;
      }

      // прочее — ретрай с паузой
      this.stats.errors++;
      this.log(`⚠️ логин: HTTP ${r.status} ${msg.slice(0, 140)} — попробую ещё раз`);
      await sleep(5000);
    }
    throw new Error('не удалось войти: капча так и не решилась');
  }

  // POST /api/clicker
  async click(clicks = 400) {
    this.stats.clicks++;
    // серверный MIN_GAP_SECONDS=8000 — не спамим
    const wait = this.nextClickAt - Date.now();
    if (wait > 0) await sleep(wait);
    const r = await this.req(`${BASE}/api/clicker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        Origin: BASE, Referer: `${BASE}/clicker`,
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams({ clicks: String(clicks) }).toString(),
      follow: false,
    });
    this.nextClickAt = Date.now() + 8000;
    const j = r.json;
    if (r.status === 200 && j?.ok === true) {
      this.stats.ok++;
      this.balance = j.balance;
      this.stats.earned += j.earned ?? 0;
      return j;
    }
    // дневной кап достигнут — это НЕ ошибка и НЕ повод для релогина
    if (j?.capped === true || j?.error === 'full') {
      this.stats.errors++;
      return { ok: false, capped: true, __http: r.status, ...(j ?? {}) };
    }
    this.stats.errors++;
    return { __http: r.status, __text: r.text, ...(j ?? {}) };
  }

  async fetchBalance(attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      const j = await this.click(1);
      if (typeof j.balance === 'number') return j.balance;
      await sleep(((Number(j.retry) || 5) + 1) * 1000);
    }
    return this.balance;
  }
}

export { makeSolver };
