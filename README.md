# Byte Regent

Сатирическая лаборатория, где сайт притворяется живым HTTP-сервером, а модели получают сырые байты запроса и сами пишут байты ответа.

Это не “обычный SSR”. Здесь идея ровно в другом:

- `gpt-5.4-mini` отдает быструю provisional-страницу для первого открытия
- `gpt-5.4` получает raw request bytes и пишет raw HTTP response bytes
- сервер держит runtime memory между запросами
- клиент получает мгновенный boot, а потом SSE-замену на финальный ответ
- кривой модельный HTML не “приукрашивается” локальным дизайнерским фронтом

## Что в репозитории

- [server.js](/C:/Users/Ko20/Desktop/dfgdfg/bue/vibeflask/server.js) — весь рантайм: raw TCP server, control surface, boot path, prime path, SSE bridge, prompt assembly
- [scripts/smoke.mjs](/C:/Users/Ko20/Desktop/dfgdfg/bue/vibeflask/scripts/smoke.mjs) — локальный smoke-check без реального OpenAI key
- [.env.example](/C:/Users/Ko20/Desktop/dfgdfg/bue/vibeflask/.env.example) — пример конфига
- [package.json](/C:/Users/Ko20/Desktop/dfgdfg/bue/vibeflask/package.json) — скрипты запуска и проверки

## Как это работает

### 1. Boot path

Когда браузер открывает страницу как документ:

1. сервер определяет navigation-like запрос
2. `gpt-5.4-mini` пишет provisional HTML
3. сервер добавляет только маленький live bridge через SSE
4. `gpt-5.4` параллельно пишет полноценный raw HTTP response
5. когда финальный ответ готов, клиент получает `swap` и документ заменяется целиком

### 2. Prime path

Для non-navigation запросов никакой boot-обертки нет:

- сервер ждет `gpt-5.4`
- модель получает exact raw request bytes
- модель обязана вернуть full HTTP/1.1 response в base64

### 3. Runtime memory

Сервер хранит в памяти процесса:

- глобальную `siteMemory`
- `routeMemory` по ключу `METHOD target`
- краткие summary последних обменов
- предыдущий ответ по маршруту

При этом в prompt больше не подмешиваются явно битые summary/memory/previous response, чтобы модель не отравлялась старым мусором и не скатывалась в несвязный текст.

## Почему текст теперь лучше

В prompt ужесточены правила:

- язык вывода привязывается к концепту и заголовкам запроса
- visible copy должна быть связной, без mojibake и псевдо-русского мусора
- у server persona должна быть раздраженная харизма
- слово `харизма` подталкивается в русских HTML-ответах как часть тона
- boot и prime path больше не кормятся явно битой памятью

Важно: сам raw HTML от модели по-прежнему не “редактируется в красоту”. Если модель прислала странный HTML, клиент увидит именно его.

## Быстрый старт

1. Скопируй пример конфига:

```bash
copy .env.example .env
```

2. Заполни `OPENAI_API_KEY` в `.env`

3. Запусти сервер:

```bash
npm start
```

4. Открой:

- `http://localhost:3000/__control`
- `http://localhost:3000/`

## Команды

```bash
npm start
npm run dev
npm run smoke
npm run check
```

`npm run smoke` не требует реального OpenAI key: скрипт специально поднимает сервер с пустым ключом и проверяет локальные ветки поведения.

## Конфиг

```env
OPENAI_API_KEY=
OPENAI_PRIMARY_MODEL=gpt-5.4
OPENAI_PRIMARY_REASONING_EFFORT=none
OPENAI_PRIMARY_MAX_OUTPUT_TOKENS=6000
OPENAI_BOOT_MODEL=gpt-5.4-mini
OPENAI_BOOT_REASONING_EFFORT=medium
OPENAI_BOOT_MAX_OUTPUT_TOKENS=3000
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_STORE=true
PORT=3000
```

## Важные маршруты

- `/__control` — ручка для смены концепта
- `/__health` — статус рантайма и boot state
- `/__live?visit=...` — SSE stream для boot bridge
- `/` и любые другие неслужебные пути — model-driven site

## Ограничения

- это намеренно нестабильный арт-проект, а не надежный production stack
- нет дисковой персистентности памяти, только RAM
- нет локального sanitize/render-layer, который “спасает” плохой HTML от модели
- если модель пишет плохой raw response, это часть эксперимента

## Что здесь считается “почти продом”

Для этого репо “нормальное состояние” означает:

- понятный README
- пример конфига без утечки реального ключа
- smoke-check
- чистый git-репозиторий без мусорных логов
- внятные prompt-ограничения для языка, тона и структуры
- воспроизводимый локальный запуск
