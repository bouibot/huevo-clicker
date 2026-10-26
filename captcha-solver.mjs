// captcha-solver.mjs — подключаемые солверы капчи для site.mjs.
//   manual — капча в Discord-вебхук + локальный файл; код ждём из консоли (readline)
//            или из файла captcha_code.txt (fallback для неинтерактивного запуска).
//   api    — 2captcha / rucaptcha / anticaptcha (--captcha-key).
//   ocr    — локальный tesseract.js (шумостойкость слабая).
//
// Транспорт сервисов капчи одинаков:
//   in.php?key=KEY&method=base64&body=<b64>&json=1 → {status:1, request:<id>}
//   res.php?key=KEY&action=get&id=<id>&json=1      → {status:1, request:<text>}
import { writeFileSync, readFileSync, existsSync, writeFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { fetch } from 'undici';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function makeSolver({ mode = 'manual', key = '', endpoint = 'https://2captcha.com', webhook = '' } = {}) {
  if (mode === 'api') {
    if (!key) throw new Error('режим api требует --captcha-key (ключ 2captcha/rucaptcha)');
    return apiSolver(key, endpoint);
  }
  if (mode === 'ocr') return ocrSolver;
  return manualSolver(webhook);
}

// ── управление файлом кода-фолбэка (удобно в скриптах/автоматизации) ──
const CODE_FILE = join(__dirname, 'captcha_code.txt');
function readCodeFile() {
  try {
    if (existsSync(CODE_FILE)) {
      const txt = readFileSync(CODE_FILE, 'utf8').trim();
      if (txt) {
        try { writeFileSync(CODE_FILE, '', 'utf8'); } catch {}
        return txt;
      }
    }
  } catch {}
  return null;
}

// ── Discord webhook: картинка + подпись (multipart собран вручную) ──
async function sendToDiscord(url, imageB64, caption) {
  try {
    const buf = Buffer.from(imageB64, 'base64');
    const boundary = `----huevo${Date.now().toString(16)}`;
    const esc = (s) => String(s ?? '').replace(/\r?\n/g, ' ');
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="content"\r\n\r\n${esc(caption)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="captcha-${Date.now()}.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buf, tail]);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) console.error(`⚠️ [discord] HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    else console.log('📣 капча отправлена в Discord');
  } catch (e) {
    console.error(`⚠️ [discord] не удалось отправить: ${e.message}`);
  }
}

// ── manual: отправить картинку + ждать код ──
function manualSolver(webhook) {
  return {
    async solve({ image, prompt }) {
      const file = join(__dirname, 'captcha-todo.png');
      writeFileSync(file, Buffer.from(image, 'base64'));
      if (webhook) await sendToDiscord(webhook, image, `**huevo.su** — ${prompt ?? 'введи код с капчи'}`);
      return waitForCode(prompt);
    },
  };
}

// ── ждём код: консоль (readline) ИЛИ файл captcha_code.txt ──
async function waitForCode(prompt, timeoutMs = 180000) {
  const started = Date.now();
  let rl = null;
  const close = () => { try { rl?.close(); } catch {} };

  // попытка прочитать из консоли; если stdin нереален — вопрос просто не повиснет
  const stdinPromise = new Promise((resolve) => {
    try {
      if (!process.stdin || process.stdin.destroyed) return resolve(null);
      rl = createInterface({ input: process.stdin, terminal: false });
      const msg = prompt ?? 'Введи код с капчи (см. картинку выше в Discord или captcha-todo.png)';
      rl.question(`\n🎯 ${msg} .\n> `, (ans) => {
        close();
        resolve(ans.trim() || null);
      });
    } catch {
      resolve(null);
    }
  });

  // параллельно крутим файл-фолбэк
  let reminder = Date.now() + 45000;
  while (Date.now() - started < timeoutMs) {
    const fromStdin = await Promise.race([
      stdinPromise,
      new Promise((r) => setTimeout(() => r(undefined), 250)),
    ]);
    if (fromStdin !== undefined && fromStdin !== null) { close(); return fromStdin; }

    const fromFile = readCodeFile();
    if (fromFile) { close(); return fromFile; }

    if (Date.now() > reminder) {
      console.log(`⏳ жду код: вставь в эту консоль или запиши в captcha_code.txt (осталось ~${Math.round((timeoutMs - (Date.now() - started)) / 1000)}с)`);
      reminder = Date.now() + 45000;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  close();
  throw new Error(
    `код капчи не введён за ${Math.round(timeoutMs / 60000)} мин — картинка в ${join(__dirname, 'captcha-todo.png')} (и в Discord); повтори с --captcha-code`
  );
}

// ── api: 2captcha-совместимый сервис ──
function apiSolver(key, endpoint) {
  const base = endpoint.replace(/\/$/, '');
  return {
    async solve({ image }) {
      const capRes = await fetch(`${base}/in.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key, method: 'base64', body: image, json: '1' }).toString(),
        signal: AbortSignal.timeout(30000),
      });
      const cap = await capRes.json();
      if (cap.status !== 1) throw new Error(`in.php: ${cap.request}`);
      const id = cap.request;
      for (let i = 0; i < 36; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const res = await fetch(`${base}/res.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ key, action: 'get', id, json: '1' }).toString(),
          signal: AbortSignal.timeout(30000),
        });
        const d = await res.json();
        if (d.status === 1) return d.request;
        if (/CAPCHA_NOT_READY|not ready/i.test(d.request)) continue;
        throw new Error(`res.php: ${d.request}`);
      }
      throw new Error('капча-сервис не ответил за 3 минуты');
    },
  };
}

// ── ocr: tesseract.js, one-shot (лучше не использовать) ──
const ocrSolver = {
  async solve({ image }) {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('rus');
    await worker.setParameters({
      tessedit_pageseg_mode: '3',
      tessedit_char_whitelist: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ0123456789',
    });
    try {
      const { data } = await worker.recognize(Buffer.from(image, 'base64'));
      return data.text.replace(/\s+/g, '').slice(0, 8);
    } finally {
      await worker.terminate();
    }
  },
};
