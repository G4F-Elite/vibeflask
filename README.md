# Byte Regent

The site is not served by a normal web server. Two OpenAI models do all the work: one writes a quick throwaway HTML page so the browser has something to show right away, the other one gets the actual raw HTTP request bytes and has to respond with raw HTTP response bytes. The server just glues it together and keeps some memory between requests.

If the model spits out broken HTML, you see broken HTML. Nothing cleans it up.

## What's in the repo

- `server.js` — everything lives here: TCP server, control panel, boot/prime paths, SSE bridge, prompt building
- `scripts/smoke.mjs` — smoke test that works without a real OpenAI key
- `.env.example` — sample config, copy it to `.env` and fill in your key
- `package.json` — start/dev/smoke/check scripts

## How it works

**Boot path** (browser navigates to a page):

1. Server sees it looks like a navigation request.
2. `gpt-5.4-mini` writes a quick provisional HTML page.
3. Server tacks on a tiny SSE script so the page can update itself later.
4. Meanwhile `gpt-5.4` works on the real response (raw HTTP, base64-encoded).
5. When that's done, the SSE pushes a `swap` and the whole page gets replaced.

**Prime path** (everything else: fetches, subresources, whatever):

No boot wrapper. Server just waits for `gpt-5.4` to finish. The model gets the exact request bytes and must return a full `HTTP/1.1` response in base64.

**Memory:**

The server process keeps stuff in RAM between requests:

- Global `siteMemory`
- Per-route `routeMemory` (keyed `METHOD target`)
- Short summaries of recent exchanges
- Previous response per route

Old/garbled memory is not fed back into prompts. Earlier versions did that and the output went to shit.

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
npm run check    # lint
```

## Config

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

## Routes

- `/__control` — change the site concept
- `/__health` — runtime status, boot state
- `/__live?visit=...` — SSE stream for the boot bridge
- everything else — model writes the response

## What this is and isn't

This is a deliberately unstable art project. There is no disk persistence, no HTML sanitizer, no fallback renderer. If the model writes garbage, that's the point. The "production-ready" bar here is: the README makes sense, there's a smoke test, the config doesn't leak keys, and you can clone and run it locally without guessing.