# Byte Regent

This repo is a raw HTTP toy server where one OpenAI model receives the exact request bytes and writes the exact response bytes. There is no boot page anymore, no second model, and no client-side hot swap. The browser just waits until the primary model finishes.

If the model returns broken HTML, broken JS, or malformed design, you see that. If the model call fails, the server returns an error directly.

## What's in the repo

- `server.js` — raw TCP HTTP server, control panel, prompt building, runtime memory
- `scripts/smoke.mjs` — smoke test that runs without a real OpenAI key
- `.env.example` — sample config
- `package.json` — start/dev/check scripts

## How it works

1. The server reads the raw HTTP request bytes from the socket.
2. It sends those exact bytes to `gpt-5.4`.
3. The model must return JSON with `summary`, `site_memory`, `route_memory`, and `response_bytes_base64`.
4. `response_bytes_base64` must decode to a full `HTTP/1.1` response.
5. The server returns those bytes to the client as-is.

There is no placeholder shell while waiting. A page load can hang for a while if the model thinks for a while.

## Memory

The process keeps a little runtime context in RAM:

- global `siteMemory`
- per-route `routeMemory`
- short summaries of recent exchanges
- previous response per route

Corrupted memory is filtered before it goes back into the next prompt.

## Quick start

```bash
copy .env.example .env
# put your OPENAI_API_KEY in .env
npm start
```

Then open `http://localhost:3000/__control` or `http://localhost:3000/`.

## Scripts

```bash
npm start        # run the server
npm run dev      # run with --watch
npm run smoke    # smoke test, no real API key needed
npm run check    # syntax check + smoke
```

## Config

```env
OPENAI_API_KEY=
OPENAI_PRIMARY_MODEL=gpt-5.4
OPENAI_PRIMARY_REASONING_EFFORT=none
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_STORE=true
PORT=3000
```

## Routes

- `/__control` — edit the site concept
- `/__health` — inspect runtime state
- everything else — one blocking request to the primary model

## Failure mode

If `OPENAI_API_KEY` is missing or the Responses API errors, the server answers with `502 Bad Gateway` and the error text. It does not synthesize a nicer page.
