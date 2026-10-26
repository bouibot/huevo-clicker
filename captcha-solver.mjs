// captcha-solver.mjs — подключаемые солверы капчи для site.mjs.
//   mode: 'manual' — капча сохраняется в файл, код спрашивается из консоли (или падает с сообщением).
//   mode: 'api'    — 2captcha / rucaptcha / anticaptcha (совместимый HTTP API),  --captcha-key.
//   mode: 'ocr'    — локальный tesseract.js (трехбуквенный шумный стиль сайта берёт плохо).
//
// Транспорт у сервисов капчи одинаковый:
//   in.php?key=KEY&method=base64&body=<base64>&json=1 → {status:1, request:<id>}
//   res.php?key=KEY&action=get&id=<id>&json=1          → {status:1, request:<text>}
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch } from 'undici';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function makeSolver({ mode = 'manual', key = '', endpoint = 'https://api.2captcha.com' } = {}) {
  if (mode === 'api') {
    if (!key) throw new Error('режим api требует --captcha-key (ключ 2captcha/rucaptcha)');
    return apiSolver(key, endpoint);
  }
  if (mode === 'ocr') return ocrSolver;
  return manualSolver;
}

// ── manual: спросить пользователя ──
const manualSolver = {
  async solve({ image, prompt }) {
    const file = join(__dirname, 'captcha-todo.png');
    writeFileSync(file, Buffer.from(image, 'base64'));
    // пробуем прочитать одну строку со stdin; если EOF/ошибка — подскажем путь
    process.stdout.write(`\n${prompt}\n`);
    process.stdout.write(`ОТКРОЙ ${file} и введи код с картинки (до 8 символов): `);
    try {
      process.stdin.resume();
      for await (const line of process.stdin) {
        const code = line.trim();
        if (code) return code;
      }
    } catch {}
    throw new Error(`не удалось прочитать код с консоли — открой ${file} и передай код через --captcha-code`);
  },
};

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
      // опрос каждые 5с до 3 минут
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

// ── ocr: tesseract.js, тупой one-shot (лучше не использовать) ──
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
      const text = data.text.replace(/\s+/g, '');
      return text.slice(0, 8);
    } finally {
      await worker.terminate();
    }
  },
};
