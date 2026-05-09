import assert from "node:assert/strict";
import { once } from "node:events";

process.env.OPENAI_API_KEY = "";

const { startServer } = await import("../server.js");

const server = startServer(0);

try {
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const fetchText = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...options,
    });
    return {
      response,
      text: await response.text(),
    };
  };

  const healthResult = await fetch(`${baseUrl}/__health`);
  assert.equal(healthResult.status, 200, "health endpoint should return 200");
  const health = await healthResult.json();
  assert.equal(health.ok, true, "health payload should be ok=true");
  assert.equal(
    typeof health.primaryModel,
    "string",
    "health payload should expose primary model"
  );

  const control = await fetchText("/__control");
  assert.equal(control.response.status, 200, "control page should return 200");
  assert.match(control.text, /Byte Regent Lab/, "control page should render");
  assert.match(
    control.text,
    /structured status, headers, content_type, body_text/,
    "control page should describe the structured model interface"
  );

  const home = await fetchText("/");
  assert.equal(home.response.status, 502, "home page should fail closed without API key");
  assert.match(
    home.text,
    /OPENAI_API_KEY is empty|Prime request failed/i,
    "home page should surface the blocking model error"
  );

  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(favicon.status, 204, "favicon endpoint should return 204");

  const apiProbe = await fetchText("/api/probe", {
    headers: { Accept: "application/json" },
  });
  assert.equal(apiProbe.response.status, 502, "API probe should fail closed without API key");
  assert.match(
    apiProbe.text,
    /OPENAI_API_KEY is empty|Prime request failed/i,
    "API probe should explain why model path is unavailable"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        port,
        primaryModel: health.primaryModel,
        primaryReasoningEffort: health.primaryReasoningEffort,
      },
      null,
      2
    )
  );
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
