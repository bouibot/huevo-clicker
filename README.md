# huevo-clicker

Автокликер для https://huevo.su с автологином. Одиночный аккаунт, без прокси, без фермы.

## Быстрый старт

```bash
# 1. Установи зависимости (Node 18+)
npm i

# 2. Настрой креды (один из способов):
#    А) Файл creds.txt (не коммитится в git)
cp creds.txt.example creds.txt
#    отредактируй creds.txt: user=твой_логин / pass=твой_пароль

#    Б) Переменные окружения
set HUE_USER=magazinedreams
set HUE_PASS=77887788

#    В) Флаги командной строки
npm start -- --user magazinedreams --pass 77887788

# 3. Запуск
npm start
```

## Флаги

```
--user, --pass        логин/пароль
--clicks N            кликов за запрос (400 — макс. сервера MAX_BATCH)
--delay S             пауза между запросами в секундах (8 — MIN_GAP_SECONDS сервера)
--limit N             макс. запросов (0 = бесконечно)
--duration M          минут работы (0 = до Ctrl+C)
--login-only          только войти и сохранить куки в cookie.txt
--dry-run             показать что бы сделали, не делая запрос
```

## Примеры

```bash
# 100 запросов по 400 кликов с паузой 8с
npm start -- --clicks 400 --delay 8 --limit 100

# Работать 60 минут
npm start -- --duration 60

# Только войти (проверить что креды работают)
npm run login
# или
npm start -- --login-only
```

## Как это работает

1. **Антибот (418)** — на чёллендж `data-hchk-a` / `data-hchk-b` делает побайтовый XOR и ставит куку, как их JS.
2. **Логин** — `GET /login` → берём `data-k` → `POST /login` с полями `username`, `password`, `remember`, `hv` (строка `data-k` в обратном порядке).
3. **Кликер** — `POST /api/clicker` с `clicks=N`. Серверные лимиты: `MIN_GAP_SECONDS=8000`, `MAX_BATCH=400`; за нарушение отвечает `{"error":"slow","retry":N}`.
4. **Авторелогин** — при 401/403 или сетевых ошибках автоматически перелогинивается.

## Тестовые креды

```
user: magazinedreams
pass: 77887788
```

## Структура

```
├── package.json
├── site.mjs        # HTTP-слой: антибот, логин, кликер
├── clicker.mjs     # CLI: аргументы, цикл кликов, автологин
├── creds.txt       # (gitignored) логин/пароль
├── cookie.txt      # (gitignored) куки после --login-only
├── .gitignore
└── README.md
```