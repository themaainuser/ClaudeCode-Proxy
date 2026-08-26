/**
 * Tests for src/upstream.js - the OpenCode Zen HTTP client.
 *
 * Exercises the real global fetch against a local fake Zen server; fetch is
 * never mocked. Config objects come from loadConfig() with literal env-like
 * objects, never process.env.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { loadConfig } from "../src/config.js";
import { createZenCaller } from "../src/upstream.js";
import { startFakeZen } from "./helpers/fake-zen.js";

/**
 * Shut a server down deterministically. closeAllConnections() first so undici
 * keep-alive sockets cannot stall close() past the test.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
}

const SAMPLE_BODY = {
  model: "x-preview-f-free",
  messages: [{ role: "user", content: "hello" }],
  stream: false,
  max_tokens: 4096,
};

test("POSTs the exact JSON body to config.zenUrl", async () => {
  const zen = await startFakeZen((_record, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  try {
    const callZen = createZenCaller(loadConfig({ ZEN_BASE_URL: zen.url }));

    const response = await callZen(SAMPLE_BODY);
    assert.equal(response.status, 200);

    assert.equal(zen.requests.length, 1);
    assert.equal(zen.requests[0].headers["content-type"], "application/json");
    assert.deepEqual(zen.requests[0].body, SAMPLE_BODY);
  } finally {
    await closeServer(zen.server);
  }
});

test("sends the streaming accept header when body.stream is true", async () => {
  const zen = await startFakeZen((_record, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("");
  });

  try {
    const callZen = createZenCaller(
      loadConfig({
        ZEN_BASE_URL: zen.url,
        ZEN_API_KEY: "",
      })
    );

    await callZen({ model: "x-preview-f-free", messages: [], stream: true });

    assert.equal(zen.requests.length, 1);
    assert.equal(zen.requests[0].headers.accept, "text/event-stream, application/json");
  } finally {
    await closeServer(zen.server);
  }
});

test("sends the plain accept header when body.stream is false", async () => {
  const zen = await startFakeZen((_record, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  try {
    const callZen = createZenCaller(
      loadConfig({
        ZEN_BASE_URL: zen.url,
        ZEN_API_KEY: "",
      })
    );

    await callZen({ model: "x-preview-f-free", messages: [], stream: false });

    assert.equal(zen.requests.length, 1);
    assert.equal(zen.requests[0].headers.accept, "application/json");
  } finally {
    await closeServer(zen.server);
  }
});

test("sends an authorization header when zenApiKey is configured", async () => {
  const zen = await startFakeZen((_record, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  try {
    const callZen = createZenCaller(
      loadConfig({
        ZEN_BASE_URL: zen.url,
        ZEN_API_KEY: "test-key",
      })
    );

    await callZen(SAMPLE_BODY);

    assert.equal(zen.requests.length, 1);
    assert.equal(zen.requests[0].headers.authorization, "Bearer test-key");
  } finally {
    await closeServer(zen.server);
  }
});

test("omits the authorization header when zenApiKey is empty", async () => {
  const zen = await startFakeZen((_record, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  try {
    const callZen = createZenCaller(
      loadConfig({
        ZEN_BASE_URL: zen.url,
        ZEN_API_KEY: "",
      })
    );

    await callZen(SAMPLE_BODY);

    assert.equal(zen.requests.length, 1);
    assert.equal(zen.requests[0].headers.authorization, undefined);
    assert.ok(!("authorization" in zen.requests[0].headers));
  } finally {
    await closeServer(zen.server);
  }
});

test("propagates fetch rejections when the upstream port is closed", async () => {
  // Bind a server purely to claim a free port, release it, then aim at it.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await closeServer(probe);

  const callZen = createZenCaller(
    loadConfig({ ZEN_BASE_URL: `http://127.0.0.1:${port}/v1/chat/completions` })
  );

  await assert.rejects(() => callZen(SAMPLE_BODY));
});
