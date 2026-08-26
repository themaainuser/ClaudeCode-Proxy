/**
 * Tests for src/message-handler.js - POST /v1/messages orchestrator.
 *
 * Pins the error paths (invalid JSON, missing messages array, upstream
 * connection failure, upstream HTTP error) and the happy-path wiring
 * (non-streaming internal SSE consumption + Anthropic SSE streaming),
 * all through an injected fake callZen - no real network.
 *
 * recorderRes() drops its end() argument, so a thin local wrapper captures
 * the JSON payload handed to end() without touching the shared helper.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { silentLog } from "../src/logger.js";
import { createMessageHandler } from "../src/message-handler.js";

import { recorderRes, stubReq, writtenText, parseAnthropicSSE } from "./helpers/stub-http.js";

const config = loadConfig({ ZEN_BASE_URL: "http://unused" });

function makeHandler(callZen) {
  return createMessageHandler({ config, log: silentLog, callZen });
}

/** recorderRes() plus capture of the payload passed to end(). */
function makeRes() {
  const res = recorderRes();
  const rawEnd = res.end;
  let endPayload;

  res.end = function (payload) {
    if (payload !== undefined) {
      endPayload = payload;
    }

    return rawEnd.call(res);
  };

  return { res, endJson: () => JSON.parse(endPayload) };
}

const USER_REQUEST = JSON.stringify({
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "hi" }],
});

/** A Response-like upstream result whose body streams the given text once. */
function sseUpstream(sse) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      getReader() {
        const encoder = new TextEncoder();
        let sent = false;

        return {
          async read() {
            if (sent) return { done: true };

            sent = true;

            return { done: false, value: encoder.encode(sse) };
          },
        };
      },
    },
  };
}

test("invalid JSON body -> 400 invalid_request_error with message starting 'Invalid JSON:'", async () => {
  const callZen = async () => {
    throw new Error("callZen must not be reached");
  };
  const handle = makeHandler(callZen);
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from("this is not json")), res);

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls.length, 2);
  assert.equal(res.headersSent, true);

  const head = res.calls[0];
  assert.equal(head.kind, "writeHead");
  assert.equal(head.status, 400);
  assert.equal(head.headers["content-type"], "application/json; charset=utf-8");

  const envelope = endJson();
  assert.equal(envelope.type, "error");
  assert.deepEqual(Object.keys(envelope.error), ["type", "message"]);
  assert.equal(envelope.error.type, "invalid_request_error");
  assert.match(envelope.error.message, /^Invalid JSON:/);
});

test("valid JSON but messages missing -> 400 'Claude request is missing a messages array.'", async () => {
  const callZen = async () => {
    throw new Error("callZen must not be reached");
  };
  const handle = makeHandler(callZen);
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from(JSON.stringify({ model: "claude-sonnet-4-5" }))), res);

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls[0].status, 400);

  const envelope = endJson();
  assert.deepEqual(envelope, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Claude request is missing a messages array.",
    },
  });
});

test("messages present but not an array -> same 400 invalid_request_error", async () => {
  const callZen = async () => {
    throw new Error("callZen must not be reached");
  };
  const handle = makeHandler(callZen);
  const { res, endJson } = makeRes();

  await handle(
    stubReq(Buffer.from(JSON.stringify({ model: "claude-sonnet-4-5", messages: "nope" }))),
    res
  );

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls[0].status, 400);

  const envelope = endJson();
  assert.equal(envelope.type, "error");
  assert.equal(envelope.error.type, "invalid_request_error");
  assert.equal(envelope.error.message, "Claude request is missing a messages array.");
});

test("empty request body parses as {} -> 400 missing messages array", async () => {
  const callZen = async () => {
    throw new Error("callZen must not be reached");
  };
  const handle = makeHandler(callZen);
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from("")), res);

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls[0].status, 400);

  const envelope = endJson();
  assert.equal(envelope.error.type, "invalid_request_error");
  assert.equal(envelope.error.message, "Claude request is missing a messages array.");
});

test("callZen rejects -> 502 api_connection_error 'Could not connect to OpenCode Zen: boom'", async () => {
  let called = 0;
  const callZen = async () => {
    called++;
    throw new Error("boom");
  };
  const handle = makeHandler(callZen);
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from(USER_REQUEST)), res);

  assert.equal(called, 1);
  assert.equal(res.writableEnded, true);
  assert.equal(res.calls.length, 2);

  const head = res.calls[0];
  assert.equal(head.kind, "writeHead");
  assert.equal(head.status, 502);
  assert.equal(head.headers["content-type"], "application/json; charset=utf-8");

  const envelope = endJson();
  assert.deepEqual(envelope, {
    type: "error",
    error: {
      type: "api_connection_error",
      message: "Could not connect to OpenCode Zen: boom",
    },
  });
});

test("callZen resolves !ok -> status 429 passthrough and api_error 'OpenCode Zen returned HTTP 429: rate limited'", async () => {
  let sawOutgoing = null;
  const callZen = async (outgoing) => {
    sawOutgoing = outgoing;

    return {
      ok: false,
      status: 429,
      text: async () => "rate limited",
    };
  };
  const handle = makeHandler(callZen);
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from(USER_REQUEST)), res);

  // The converted body reaches the injected caller.
  assert.ok(sawOutgoing, "callZen should have received the converted OpenAI body");
  assert.equal(sawOutgoing.model, config.zenModel);
  assert.equal(sawOutgoing.stream, true);
  assert.ok(Array.isArray(sawOutgoing.messages));
  assert.equal(sawOutgoing.messages.length, 1);

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls.length, 2);

  const head = res.calls[0];
  assert.equal(head.kind, "writeHead");
  assert.equal(head.status, 429);

  const envelope = endJson();
  assert.deepEqual(envelope, {
    type: "error",
    error: {
      type: "api_error",
      message: "OpenCode Zen returned HTTP 429: rate limited",
    },
  });
});

test("non-streaming happy path: SSE consumed internally, reconstructed message returned as json 200", async () => {
  const sse =
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"x-preview-f-free","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n' +
    "data: [DONE]\n\n";

  const handle = makeHandler(async () => sseUpstream(sse));
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from(USER_REQUEST)), res);

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls.length, 2);

  const head = res.calls[0];
  assert.equal(head.kind, "writeHead");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "application/json; charset=utf-8");

  const result = endJson();

  assert.equal(result.id, "chatcmpl-1");
  assert.equal(result.type, "message");
  assert.equal(result.role, "assistant");
  // The requested Claude model wins in the response envelope.
  assert.equal(result.model, "claude-sonnet-4-5");
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.stop_sequence, null);
  assert.deepEqual(result.content, [{ type: "text", text: "Hello world" }]);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3 });
});

test("non-streaming happy path falls back to config.zenModel when no Claude model was requested", async () => {
  const sse =
    'data: {"id":"chatcmpl-f","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
    "data: [DONE]\n\n";

  const handle = makeHandler(async () => sseUpstream(sse));
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))), res);

  assert.equal(endJson().model, config.zenModel);
});

test("empty upstream stream on non-streaming path -> 502 api_error 'OpenCode Zen returned an empty stream.'", async () => {
  const handle = makeHandler(async () => sseUpstream(""));
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from(USER_REQUEST)), res);

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls[0].status, 502);

  const envelope = endJson();
  assert.deepEqual(envelope, {
    type: "error",
    error: {
      type: "api_error",
      message: "OpenCode Zen returned an empty stream.",
    },
  });
});

test("upstream body reader throws on non-streaming path -> 502 api_error 'OpenCode Zen stream failed: ...'", async () => {
  const upstream = {
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("socket blew up");
          },
        };
      },
    },
  };

  const handle = makeHandler(async () => upstream);
  const { res, endJson } = makeRes();

  await handle(stubReq(Buffer.from(USER_REQUEST)), res);

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls[0].status, 502);

  const envelope = endJson();
  assert.equal(envelope.error.type, "api_error");
  assert.equal(envelope.error.message, "OpenCode Zen stream failed: socket blew up");
});

test("streaming happy path: Anthropic SSE events written to the recorder", async () => {
  const sse =
    'data: {"id":"chatcmpl-s","model":"x-preview-f-free","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi there"}}]}\n\n' +
    'data: {"id":"chatcmpl-s","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
    "data: [DONE]\n\n";

  const handle = makeHandler(async () => sseUpstream(sse));
  const res = recorderRes();

  await handle(
    stubReq(
      Buffer.from(
        JSON.stringify({
          model: "claude-sonnet-4-5",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        })
      )
    ),
    res
  );

  assert.equal(res.writableEnded, true);

  const head = res.calls.find((c) => c.kind === "writeHead");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(head.headers["cache-control"], "no-cache, no-transform");
  assert.equal(head.headers.connection, "keep-alive");
  assert.equal(head.headers["x-accel-buffering"], "no");

  const text = writtenText(res);
  assert.ok(text.includes("event: message_start"));
  assert.ok(text.includes("event: content_block_start"));
  assert.ok(text.includes('"text":"Hi there"'));
  assert.ok(text.includes("event: content_block_stop"));
  assert.ok(text.includes("event: message_delta"));
  assert.ok(text.includes('"stop_reason":"end_turn"'));
  assert.ok(text.includes("event: message_stop"));

  const events = parseAnthropicSSE(text);
  assert.equal(events[0].event, "message_start");
  assert.equal(events[0].data.type, "message_start");
  assert.equal(events[0].data.message.id, "chatcmpl-s");
  assert.equal(events.at(-1).event, "message_stop");

  const delta = events.find((e) => e.event === "message_delta");
  assert.equal(delta.data.delta.stop_reason, "end_turn");
  assert.equal(delta.data.usage.output_tokens, 2);
});

test("streaming path maps finish_reason length -> max_tokens stop_reason", async () => {
  const sse =
    'data: {"id":"chatcmpl-l","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-l","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":9,"completion_tokens":7}}\n\n' +
    "data: [DONE]\n\n";

  const handle = makeHandler(async () => sseUpstream(sse));
  const res = recorderRes();

  await handle(
    stubReq(Buffer.from(JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }))),
    res
  );

  const events = parseAnthropicSSE(writtenText(res));
  const delta = events.find((e) => e.event === "message_delta");

  assert.equal(delta.data.delta.stop_reason, "max_tokens");
});
