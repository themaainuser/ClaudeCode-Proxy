/**
 * End-to-end integration tests: real HTTP over loopback.
 *
 * createProxyServer (non-listening) + startFakeZen + real fetch. Every test
 * builds its own config via loadConfig with literal env-like objects - the
 * real environment is never read or mutated.
 */

import test, { after } from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { silentLog } from "../src/logger.js";
import { createProxyServer } from "../src/server.js";
import { startFakeZen, doneFrame, chunk } from "./helpers/fake-zen.js";
import { parseAnthropicSSE } from "./helpers/stub-http.js";

const closers = [];

/** Start a fake Zen upstream plus a listening proxy pointed at it. */
async function startStack(zenHandler, envOverrides = {}) {
  const zen = await startFakeZen(zenHandler);
  closers.push(zen.server);

  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    ZEN_BASE_URL: zen.url,
    ZEN_MODEL: "x-preview-f-free",
    ...envOverrides,
  });

  const server = createProxyServer({ config, log: silentLog });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(server);

  return { zen, config, server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function postMessages(origin, body, extraHeaders = {}) {
  return fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function listenOn(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

after(async () => {
  for (const closer of closers.splice(0)) {
    await new Promise((resolve) => closer.close(resolve));
  }
});

test("GET /health returns the exact health payload", async () => {
  const { config, origin } = await startStack(() => {});

  const resp = await fetch(`${origin}/health`);

  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), {
    ok: true,
    proxy: "claude-opencode-proxy-v2",
    upstream: config.zenUrl,
    model: config.zenModel,
    node: process.version,
  });
});

test("GET /v1/models lists three local models owned by the proxy", async () => {
  const { config, origin } = await startStack(() => {});

  const resp = await fetch(`${origin}/v1/models`);
  const body = await resp.json();

  assert.equal(resp.status, 200);
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 3);

  for (const model of body.data) {
    assert.equal(model.owned_by, "local-opencode-proxy");
    assert.equal(model.object, "model");
  }

  assert.equal(body.data[2].id, config.zenModel);
});

test("HEAD /api/hello responds 200 with an empty body", async () => {
  const { origin } = await startStack(() => {});

  const resp = await fetch(`${origin}/api/hello`, { method: "HEAD" });

  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), "");
});

test("Unknown route returns 404 with path and hint", async () => {
  const { origin } = await startStack(() => {});

  const resp = await fetch(`${origin}/definitely-not-a-route`);
  const body = await resp.json();

  assert.equal(resp.status, 404);
  assert.deepEqual(body, {
    error: "Not found",
    path: "/definitely-not-a-route",
    hint: "POST /v1/messages",
  });
});

test("Streaming e2e: forced model, system first, canonical Anthropic SSE order", async () => {
  let sent = null;

  const { config, origin } = await startStack((record, res) => {
    sent = record.body;

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      [
        chunk({ id: "chatcmpl_e2e_stream", delta: {} }),
        chunk({ id: "chatcmpl_e2e_stream", delta: { content: "Hello" } }),
        chunk({ id: "chatcmpl_e2e_stream", delta: { content: ", world" } }),
        chunk({ id: "chatcmpl_e2e_stream", finish: "stop" }),
        doneFrame(),
      ].join(""),
    );
    res.end();
  });

  const resp = await postMessages(origin, {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    stream: true,
    system: "Be terse.",
    messages: [{ role: "user", content: "Hi" }],
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const events = parseAnthropicSSE(await resp.text());

  // The upstream receives the configured Zen model, streaming enabled, and
  // the converted system message ahead of the conversation.
  assert.ok(sent, "fake Zen should have received a request");
  assert.equal(sent.model, config.zenModel);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.messages[0], { role: "system", content: "Be terse." });
  assert.deepEqual(sent.messages[1], { role: "user", content: "Hi" });

  // Canonical Anthropic streaming event order.
  assert.deepEqual(
    events.map((e) => e.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );

  const [, blockStart, deltaA, deltaB] = events;
  assert.equal(blockStart.data.index, 0);
  assert.equal(blockStart.data.content_block.type, "text");
  assert.deepEqual(
    [deltaA.data.delta.text, deltaB.data.delta.text],
    ["Hello", ", world"],
  );

  // message_start echoes the CLIENT-requested model, not the Zen model.
  assert.equal(events[0].data.message.model, "claude-sonnet-4-5");

  const messageDelta = events.find((e) => e.event === "message_delta");
  assert.equal(messageDelta.data.delta.stop_reason, "end_turn");
});

test("Non-streaming e2e: fragmented tool arguments reassemble into one JSON message", async () => {
  const { origin } = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      [
        chunk({
          id: "chatcmpl_e2e_tool",
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_kyoto",
                type: "function",
                function: { name: "get_weather", arguments: '{"location"' },
              },
            ],
          },
        }),
        chunk({
          id: "chatcmpl_e2e_tool",
          delta: {
            tool_calls: [{ index: 0, function: { arguments: ': "Kyoto"}' } }],
          },
        }),
        chunk({
          id: "chatcmpl_e2e_tool",
          finish: "tool_calls",
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
        doneFrame(),
      ].join(""),
    );
    res.end();
  });

  const resp = await postMessages(origin, {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    stream: false,
    messages: [{ role: "user", content: "Weather in Kyoto?" }],
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("content-type"), "application/json; charset=utf-8");

  const body = await resp.json();

  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.stop_sequence, null);

  const toolBlock = body.content.find((block) => block.type === "tool_use");
  assert.ok(toolBlock, "expected a tool_use content block");
  assert.equal(toolBlock.id, "call_kyoto");
  assert.equal(toolBlock.name, "get_weather");
  assert.deepEqual(toolBlock.input, { location: "Kyoto" });

  assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 34 });
});

test("reasoning_content opens and stops a thinking block strictly before the text block", async () => {
  const { origin } = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      [
        chunk({ id: "chatcmpl_think", delta: { reasoning_content: "pondering" } }),
        chunk({ id: "chatcmpl_think", delta: { reasoning_content: " more" } }),
        chunk({ id: "chatcmpl_think", delta: { content: "answer" } }),
        chunk({ id: "chatcmpl_think", finish: "stop" }),
        doneFrame(),
      ].join(""),
    );
    res.end();
  });

  const resp = await postMessages(origin, {
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "Think then answer" }],
  });

  assert.equal(resp.status, 200);

  const events = parseAnthropicSSE(await resp.text());
  const shapes = events.map((e) =>
    e.event === "content_block_start"
      ? `${e.event}:${e.data.content_block.type}@${e.data.index}`
      : e.event === "content_block_stop"
        ? `${e.event}@${e.data.index}`
        : e.event,
  );

  // Thinking block (index 0) fully closed before the text block (index 1) opens.
  assert.deepEqual(shapes, [
    "message_start",
    "content_block_start:thinking@0",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop@0",
    "content_block_start:text@1",
    "content_block_delta",
    "content_block_stop@1",
    "message_delta",
    "message_stop",
  ]);

  const thinkingText = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta")
    .map((e) => e.data.delta.thinking)
    .join("");
  assert.equal(thinkingText, "pondering more");
});

test("Truncated upstream (some text, no finish_reason, no DONE) still terminates cleanly", async () => {
  const { origin } = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ id: "chatcmpl_trunc_text", delta: { content: "partial answ" } }));
    res.end();
  });

  const resp = await postMessages(origin, {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Hi" }],
  });

  assert.equal(resp.status, 200);

  const events = parseAnthropicSSE(await resp.text());
  const names = events.map((e) => e.event);

  // Well-formed terminal events despite the truncated upstream.
  assert.ok(names.includes("message_delta"));
  assert.ok(names.includes("message_stop"));
  assert.equal(names[names.length - 1], "message_stop");
  assert.equal(events.at(-2).event, "message_delta");
  assert.equal(events.at(-2).data.delta.stop_reason, "end_turn");

  // Visible output existed, so no explanatory note is injected.
  assert.equal(names.includes("error"), false);
  const texts = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => e.data.delta.text || "");
  assert.equal(texts.join(""), "partial answ");
  assert.equal(texts.some((t) => t.startsWith("[proxy]")), false);
});

test("Truncated upstream with only reasoning injects the generic no-answer note", async () => {
  const { origin } = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ id: "chatcmpl_trunc_think", delta: { reasoning_content: "deep thought" } }));
    res.end();
  });

  const resp = await postMessages(origin, {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Hi" }],
  });

  assert.equal(resp.status, 200);

  const events = parseAnthropicSSE(await resp.text());
  const notes = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");

  assert.match(
    notes,
    /The upstream stream ended without producing any answer text \(reason: upstream_stream_ended_without_finish_reason\)/,
  );

  // Still a well-formed turn.
  const names = events.map((e) => e.event);
  assert.ok(names.includes("message_delta"));
  assert.equal(names[names.length - 1], "message_stop");
  assert.equal(events.at(-2).data.delta.stop_reason, "end_turn");
});

test("Invalid JSON posted to /v1/messages returns a 400 error envelope", async () => {
  const { origin } = await startStack(() => {});

  const resp = await postMessages(origin, "{this is not json");
  const body = await resp.json();

  assert.equal(resp.status, 400);
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "invalid_request_error");
  assert.ok(body.error.message.startsWith("Invalid JSON: "));
});

test("DEBUG_REQUEST dumps both request banners to stderr; default config stays quiet", async () => {
  // Run with DEBUG_REQUEST=1 first.
  const debugStack = await startStack(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write([chunk({ id: "chatcmpl_dbg", delta: { content: "ok" } }), doneFrame()].join(""));
      res.end();
    },
    { DEBUG_REQUEST: "1" },
  );

  const errMock = mock.method(console, "error");
  try {
    const resp = await postMessages(debugStack.origin, {
      model: "claude-sonnet-4-5",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "banner check" }],
    });
    await resp.text();
  } finally {
    errMock.mock.restore();
  }

  const stderrText = errMock.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(stderrText, /========== CLAUDE REQUEST ==========/);
  assert.match(stderrText, /========== END CLAUDE REQUEST ==========/);
  assert.match(stderrText, /========== ZEN REQUEST ==========/);
  assert.match(stderrText, /========== END ZEN REQUEST ==========/);

  // Same request against a default-config stack emits neither banner.
  const quietStack = await startStack((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write([chunk({ id: "chatcmpl_quiet", delta: { content: "ok" } }), doneFrame()].join(""));
    res.end();
  });

  const quietMock = mock.method(console, "error");
  try {
    const resp = await postMessages(quietStack.origin, {
      model: "claude-sonnet-4-5",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "banner check" }],
    });
    await resp.text();
  } finally {
    quietMock.mock.restore();
  }

  assert.equal(quietMock.mock.calls.length, 0);
});
