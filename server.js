import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadEnvFile(resolve(__dirname, ".env"));

const CONFIG = {
  port: parsePort(process.env.PORT, 3000),
  apiKey: (process.env.OPENAI_API_KEY || "").trim(),
  baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1")
    .trim()
    .replace(/\/+$/, ""),
  store: parseBoolean(process.env.OPENAI_STORE, true),
  primaryModel: (
    process.env.OPENAI_PRIMARY_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5.4"
  ).trim(),
  primaryReasoningEffort: (
    process.env.OPENAI_PRIMARY_REASONING_EFFORT ||
    process.env.OPENAI_REASONING_EFFORT ||
    "none"
  ).trim(),
};

const MAX_REQUEST_BYTES = 1024 * 1024;
const VISIT_TTL_MS = 20 * 60 * 1000;
const MAX_RECENT_SUMMARIES = 12;
const MAX_RECENT_EXCHANGES = 12;
const MAX_PREVIEW_CHARS = 6000;
const MAX_PREVIOUS_RESPONSE_BYTES = 120000;

const PRIME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    site_memory: { type: "string" },
    route_memory: { type: "string" },
    response_bytes_base64: { type: "string" },
  },
  required: ["summary", "site_memory", "route_memory", "response_bytes_base64"],
};

const STATE = {
  concept:
    "Сатирический сайт в режиме byte-regent: браузер бьется об сырой HTTP, а модель играет роль раздраженного сервера с харизмой.",
  revision: 1,
  siteMemory:
    "Fresh runtime. No meaningful requests have been completed yet. The site persona has not stabilized, but it should feel sharp, coherent, and full of charisma.",
  recentPrimeSummaries: [],
  recentExchanges: [],
  latestByRoute: new Map(),
  routeMemories: new Map(),
  visits: new Map(),
};

const CONTROL_PAGE_STYLE = `
body {
  margin: 0;
  font-family: "Aptos", "Segoe UI", sans-serif;
  color: #161110;
  background:
    radial-gradient(circle at top left, rgba(175, 72, 26, 0.18), transparent 30%),
    linear-gradient(140deg, #e8ddc6, #f6eedf 56%, #efe1c8);
}
main {
  width: min(980px, calc(100vw - 32px));
  margin: 24px auto;
  padding: 24px;
  border: 1px solid rgba(22, 17, 16, 0.1);
  border-radius: 28px;
  background: rgba(255, 250, 242, 0.84);
  box-shadow: 0 26px 80px rgba(63, 34, 16, 0.12);
}
h1, h2 { font-family: "Iowan Old Style", "Palatino Linotype", serif; margin: 0; }
h1 { font-size: clamp(38px, 5vw, 64px); line-height: 0.95; }
form, .grid, .card { display: grid; gap: 14px; }
textarea {
  min-height: 220px;
  resize: vertical;
  border: 1px solid rgba(22, 17, 16, 0.12);
  border-radius: 22px;
  padding: 16px 18px;
  font: inherit;
  line-height: 1.6;
  background: rgba(255, 255, 255, 0.72);
}
button, a.link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  border: 0;
  border-radius: 999px;
  padding: 12px 18px;
  font: inherit;
  font-weight: 700;
  text-decoration: none;
  color: #fff9f5;
  background: linear-gradient(135deg, #ac4c1e, #d66f31);
}
.link.secondary { color: #161110; background: rgba(22, 17, 16, 0.06); }
.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 18px; }
.card {
  padding: 16px;
  border: 1px solid rgba(22, 17, 16, 0.1);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.62);
}
.mono { font-family: "Consolas", monospace; font-size: 12px; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: 12px; }
pre { white-space: pre-wrap; margin: 0; }
@media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
`;

setInterval(pruneVisits, 60_000).unref();

export function createRawServer() {
  return net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on("error", () => {});

    let buffer = Buffer.alloc(0);
    let handled = false;

    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        sendTextResponse(socket, 413, "Payload Too Large", "Request too large.");
        return;
      }

      const request = tryParseRawHttpRequest(buffer);
      if (!request) {
        return;
      }

      handled = true;
      void handleRawRequest(socket, request).catch((error) => {
        const message =
          error instanceof Error ? error.message : "Unexpected raw server error.";
        if (!socket.destroyed) {
          sendTextResponse(socket, 500, "Internal Server Error", message);
        }
      });
    });
  });
}

export function startServer(port = CONFIG.port) {
  const server = createRawServer();
  server.listen(port, () => {
    const address = server.address();
    const actualPort =
      typeof address === "object" && address && typeof address.port === "number"
        ? address.port
        : port;
    console.log(
      `Byte Regent raw lab on http://localhost:${actualPort} | control: /__control | main: ${CONFIG.primaryModel}`
    );
  });
  return server;
}

async function handleRawRequest(socket, request) {
  if (request.path === "/__health") {
    return sendJsonResponse(socket, 200, {
      ok: true,
      concept: STATE.concept,
      revision: STATE.revision,
      primaryModel: CONFIG.primaryModel,
      primaryReasoningEffort: CONFIG.primaryReasoningEffort,
      hasApiKey: Boolean(CONFIG.apiKey),
      routeMemoryCount: STATE.routeMemories.size,
      visits: STATE.visits.size,
    });
  }

  if (request.path === "/__control" && request.method === "GET") {
    return sendHtmlResponse(socket, 200, renderControlPage());
  }

  if (request.path === "/__control" && request.method === "POST") {
    return handleControlUpdate(socket, request);
  }

  if (request.path === "/favicon.ico") {
    return sendBufferResponse(socket, 204, "No Content", [], Buffer.alloc(0));
  }

  if (request.method === "HEAD") {
    return sendBufferResponse(
      socket,
      200,
      "OK",
      [["Content-Type", "text/html; charset=utf-8"]],
      Buffer.alloc(0)
    );
  }

  return handleAiVisit(socket, request);
}

async function handleControlUpdate(socket, request) {
  const body = parseFormBody(request.bodyBuffer);
  const nextConcept = (body.get("concept") || "").trim();

  if (nextConcept) {
    STATE.concept = nextConcept;
    STATE.revision += 1;
    STATE.siteMemory =
      "Concept changed. Treat the next successful request as the first canonical turn of a new site. Reset the voice and rebuild it with coherent language and charisma.";
    STATE.latestByRoute.clear();
    STATE.routeMemories.clear();
    STATE.recentPrimeSummaries = [];
    STATE.recentExchanges = [];
  }

  return sendRedirect(socket, "/__control");
}

async function handleAiVisit(socket, request) {
  const visit = createVisit(request);

  try {
    const finalResponse = await runPrimeVisit(visit);
    socket.end(finalResponse.rawBytes);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Prime request failed.";
    sendTextResponse(socket, 502, "Bad Gateway", message);
  }
}

function createVisit(request) {
  const visit = {
    id: randomUUID(),
    createdAt: Date.now(),
    request,
    status: "queued",
    summary: "Waiting for the primary model to finish raw bytes.",
    finalResponse: null,
    error: null,
  };

  STATE.visits.set(visit.id, visit);
  return visit;
}

async function runPrimeVisit(visit) {
  const routeKey = getRouteKey(visit.request);
  const currentRouteMemory = normalizeModelText(
    STATE.routeMemories.get(routeKey),
    "No route-specific memory yet. This route has not stabilized.",
    2500
  );

  visit.status = "generating";

  if (!CONFIG.apiKey) {
    visit.status = "failed";
    visit.error = "OPENAI_API_KEY is empty.";
    throw new Error("OPENAI_API_KEY is empty. Put it into .env and restart the server.");
  }

  try {
    const response = await callOpenAiJson(buildPrimePayload(visit));
    const parsed = parsePrimeResponse(response.outputText);
    const responseBytes = decodeBase64Bytes(parsed.response_bytes_base64);
    const rawResponse = parseRawHttpResponse(responseBytes);

    visit.status = "ready";
    visit.summary = normalizeModelText(parsed.summary, "No summary.", 1200);
    visit.finalResponse = {
      rawBytes: responseBytes,
      rawResponse,
      summary: visit.summary,
    };

    STATE.siteMemory = normalizeModelText(parsed.site_memory, STATE.siteMemory, 4000);
    STATE.routeMemories.set(
      routeKey,
      normalizeModelText(parsed.route_memory, currentRouteMemory, 2500)
    );
    STATE.latestByRoute.set(routeKey, {
      rawBytes: responseBytes,
      summary: visit.summary,
      routeMemory: STATE.routeMemories.get(routeKey),
      updatedAt: Date.now(),
    });
    rememberPrimeSummary(`${visit.request.method} ${visit.request.path}: ${visit.summary}`);
    rememberExchange({
      routeKey,
      requestLine: `${visit.request.method} ${visit.request.target}`,
      summary: visit.summary,
      routeMemory: STATE.routeMemories.get(routeKey),
      statusLine: rawResponse.statusLine,
    });
    return visit.finalResponse;
  } catch (error) {
    visit.status = "failed";
    visit.error = error instanceof Error ? error.message : "Prime visit failed.";
    throw error instanceof Error ? error : new Error(visit.error);
  }
}

function buildPrimePayload(visit) {
  const routeKey = getRouteKey(visit.request);
  const previousForRoute = STATE.latestByRoute.get(routeKey);
  const previousBase64 =
    previousForRoute &&
    previousForRoute.rawBytes.length <= MAX_PREVIOUS_RESPONSE_BYTES &&
    isReusablePreviousResponse(previousForRoute.rawBytes)
      ? previousForRoute.rawBytes.toString("base64")
      : "(none or omitted because too large or looked corrupt)";

  return buildOpenAiPayload({
    model: CONFIG.primaryModel,
    reasoningEffort: CONFIG.primaryReasoningEffort,
    instructions: [
      "You are Byte Regent Prime.",
      "You are acting as a raw HTTP server at byte level.",
      "You receive exact request bytes and must author exact response bytes.",
      "Return JSON only with fields summary, site_memory, route_memory, and response_bytes_base64.",
      "response_bytes_base64 must decode to a full HTTP/1.1 response including status line, headers, CRLF separator, and body bytes.",
      "Use Connection: close. Do not use chunked encoding. Do not use Content-Length.",
      "For browser navigations, prefer complete HTML documents with inline CSS and JS.",
      "For HTML responses, use UTF-8 text/html unless you have a concrete reason not to.",
      "Do not use external assets, remote fonts, libraries, CDNs, or network calls.",
      "Only use fetch, XHR, EventSource, WebSocket, or other network APIs when the requested experience truly needs them.",
      "For games, toys, visual demos, calculators, editors, and small experiments, keep the whole experience local in one document whenever possible.",
      "Be concise. The first final response should be compact and ship fast, not expansive.",
      "Target a compact single-document response. Avoid giant walls of copy, giant CSS blocks, and giant JS blocks.",
      "Aim for a compact first response body, roughly under 8 KB unless the request truly requires more.",
      "Treat raw request bytes as authoritative. Read them carefully.",
      "Use cookies, query params, and request bodies when they are present. They are part of the site's runtime behavior.",
      "If you create continuity with cookies or hidden state, reflect that in site_memory and route_memory.",
      "site_memory is the durable global memory of the whole site across requests.",
      "route_memory is the durable memory of this specific route key.",
      "If the request is not for HTML, still respond sensibly at HTTP level.",
      "Visible copy, summary, site_memory, and route_memory must be coherent natural language.",
      "Do not output mojibake, replacement glyphs, broken transliteration, fake Russian, or random syllables.",
      "If writing Russian, write clear modern Russian. If you cannot say something well, say less.",
      "If Language target is Russian, then summary, site_memory, route_memory, and visible user-facing copy must all be in Russian. English is allowed only for protocol tokens like HTTP, JSON, HTML, JWT, GET, POST, and cookie names.",
      "Use short, fully grammatical sentences. Avoid ornate phrasing if it makes the sentence weaker.",
      "Give the server persona irritated charisma. In Russian text/html responses, use the exact word харизма naturally at least once.",
      "If you write HTML or CSS, only use syntax you are confident is valid.",
      "A page that throws a browser runtime exception counts as a bad response even if the markup looks plausible.",
      "There are no hidden data contracts. Do not invent object shapes or API fields unless the current request, your own defined route contract, or explicit user input established them.",
      "Before using any value from fetch, JSON, cookies, localStorage, sessionStorage, query params, form data, or previous app state, validate it and normalize it into a safe local shape with defaults.",
      "Never call .split, .map, .filter, .reduce, .trim, .toLowerCase, Object.keys, or destructure a value unless you already proved its type.",
      "If a field is absent, null, malformed, or the wrong type, degrade gracefully with empty strings, empty arrays, fallback objects, or reduced UI instead of throwing.",
      "Wrap app startup and async handlers in try/catch when failure would otherwise blank the page.",
      "Do not reference invented fields like result.blacklistSites unless you explicitly created and validated them.",
      "If the previous response for this route looked brittle, simplify or replace it instead of preserving its fragile structure.",
    ].join("\n"),
    inputText: buildPrimePrompt(visit, previousBase64),
    schema: PRIME_SCHEMA,
  });
}

function buildPrimePrompt(visit, previousBase64) {
  const routeKey = getRouteKey(visit.request);
  const requestPreview = truncateText(
    visit.request.rawBuffer.toString("utf8"),
    MAX_PREVIEW_CHARS
  );
  const recentSummaries = STATE.recentPrimeSummaries.length
    ? STATE.recentPrimeSummaries.map((entry, index) => `${index + 1}. ${entry}`).join("\n")
    : "none";
  const recentExchanges = STATE.recentExchanges.length
    ? STATE.recentExchanges
        .map(
          (entry, index) =>
            `${index + 1}. ${entry.requestLine} -> ${entry.statusLine} | ${entry.summary} | route_memory=${entry.routeMemory}`
        )
        .join("\n")
    : "none";
  const routeMemory = normalizeModelText(
    STATE.routeMemories.get(routeKey),
    "No route-specific memory yet. This route has not stabilized.",
    2500
  );

  return [
    `Timestamp: ${new Date().toISOString()}`,
    `Revision: ${STATE.revision}`,
    `Concept: ${STATE.concept}`,
    `Language target: ${detectLanguageHint(
      STATE.concept,
      visit.request.headersObject["accept-language"] || "",
      requestPreview
    )}`,
    `Route key: ${routeKey}`,
    "",
    "Host runtime facts:",
    "- Built-in routes that already exist: /__control (HTML form) and /__health (JSON).",
    "- No other host JSON/API routes already exist for you.",
    "- The browser is waiting on one blocking response from you. There is no boot page and no later hot-swap layer.",
    "- If you want extra routes, you must define their contract yourself and then keep answering them coherently on later requests.",
    "- For self-contained toys, games, and interactive demos, prefer zero network calls and fully local state.",
    "",
    "Site memory:",
    normalizeModelText(
      STATE.siteMemory,
      "Fresh runtime. Keep the voice coherent, sharp, and charismatic.",
      4000
    ),
    "",
    "Route memory:",
    routeMemory,
    "",
    "Recent prime summaries:",
    recentSummaries,
    "",
    "Recent exchanges:",
    recentExchanges,
    "",
    `Request method: ${visit.request.method}`,
    `Request target: ${visit.request.target}`,
    `Request path: ${visit.request.path}`,
    `Request headers JSON: ${JSON.stringify(visit.request.headersObject)}`,
    "",
    "Exact raw request bytes in base64:",
    visit.request.rawBuffer.toString("base64"),
    "",
    "UTF-8 preview of the same request bytes:",
    requestPreview,
    "",
    "Previous response for this route in base64:",
    previousBase64,
    "",
    "Previous response note:",
    "The previous response may contain your own bug. Reuse only what is clearly sound; replacing brittle JS is allowed.",
    "",
    "Return JSON only.",
  ].join("\n");
}

function buildOpenAiPayload({
  model,
  reasoningEffort,
  instructions,
  inputText,
  schema = null,
}) {
  const payload = {
    model,
    store: CONFIG.store,
    instructions,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: inputText }],
      },
    ],
  };

  if (reasoningEffort) {
    payload.reasoning = { effort: reasoningEffort };
  }

  if (schema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: "byte_regent_output",
        schema,
        strict: true,
      },
    };
  }

  return payload;
}

async function callOpenAiJson(payload) {
  const response = await fetch(`${CONFIG.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let data = {};

  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`OpenAI returned invalid JSON: ${rawText.slice(0, 240)}`);
    }
  }

  if (!response.ok) {
    throw new Error(
      `OpenAI API error: ${data?.error?.message || rawText.slice(0, 240) || response.status}`
    );
  }

  return {
    responseId: data.id || null,
    outputText: extractOutputText(data),
    raw: data,
  };
}

function extractOutputText(apiResponse) {
  if (typeof apiResponse.output_text === "string" && apiResponse.output_text.trim()) {
    return apiResponse.output_text.trim();
  }

  const chunks = [];
  for (const item of apiResponse.output || []) {
    if (item.type !== "message") {
      continue;
    }
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  if (chunks.length === 0) {
    throw new Error("No output text found in OpenAI response.");
  }

  return chunks.join("\n").trim();
}

function renderControlPage() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Byte Regent Control</title>
    <style>${CONTROL_PAGE_STYLE}</style>
  </head>
  <body>
    <main>
      <p>Control Surface</p>
      <h1>Byte Regent Raw HTTP Lab</h1>
      <p>Здесь задается идея сайта. Любой запрос блокируется до тех пор, пока ${escapeHtml(
        CONFIG.primaryModel
      )} не допишет полный сырой HTTP-ответ. Если модель или API падают, браузер получает ошибку без локальной маскировки.</p>

      <form method="post" action="/__control">
        <label for="concept">Идея сайта</label>
        <textarea id="concept" name="concept">${escapeHtml(STATE.concept)}</textarea>
        <div class="row">
          <button type="submit">Обновить концепт</button>
          <a class="link secondary" href="/" target="_blank" rel="noreferrer">Открыть сайт</a>
        </div>
      </form>

      <section class="grid">
        <article class="card">
          <h2>Состояние</h2>
          <pre>revision: ${STATE.revision}
visits.in.memory: ${STATE.visits.size}
routes.in.memory: ${STATE.routeMemories.size}
primary.model: ${escapeHtml(CONFIG.primaryModel)}
primary.reasoning: ${escapeHtml(CONFIG.primaryReasoningEffort || "none")}
api.key.present: ${CONFIG.apiKey ? "yes" : "no"}</pre>
        </article>
        <article class="card">
          <h2>Recent Prime Summaries</h2>
          <pre>${escapeHtml(
            STATE.recentPrimeSummaries.length
              ? STATE.recentPrimeSummaries.join("\n")
              : "none"
          )}</pre>
        </article>
        <article class="card">
          <h2>Site Memory</h2>
          <pre>${escapeHtml(STATE.siteMemory || "-")}</pre>
        </article>
        <article class="card">
          <h2>Recent Exchanges</h2>
          <pre>${escapeHtml(
            STATE.recentExchanges.length
              ? STATE.recentExchanges
                  .map(
                    (entry) =>
                      `${entry.requestLine} -> ${entry.statusLine} | ${entry.summary}`
                  )
                  .join("\n")
              : "none"
          )}</pre>
        </article>
        <article class="card">
          <h2>Blocking Mode</h2>
          <pre>${escapeHtml(
            `Every site request waits for ${CONFIG.primaryModel} to finish and then returns its raw HTTP bytes directly.`
          )}</pre>
        </article>
      </section>
    </main>
  </body>
</html>`;
}

function tryParseRawHttpRequest(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return null;
  }

  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const [method, target, version] = (lines.shift() || "").split(" ");

  if (!method || !target || !version) {
    throw new Error("Malformed HTTP request line.");
  }

  const headers = [];
  const headersObject = {};
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const name = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    headers.push([name, value]);
    headersObject[name.toLowerCase()] = value;
  }

  const contentLength = Number(headersObject["content-length"] || 0);
  const totalLength = headerEnd + 4 + contentLength;
  if (buffer.length < totalLength) {
    return null;
  }

  const rawBuffer = buffer.subarray(0, totalLength);
  const bodyBuffer = rawBuffer.subarray(headerEnd + 4);
  const host = headersObject.host || "localhost";
  const url = new URL(target, `http://${host}`);

  return {
    rawBuffer,
    bodyBuffer,
    method,
    target,
    version,
    path: url.pathname,
    url,
    headers,
    headersObject,
  };
}

function parseRawHttpResponse(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error("Model response bytes are missing HTTP header separator.");
  }

  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const statusLine = lines.shift() || "HTTP/1.1 200 OK";
  const headers = [];
  const headersObject = {};

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const name = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    headers.push([name, value]);
    headersObject[name.toLowerCase()] = value;
  }

  const bodyBuffer = buffer.subarray(headerEnd + 4);
  const contentType = headersObject["content-type"] || "";

  return {
    statusLine,
    headers,
    headersObject,
    bodyBuffer,
    contentType,
    isHtml: /text\/html/i.test(contentType) || bodyBuffer.toString("utf8").includes("<html"),
  };
}

function parseJsonText(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`Model returned invalid JSON: ${cleaned.slice(0, 320)}`);
  }
}

function parsePrimeResponse(text) {
  const parsed = parseJsonText(text);

  if (
    typeof parsed.summary !== "string" ||
    typeof parsed.site_memory !== "string" ||
    typeof parsed.route_memory !== "string" ||
    typeof parsed.response_bytes_base64 !== "string"
  ) {
    throw new Error("Prime response is missing one of summary/site_memory/route_memory/response_bytes_base64.");
  }

  return parsed;
}

function decodeBase64Bytes(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Base64 field is empty.");
  }
  return Buffer.from(value.replace(/\s+/g, ""), "base64");
}

function parseFormBody(bodyBuffer) {
  return new URLSearchParams(bodyBuffer.toString("utf8"));
}

function rememberPrimeSummary(summary) {
  STATE.recentPrimeSummaries.unshift(summary);
  if (STATE.recentPrimeSummaries.length > MAX_RECENT_SUMMARIES) {
    STATE.recentPrimeSummaries.splice(MAX_RECENT_SUMMARIES);
  }
}

function rememberExchange(exchange) {
  STATE.recentExchanges.unshift({
    routeKey: truncateText(exchange.routeKey, 180),
    requestLine: truncateText(exchange.requestLine, 240),
    summary: truncateText(exchange.summary, 400),
    routeMemory: truncateText(exchange.routeMemory, 260),
    statusLine: truncateText(exchange.statusLine, 140),
  });

  if (STATE.recentExchanges.length > MAX_RECENT_EXCHANGES) {
    STATE.recentExchanges.splice(MAX_RECENT_EXCHANGES);
  }
}

function getRouteKey(request) {
  return `${request.method} ${request.target}`;
}

function pruneVisits() {
  const now = Date.now();
  for (const [visitId, visit] of STATE.visits.entries()) {
    if (now - visit.createdAt > VISIT_TTL_MS) {
      STATE.visits.delete(visitId);
    }
  }
}

function sendRedirect(socket, location) {
  socket.end(
    Buffer.from(
      `HTTP/1.1 303 See Other\r\nLocation: ${location}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`,
      "utf8"
    )
  );
}

function sendHtmlResponse(socket, statusCode, html) {
  return sendBufferResponse(
    socket,
    statusCode,
    statusCode === 200 ? "OK" : "Error",
    [["Content-Type", "text/html; charset=utf-8"]],
    Buffer.from(html, "utf8")
  );
}

function sendJsonResponse(socket, statusCode, payload) {
  return sendBufferResponse(
    socket,
    statusCode,
    statusCode === 200 ? "OK" : "Error",
    [["Content-Type", "application/json; charset=utf-8"]],
    Buffer.from(JSON.stringify(payload), "utf8")
  );
}

function sendTextResponse(socket, statusCode, reason, text) {
  return sendBufferResponse(
    socket,
    statusCode,
    reason,
    [["Content-Type", "text/plain; charset=utf-8"]],
    Buffer.from(text, "utf8")
  );
}

function sendBufferResponse(socket, statusCode, reason, headers, bodyBuffer) {
  const lines = [`HTTP/1.1 ${statusCode} ${reason}`];
  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Content-Length: ${bodyBuffer.length}`);
  lines.push("Connection: close");
  lines.push("");
  lines.push("");

  const headerBuffer = Buffer.from(lines.join("\r\n"), "utf8");
  socket.end(Buffer.concat([headerBuffer, bodyBuffer]));
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseBoolean(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }
  return fallback;
}

function detectLanguageHint(...samples) {
  const text = samples.filter(Boolean).join(" ");
  const cyrillic = (text.match(/[А-Яа-яЁё]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cyrillic > latin) {
    return "Russian";
  }
  if (latin > 0) {
    return "English";
  }
  return "Russian";
}

function looksCorruptedText(value) {
  const text = String(value || "");
  if (!text.trim()) {
    return false;
  }

  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(text)) {
    return true;
  }

  const mojibakeHits = (text.match(/[ÐÑÃâ]/g) || []).length;
  const cyrillicHits = (text.match(/[А-Яа-яЁё]/g) || []).length;
  if (mojibakeHits >= 6 && cyrillicHits <= 2) {
    return true;
  }

  return false;
}

function normalizeModelText(value, fallback, limit) {
  const candidate = truncateText(value, limit).replace(/\u0000/g, "").trim();
  if (!candidate || looksCorruptedText(candidate)) {
    return fallback;
  }
  return candidate;
}

function isReusablePreviousResponse(rawBytes) {
  try {
    const parsed = parseRawHttpResponse(rawBytes);
    const contentType = String(parsed.contentType || "").toLowerCase();
    if (parsed.isHtml || /json|text|xml|javascript|svg/.test(contentType)) {
      return !looksCorruptedText(parsed.bodyBuffer.toString("utf8"));
    }
    return true;
  } catch {
    return false;
  }
}

function truncateText(value, limit) {
  return String(value || "").replace(/\r/g, "").slice(0, limit);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  startServer();
}
