# huevo-clicker

Автокликер для https://huevo.su: автологин с капчей, автосохранение и переиспользование
кук в `cookie.txt`, одноаккаунтный режим. Без прокси, без фермы.

## Быстрый старт

```bash
# 1. Зависимости (Node 18+)
npm i

# 2. Креды — один из способов:
#    А) файл creds.txt
cp creds.txt.example creds.txt
#    Б) env
set HUE_USER=magazinedreams
set HUE_PASS=77887788
#    В) флаги
npm start -- --user magazinedreams --pass 77887788

# 3. Запуск (в интерактивном терминале! потребуется ввести код капчи)
npm start
```

## Что делает автологин

1. **Антибот (418).** Сайт отдаёт челлендж `data-hchk-a` / `data-hchk-b` —
   побайтовый XOR даёт куку `hchk`, запрос повторяется, как их JS.
2. **Капча.** Снимает свежую пару `captcha_token` + картинку через
   `GET /captcha/refresh/login`, отдаёт картинку солверу:
   - `manual` (по умолчанию) — картинка улетает в **Discord-вебхук** (если задан)
     и сохраняется в `captcha-todo.png`; код вводится с клавиатуры (или кладётся
     в файл `captcha_code.txt` — для неинтерактивного запуска).
   - `api` — платный сервис: `--captcha-mode api --captcha-key КЛЮЧ`
     (2captcha / rucaptcha / anticaptcha — совместимый API).
3. **Логин.** `POST /login` с полями `hv` (обратный `data-k`), `username`,
   `password`, `remember=on`, `captcha` и `captcha_token`.
4. **Подтверждение.** Проверяет сессию на `/clicker`; после успеха **сохраняет куки**
   в `cookie.txt` автоматически.
5. **Переиспользование.** При следующем запуске читает `cookie.txt`; если сессия жива —
   логина не делает (никакой капчи). Умерла — перелогинивается сам во время работы (401/403).

## Флаги

```
--user, --pass       логин/пароль
--clicks N           кликов за запрос (400 — макс. сервера MAX_BATCH)
--delay S            пауза между запросами в сек (8 — MIN_GAP_SECONDS сервера)
--limit N            макс. запросов (0 = бесконечно)
--duration M         минут работы (0 = до Ctrl+C)
--login-only         только войти и сохранить куки в cookie.txt
--dry-run            показать что бы сделали, без сетевых запросов
--no-cookies         не читать/писать cookie.txt

# капча
--captcha-mode M     manual (по умолчанию) | api | ocr
--captcha-key KEY    ключ сервиса капчи (mode=api)
--captcha-endpoint U адрес сервиса (по умолчанию https://2captcha.com)
--captcha-code CODE  готовый код капчи (неинтерактивный запуск, совпадает со свежей картинкой)
--discord-webhook URL   слать картинку капчи в Discord (или env / creds.txt: discord_webhook)
```

## Примеры

```bash
# Работать час (спросит капчу один раз при входе)
npm start -- --duration 60

# Только войти и проверить, что креды+капча ок
npm run login

# Капча через платный сервис
npm start -- --captcha-mode api --captcha-key 1234567890abcdef

# Картинку капчи в Discord, код — в консоль (или в файл captcha_code.txt)
npm start -- --discord-webhook https://discord.com/api/webhooks/...

# Неинтерактивно: посмотрел captcha-todo.png (или Discord), ввёл код
npm start -- --captcha-code XYZ
```

## ⚠️ Важно

- **Блокировка входа.** После нескольких неверных попыток входа сервер выставляет
  HTTP 429 «Слишком много неудачных попыток входа» на ~5 минут для IP. Скрипт уважает
  это и останавливается, но не спамь вход сломанным солвером.
- **Сессия важнее входа.** Пока жива кука `session`, капча вообще не нужна — не чисти
  `cookie.txt` без причины.
- **Капча обязательна** на форме `/login` (добавлена недавно); локальный OCR
  (`tesseract.js`) на этом шумном стиле капчи почти не справляется — используй
  `manual` или `api`.

## Структура

```
├── package.json
├── site.mjs            # HTTP: антибот, капча, логин, кликер, cookie-store
├── captcha-solver.mjs  # солверы капчи: manual / api (2captcha) / ocr
├── clicker.mjs         # CLI: цикл кликов, автологин, авторелогин
├── creds.txt           # (gitignored) логин/пароль + настройки капчи
├── cookie.txt          # (gitignored) куки, сохраняются/читаются автоматически
└── README.md
```
