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
  primaryMaxOutputTokens: parseOptionalPositiveInt(
    process.env.OPENAI_PRIMARY_MAX_OUTPUT_TOKENS,
    6000
  ),
  bootModel: (process.env.OPENAI_BOOT_MODEL || "gpt-5.4-mini").trim(),
  bootReasoningEffort: (
    process.env.OPENAI_BOOT_REASONING_EFFORT || "medium"
  ).trim(),
  bootMaxOutputTokens: parseOptionalPositiveInt(
    process.env.OPENAI_BOOT_MAX_OUTPUT_TOKENS,
    3000
  ),
};

const MAX_REQUEST_BYTES = 1024 * 1024;
const VISIT_TTL_MS = 20 * 60 * 1000;
const MAX_RECENT_SUMMARIES = 12;
const MAX_RECENT_EXCHANGES = 12;
const MAX_PREVIEW_CHARS = 6000;
const MAX_PREVIOUS_RESPONSE_BYTES = 120000;
let bootRefreshPromise = null;

const BOOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    response_bytes_base64: { type: "string" },
  },
  required: ["summary", "response_bytes_base64"],
};

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
  boot: {
    status: "idle",
    summary: "Boot page not generated yet.",
    responseTemplateText: "",
    error: null,
    generatedAt: 0,
    model: "fallback",
    reason: "startup",
  },
  recentPrimeSummaries: [],
  recentExchanges: [],
  latestByRoute: new Map(),
  routeMemories: new Map(),
  visits: new Map(),
  bootRequestSerial: 0,
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
queueBootRefresh("startup");

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
      `Byte Regent raw lab on http://localhost:${actualPort} | control: /__control | main: ${CONFIG.primaryModel} | boot: ${CONFIG.bootModel}`
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
      bootModel: CONFIG.bootModel,
      hasApiKey: Boolean(CONFIG.apiKey),
      bootStatus: STATE.boot.status,
      bootSummary: STATE.boot.summary,
      bootError: STATE.boot.error,
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

  if (request.path === "/__live" && request.method === "GET") {
    return handleLiveStream(socket, request);
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

  void queueBootRefresh("control-update");
  return sendRedirect(socket, "/__control");
}

function handleLiveStream(socket, request) {
  const visitId = request.url.searchParams.get("visit") || "";
  const visit = STATE.visits.get(visitId);

  if (!visit) {
    return sendTextResponse(socket, 404, "Not Found", "Visit not found.");
  }

  startSseResponse(socket);
  visit.clients.add(socket);
  socket.on("close", () => {
    visit.clients.delete(socket);
  });

  for (const event of visit.events) {
    sendSseEvent(socket, event.type, event.payload);
  }

  if (visit.status === "ready" || visit.status === "failed") {
    endSseResponse(socket);
  }
}

async function handleAiVisit(socket, request) {
  const deliveryMode = isNavigationRequest(request) ? "boot" : "blocking";
  const visit = createVisit(request, deliveryMode);

  if (deliveryMode === "boot") {
    await ensureBootTemplateReady();
    const bootBytes = renderBootResponseBytes(visit);
    socket.end(bootBytes);
    void runPrimeVisit(visit);
    return;
  }

  try {
    const finalResponse = await runPrimeVisit(visit, { throwOnError: true });
    socket.end(finalResponse.rawBytes);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Prime request failed.";
    sendTextResponse(socket, 502, "Bad Gateway", message);
  }
}

async function ensureBootTemplateReady() {
  if (STATE.boot.responseTemplateText) {
    return;
  }

  if (bootRefreshPromise) {
    await bootRefreshPromise;
    return;
  }

  await queueBootRefresh("on-demand");
}

function createVisit(request, deliveryMode) {
  const visit = {
    id: randomUUID(),
    createdAt: Date.now(),
    request,
    deliveryMode,
    status: "booted",
    summary: "Waiting for the main model to finish raw bytes.",
    progressChars: 0,
    finalResponse: null,
    error: null,
    clients: new Set(),
    events: [],
  };

  STATE.visits.set(visit.id, visit);
  pushVisitEvent(visit, "phase", {
    label: "boot-sent",
    message: `${CONFIG.bootModel} boot page sent for ${request.method} ${request.target}.`,
  });
  return visit;
}

async function runPrimeVisit(visit, options = {}) {
  const throwOnError = options.throwOnError === true;
  const routeKey = getRouteKey(visit.request);
  const currentRouteMemory = normalizeModelText(
    STATE.routeMemories.get(routeKey),
    "No route-specific memory yet. This route has not stabilized.",
    2500
  );

  visit.status = "generating";
  pushVisitEvent(visit, "phase", {
    label: "prime-connected",
    message: `${CONFIG.primaryModel} took ownership of raw request bytes.`,
  });

  if (!CONFIG.apiKey) {
    visit.status = "failed";
    visit.error = "OPENAI_API_KEY is empty.";
    pushVisitEvent(visit, "error", {
      message: "OPENAI_API_KEY is empty. Put it into .env and restart the server.",
    });
    closeVisitClients(visit);
    if (throwOnError) {
      throw new Error(visit.error);
    }
    return null;
  }

  let streamedText = "";

  try {
    const response = await streamOpenAiText(buildPrimePayload(visit), (delta) => {
      streamedText += delta;
      visit.progressChars = streamedText.length;
      if (visit.progressChars % 700 < delta.length) {
        pushVisitEvent(visit, "progress", {
          chars: visit.progressChars,
          note: "main model is still writing raw response bytes",
        });
      }
    });

    const parsed = parsePrimeResponse(streamedText || response.outputText);
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

    pushVisitEvent(visit, "log", {
      message: visit.summary,
    });

    if (rawResponse.isHtml) {
      pushVisitEvent(visit, "swap", {
        html_base64: rawResponse.bodyBuffer.toString("base64"),
        status_line: rawResponse.statusLine,
        content_type: rawResponse.contentType,
      });
    } else {
      pushVisitEvent(visit, "swap", {
        html_base64: Buffer.from(renderNonHtmlResult(rawResponse), "utf8").toString(
          "base64"
        ),
        status_line: rawResponse.statusLine,
        content_type: "text/html; charset=utf-8",
      });
    }

    closeVisitClients(visit);
    return visit.finalResponse;
  } catch (error) {
    visit.status = "failed";
    visit.error = error instanceof Error ? error.message : "Prime visit failed.";
    pushVisitEvent(visit, "error", {
      message: visit.error,
    });
    closeVisitClients(visit);
    if (throwOnError) {
      throw error instanceof Error ? error : new Error(visit.error);
    }
    return null;
  }
}

async function refreshBootTemplate(reason) {
  if (!CONFIG.apiKey) {
    STATE.boot = {
      status: "fallback",
      summary: "No API key, using deterministic boot page.",
      responseTemplateText: buildMinimalBootHtml(),
      error: "OPENAI_API_KEY is empty.",
      generatedAt: Date.now(),
      model: "fallback",
      reason,
    };
    return;
  }

  const revision = STATE.revision;
  const requestSerial = ++STATE.bootRequestSerial;
  STATE.boot.status = "generating";
  STATE.boot.reason = reason;
  STATE.boot.error = null;

  try {
    const bootResult = await generateBootResult(revision);

    if (revision !== STATE.revision || requestSerial !== STATE.bootRequestSerial) {
      return;
    }

    STATE.boot = {
      status: "ready",
      summary: truncateText(bootResult.summary || "Boot page ready.", 1000),
      responseTemplateText: bootResult.templateText,
      error: null,
      generatedAt: Date.now(),
      model: CONFIG.bootModel,
      reason,
    };
  } catch (error) {
    if (requestSerial !== STATE.bootRequestSerial) {
      return;
    }
    STATE.boot = {
      status: "fallback",
      summary: "Boot model failed, using deterministic boot page.",
      responseTemplateText: buildMinimalBootHtml(),
      error: error instanceof Error ? error.message : "Boot generation failed.",
      generatedAt: Date.now(),
      model: "fallback",
      reason,
    };
  }
}

function queueBootRefresh(reason) {
  const refreshTask = refreshBootTemplate(reason)
    .catch(() => {})
    .finally(() => {
      if (bootRefreshPromise === refreshTask) {
        bootRefreshPromise = null;
      }
    });

  bootRefreshPromise = refreshTask;
  return refreshTask;
}

async function generateBootResult(revision) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await callOpenAiJson(buildBootPayload(revision));
      const parsed = parseJsonText(response.outputText);
      const templateBytes = decodeBase64Bytes(parsed.response_bytes_base64);
      const templateText = normalizeBootTemplate(templateBytes.toString("utf8"));
      return {
        summary: parsed.summary,
        templateText,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Boot generation failed.");
      if (!isRetryableBootError(lastError) || attempt === 2) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error("Boot generation failed.");
}

function isRetryableBootError(error) {
  const message = String(error?.message || "");
  return /No output text found|OpenAI API error|invalid JSON|streaming response body is missing/i.test(
    message
  );
}

function buildBootPayload(revision) {
  return buildOpenAiPayload({
    model: CONFIG.bootModel,
    reasoningEffort: CONFIG.bootReasoningEffort,
    maxOutputTokens: CONFIG.bootMaxOutputTokens,
    instructions: [
      "You are the fast first-byte page generator for a raw HTTP experiment.",
      "Return JSON only.",
      "You must author boot-page bytes encoded in base64.",
      "The response must be an immediately renderable provisional HTML page and must NOT be the final site.",
      "Prefer a standalone HTML document over a full HTTP response.",
      "Prefer starting the decoded bytes with <!doctype html>.",
      "The bytes may decode either to a full HTTP/1.1 response or to a standalone HTML document.",
      "Do not use external assets, fonts, libraries, imports, or network fetches.",
      "Do not emit script tags. The server injects the only live bridge.",
      "Keep the page rough, partial, and visibly in-progress.",
      "Do not produce a polished marketing landing page, full dashboard, or full app shell.",
      "Keep the HTML and CSS compact. This is a fast provisional page, not a giant page.",
      "Keep the provisional body reasonably small, around a few kilobytes, so it ships immediately.",
      "Focus on the visible provisional page only. The transport bridge will be injected by the server.",
      "The provisional page should visibly relate to the current site concept.",
      "Prefer one screen, one motif, and very little copy.",
      "Do not return an empty body.",
      "Do not return only CSS, only style tags, only head tags, or a nearly blank document.",
      "Do not imitate Cloudflare challenge pages, captcha pages, browser interstitials, or copied site chrome.",
      "Always include a visible scene with at least: one headline, one short paragraph, and one concrete visual block or panel.",
      "Include at least two distinct visible elements in the body, for example a hero plus a log, a manifesto plus a panel grid, or a poster plus a warning block.",
      "Make the scene feel authored: pick a mood, a color direction, and a point of view tied to the concept.",
      "If the concept is weird or satirical, lean into that instead of falling back to generic placeholder markup.",
      "Match the language of the concept. If the concept is mostly Russian, write mostly Russian.",
      "Write coherent natural-language copy only. Every visible sentence must read like a real sentence written by a fluent human.",
      "Do not output mojibake, replacement glyphs, broken transliteration, random syllables, or fake Russian.",
      "If writing Russian, use proper modern Russian words and grammar. If you are unsure, write fewer sentences, not weirder sentences.",
      "If Language target is Russian, then title, headline, paragraph text, panel labels, and summary must all be in Russian. English is allowed only for protocol tokens like HTTP or JWT.",
      "Use short, clean sentences. One sharp sentence beats three broken sentences.",
      "Give the page irritated charisma. If the page is mostly Russian, use the exact word харизма naturally once in visible copy.",
      "Use valid HTML5 with balanced tags and sane CSS syntax.",
      "Use only CSS properties, selectors, values, and units you are confident are valid.",
      "If you are unsure about CSS, use less CSS instead of broken CSS.",
      "Do not invent pseudo-HTTP headers, fake CDN banners, or broken protocol text inside the page body.",
    ].join("\n"),
    inputText: [
      `Revision: ${revision}`,
      `Concept: ${STATE.concept}`,
      `Language target: ${detectLanguageHint(STATE.concept, STATE.siteMemory)}`,
      `Current site memory: ${normalizeModelText(STATE.siteMemory, "Fresh runtime.", 1200)}`,
      "",
      "Tone sample, do not copy verbatim:",
      "Сервер огрызается, но держит форму. В этом бардаке у него все еще есть харизма.",
      "",
      "Preferred HTML shape:",
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>...</title><style>...</style></head><body><main><h1>...</h1><p>...</p><section>...</section></main></body></html>",
      "",
      "Return schema:",
      JSON.stringify(
        {
          summary: "short summary",
          response_bytes_base64: "base64 raw HTTP response bytes",
        },
        null,
        2
      ),
    ].join("\n"),
    schema: BOOT_SCHEMA,
  });
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
    maxOutputTokens: CONFIG.primaryMaxOutputTokens,
    stream: true,
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
    "Return JSON only.",
  ].join("\n");
}

function buildOpenAiPayload({
  model,
  reasoningEffort,
  maxOutputTokens,
  instructions,
  inputText,
  stream = false,
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
    stream,
  };

  if (reasoningEffort) {
    payload.reasoning = { effort: reasoningEffort };
  }

  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) {
    payload.max_output_tokens = maxOutputTokens;
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

async function streamOpenAiText(payload, onDelta) {
  const response = await fetch(`${CONFIG.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${text.slice(0, 320)}`);
  }

  if (!response.body) {
    throw new Error("OpenAI streaming response body is missing.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let outputText = "";
  let responseId = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) {
        break;
      }

      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const dataText = extractSseData(block);
      if (!dataText || dataText === "[DONE]") {
        continue;
      }

      let event;
      try {
        event = JSON.parse(dataText);
      } catch {
        continue;
      }

      if (event.type === "response.created" && event.response?.id) {
        responseId = event.response.id;
      }

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        outputText += event.delta;
        onDelta?.(event.delta);
      }

      if (
        event.type === "response.output_text.done" &&
        typeof event.text === "string" &&
        !outputText
      ) {
        outputText = event.text;
      }

      if (event.type === "error") {
        throw new Error(event.error?.message || "OpenAI stream error.");
      }
    }
  }

  return { responseId, outputText };
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
  const bootUpdatedAt = STATE.boot.generatedAt
    ? new Date(STATE.boot.generatedAt).toLocaleString("ru-RU")
    : "-";

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
      <p>Set the site concept here. Root requests get an immediate ${escapeHtml(
        CONFIG.bootModel
      )} first-byte page, then swap when ${escapeHtml(
        CONFIG.primaryModel
      )} finishes the full raw HTTP response.</p>

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
boot.status: ${escapeHtml(STATE.boot.status)}
boot.model: ${escapeHtml(STATE.boot.model)}
boot.updated: ${escapeHtml(bootUpdatedAt)}
visits.in.memory: ${STATE.visits.size}
routes.in.memory: ${STATE.routeMemories.size}
primary.model: ${escapeHtml(CONFIG.primaryModel)}
boot.model: ${escapeHtml(CONFIG.bootModel)}
api.key.present: ${CONFIG.apiKey ? "yes" : "no"}</pre>
        </article>
        <article class="card">
          <h2>Boot Summary</h2>
          <pre>${escapeHtml(STATE.boot.summary || "-")}</pre>
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
          <h2>Boot Error</h2>
          <pre>${escapeHtml(STATE.boot.error || "-")}</pre>
        </article>
      </section>
    </main>
  </body>
</html>`;
}

function renderBootResponseBytes(visit) {
  const templateText = STATE.boot.responseTemplateText || "";
  return Buffer.from(materializeBootResponse(templateText, visit), "utf8");
}

function normalizeBootTemplate(templateText) {
  const rawText = String(templateText || "").trimStart();
  if (!rawText) {
    throw new Error("Boot template is empty.");
  }
  return rawText;
}

function materializeBootResponse(templateText, visit) {
  const rawText = String(templateText || "").trimStart();
  let htmlSource = rawText;

  if (rawText.startsWith("HTTP/1.1 ")) {
    try {
      const parsed = parseRawHttpResponse(Buffer.from(rawText, "utf8"));
      htmlSource = parsed.bodyBuffer.toString("utf8");
    } catch {
      htmlSource = rawText;
    }
  }

  return buildBootHttpResponse(
    injectBootBridge(htmlSource || buildMinimalBootHtml(""), visit)
  );
}

function buildBootHttpResponse(htmlDocument) {
  return [
    "HTTP/1.1 200 OK",
    "Content-Type: text/html; charset=utf-8",
    "Cache-Control: no-store",
    "Connection: close",
    "",
    htmlDocument,
  ].join("\r\n");
}

function buildMinimalBootHtml(modelMarkup = "") {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>boot</title>
    <style>
      html, body { margin: 0; min-height: 100%; }
      body {
        padding: 12px;
        background: #fff;
        color: #111;
        font: 14px/1.4 ui-monospace, "SFMono-Regular", Consolas, monospace;
      }
      pre { margin: 0; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    ${modelMarkup || ""}
  </body>
</html>`;
}

function injectBootBridge(htmlDocument, visit) {
  const html = String(htmlDocument || "");
  const bridge = `<script>${buildBootBridgeScript(visit)}<\/script>`;

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${bridge}</body>`);
  }

  return `${html}\n${bridge}`;
}

function buildBootBridgeScript(visit) {
  const streamPath = `/__live?visit=${encodeURIComponent(visit.id)}`;

  return `
(() => {
  const stream = new EventSource(${JSON.stringify(streamPath)});
  const statusBox = document.createElement("div");
  statusBox.id = "byte-regent-live-status";
  statusBox.style.position = "fixed";
  statusBox.style.right = "8px";
  statusBox.style.bottom = "8px";
  statusBox.style.zIndex = "2147483647";
  statusBox.style.padding = "6px 8px";
  statusBox.style.borderRadius = "6px";
  statusBox.style.background = "rgba(0,0,0,0.75)";
  statusBox.style.color = "#fff";
  statusBox.style.font = "12px/1.2 monospace";
  statusBox.style.maxWidth = "42ch";
  statusBox.style.pointerEvents = "none";
  statusBox.textContent = "boot";

  const mount = () => {
    if (document.body && !statusBox.isConnected) {
      document.body.appendChild(statusBox);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }

  const setStatus = (text) => {
    mount();
    statusBox.textContent = text;
  };

  const decodeBase64Text = (base64, contentType) => {
    const binary = atob(base64 || "");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const charsetMatch = String(contentType || "").match(/charset\\s*=\\s*["']?([^;"'\\s]+)/i);
    const charset = charsetMatch ? charsetMatch[1].trim().toLowerCase() : "utf-8";
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  };

  stream.addEventListener("phase", (event) => {
    const payload = JSON.parse(event.data);
    setStatus(payload.message || payload.label || "phase");
  });

  stream.addEventListener("progress", (event) => {
    const payload = JSON.parse(event.data);
    setStatus("writing " + String(payload.chars || 0));
  });

  stream.addEventListener("log", (event) => {
    const payload = JSON.parse(event.data);
    setStatus(payload.message || "log");
  });

  stream.addEventListener("error", (event) => {
    const payload = JSON.parse(event.data);
    setStatus(payload.message || "generation failed");
  });

  stream.addEventListener("swap", (event) => {
    const payload = JSON.parse(event.data);
    const html = decodeBase64Text(payload.html_base64, payload.content_type);
    document.open();
    document.write(html);
    document.close();
    stream.close();
  });
})();
`.trim();
}

function renderNonHtmlResult(rawResponse) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Byte Regent Result</title>
    <style>
      body { margin:0; padding:24px; font-family:Consolas,monospace; background:#111; color:#f7f0e8; }
      pre { white-space:pre-wrap; overflow-wrap:anywhere; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(rawResponse.statusLine)}</h1>
    <p>Final response was not HTML. Dumping body bytes as UTF-8 preview.</p>
    <pre>${escapeHtml(rawResponse.bodyBuffer.toString("utf8"))}</pre>
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

function pushVisitEvent(visit, type, payload) {
  const event = { type, payload };
  visit.events.push(event);
  if (visit.events.length > 64) {
    visit.events.splice(0, visit.events.length - 64);
  }
  for (const client of visit.clients) {
    sendSseEvent(client, type, payload);
  }
}

function closeVisitClients(visit) {
  for (const client of [...visit.clients]) {
    endSseResponse(client);
  }
  visit.clients.clear();
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

function isNavigationRequest(request) {
  if (request.method !== "GET") {
    return false;
  }

  const accept = String(request.headersObject.accept || "").toLowerCase();
  const secFetchDest = String(request.headersObject["sec-fetch-dest"] || "").toLowerCase();
  const secFetchMode = String(request.headersObject["sec-fetch-mode"] || "").toLowerCase();

  return (
    accept.includes("text/html") ||
    secFetchDest === "document" ||
    secFetchMode === "navigate" ||
    request.path === "/"
  );
}

function pruneVisits() {
  const now = Date.now();
  for (const [visitId, visit] of STATE.visits.entries()) {
    if (now - visit.createdAt > VISIT_TTL_MS) {
      closeVisitClients(visit);
      STATE.visits.delete(visitId);
    }
  }
}

function startSseResponse(socket) {
  const headers = [
    "HTTP/1.1 200 OK",
    "Content-Type: text/event-stream; charset=utf-8",
    "Cache-Control: no-cache, no-store, must-revalidate",
    "Connection: keep-alive",
    "Transfer-Encoding: chunked",
    "X-Accel-Buffering: no",
    "",
    "",
  ].join("\r\n");

  socket.write(Buffer.from(headers, "utf8"));
}

function sendSseEvent(socket, type, payload) {
  if (socket.destroyed) {
    return;
  }
  const body = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  socket.write(encodeChunk(Buffer.from(body, "utf8")));
}

function endSseResponse(socket) {
  if (socket.destroyed) {
    return;
  }
  socket.end(Buffer.from("0\r\n\r\n", "utf8"));
}

function encodeChunk(buffer) {
  return Buffer.concat([
    Buffer.from(buffer.length.toString(16) + "\r\n", "utf8"),
    buffer,
    Buffer.from("\r\n", "utf8"),
  ]);
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

function extractSseData(block) {
  const lines = block.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return dataLines.join("\n");
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

function parseOptionalPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
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
