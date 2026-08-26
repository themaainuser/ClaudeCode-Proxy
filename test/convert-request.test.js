/**
 * Unit tests for src/convert-request.js (Anthropic -> OpenAI request conversion).
 *
 * Pure-function module: no servers, no environment access. Every case builds
 * literal Anthropic request bodies and pins the exact OpenAI-compatible shape.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { anthropicToOpenAI } from "../src/convert-request.js";

/** Smallest legal Anthropic body; extras override via spread. */
function minimalBody(extra = {}) {
  return { model: "claude-sonnet-4-5", messages: [], ...extra };
}

test("system: string passthrough, array joined with blank lines, falsy omitted", () => {
  const asString = anthropicToOpenAI(minimalBody({ system: "Be brief." }), { model: "m" });
  assert.deepEqual(asString.messages, [{ role: "system", content: "Be brief." }]);

  const asArray = anthropicToOpenAI(
    minimalBody({
      system: [
        { type: "text", text: "First rule." },
        { type: "text", text: "Second rule." },
        { junk: true },
      ],
    }),
    { model: "m" },
  );
  assert.equal(asArray.messages[0].role, "system");
  assert.equal(asArray.messages[0].content, "First rule.\n\nSecond rule.");

  const omitted = anthropicToOpenAI(minimalBody(), { model: "m" });
  assert.ok(!omitted.messages.some((message) => message.role === "system"));

  const emptyString = anthropicToOpenAI(minimalBody({ system: "" }), { model: "m" });
  assert.ok(!emptyString.messages.some((message) => message.role === "system"));
});

test("empty messages passes through as []; scalar user content becomes a plain string", () => {
  const empty = anthropicToOpenAI(minimalBody({ messages: [] }), { model: "m" });
  assert.deepEqual(empty.messages, []);

  const scalar = anthropicToOpenAI(
    minimalBody({ messages: [{ role: "user", content: "plain text" }] }),
    { model: "m" },
  );
  assert.deepEqual(scalar.messages, [{ role: "user", content: "plain text" }]);
});

test("user array: text and base64 image become multimodal parts with a data URI", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          ],
        },
      ],
    }),
    { model: "m" },
  );

  assert.equal(out.messages.length, 1);
  assert.deepEqual(out.messages[0].role, "user");
  assert.deepEqual(out.messages[0].content, [
    { type: "text", text: "What is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
});

test("image sources: missing media_type falls back to application/octet-stream; url images pass through", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data: "QQ==" } },
            { type: "image", source: { type: "url", url: "https://example.com/pic.png" } },
            { type: "image", source: { type: "base64" } },
          ],
        },
      ],
    }),
    { model: "m" },
  );

  assert.deepEqual(out.messages, [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:application/octet-stream;base64,QQ==" } },
        { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
      ],
    },
  ]);
});

test("document-only user turn survives as a user message with empty-string content", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "AAA" },
            },
          ],
        },
      ],
    }),
    { model: "m" },
  );

  assert.deepEqual(out.messages, [{ role: "user", content: "" }]);
});

test("unrecognized blocks: unportable user turns emit nothing; defensive roles collapse to empty string", () => {
  const userTurn = anthropicToOpenAI(
    minimalBody({
      messages: [
        { role: "user", content: [{ type: "server_tool_use", id: "srvuse_1", name: "web_search" }] },
      ],
    }),
    { model: "m" },
  );
  assert.deepEqual(userTurn.messages, []);

  const weirdRole = anthropicToOpenAI(
    minimalBody({
      messages: [{ role: "developer", content: [{ type: "thinking", thinking: "hmm" }, 42] }],
    }),
    { model: "m" },
  );
  assert.deepEqual(weirdRole.messages, [{ role: "developer", content: "" }]);
});

test("assistant array content joins text and emits tool_calls with JSON-stringified arguments", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check. " },
            { type: "text", text: "One moment." },
            { type: "tool_use", id: "toolu_abc", name: "get_weather", input: { city: "Oslo" } },
          ],
        },
      ],
    }),
    { model: "m" },
  );

  assert.deepEqual(out.messages, [
    {
      role: "assistant",
      content: "Let me check. One moment.",
      tool_calls: [
        {
          id: "toolu_abc",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
        },
      ],
    },
  ]);
});

test("assistant tool_use without id generates a call_ id; tool-only turns have null content", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      messages: [{ role: "assistant", content: [{ type: "tool_use", name: "noop", input: null }] }],
    }),
    { model: "m" },
  );

  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].content, null);
  assert.match(out.messages[0].tool_calls[0].id, /^call_[0-9a-f]{24}$/);
  assert.equal(out.messages[0].tool_calls[0].type, "function");
  assert.deepEqual(out.messages[0].tool_calls[0].function, { name: "noop", arguments: "{}" });
});

test("assistant scalar content becomes a string; null/undefined collapse to empty string", () => {
  const scalar = anthropicToOpenAI(
    minimalBody({ messages: [{ role: "assistant", content: "hi there" }] }),
    { model: "m" },
  );
  assert.deepEqual(scalar.messages, [{ role: "assistant", content: "hi there" }]);

  const nullish = anthropicToOpenAI(
    minimalBody({
      messages: [{ role: "assistant", content: null }, { role: "assistant" }],
    }),
    { model: "m" },
  );
  assert.deepEqual(nullish.messages, [
    { role: "assistant", content: "" },
    { role: "assistant", content: "" },
  ]);
});

test("tool_use inputs: null becomes {}, objects pass through, JSON strings parse, garbage becomes {}", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "a", input: null },
            { type: "tool_use", id: "t2", name: "b", input: { n: 7 } },
            { type: "tool_use", id: "t3", name: "c", input: '{"flag":true}' },
            { type: "tool_use", id: "t4", name: "d", input: "not-json{" },
          ],
        },
      ],
    }),
    { model: "m" },
  );

  const args = out.messages[0].tool_calls.map((call) => call.function.arguments);
  assert.deepEqual(args, ["{}", '{"n":7}', '{"flag":true}', "{}"]);
});

test("user turn ordering: tool_results become individual tool messages before the combined user message", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "result one" },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [{ type: "text", text: "result two" }],
            },
            { type: "text", text: "Now summarize." },
          ],
        },
      ],
    }),
    { model: "m" },
  );

  assert.deepEqual(out.messages, [
    { role: "tool", tool_call_id: "toolu_1", content: "result one" },
    { role: "tool", tool_call_id: "toolu_2", content: "result two" },
    { role: "user", content: [{ type: "text", text: "Now summarize." }] },
  ]);
});

test("tools: client tools converted with defaults, server-side and unnamed tools skipped, strict booleanized", () => {
  const out = anthropicToOpenAI(
    minimalBody({
      tools: [
        {
          name: "full",
          description: "Does things",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
        // Server-side tool: typed, not "custom", no input_schema -> skipped.
        { type: "web_search_20250305", name: "web_search" },
        // Custom tool without a schema survives with the fallback parameters.
        { type: "custom", name: "palette" },
        // Unnamed tool -> skipped.
        { input_schema: { type: "object" } },
        { name: "strict_off", input_schema: {}, strict: false },
        { name: "bare" },
      ],
    }),
    { model: "m" },
  );

  assert.deepEqual(out.tools, [
    {
      type: "function",
      function: {
        name: "full",
        description: "Does things",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: { name: "palette", description: "", parameters: { type: "object", properties: {} } },
    },
    {
      type: "function",
      function: { name: "strict_off", description: "", parameters: {}, strict: false },
    },
    {
      type: "function",
      function: { name: "bare", description: "", parameters: { type: "object", properties: {} } },
    },
  ]);

  const none = anthropicToOpenAI(minimalBody({ tools: [] }), { model: "m" });
  assert.ok(!("tools" in none));

  const missing = anthropicToOpenAI(minimalBody(), { model: "m" });
  assert.ok(!("tools" in missing));
});

test("tool_choice: full mapping table including degradation to auto and full omission", () => {
  const choiceOf = (tool_choice) =>
    anthropicToOpenAI(minimalBody({ tool_choice }), { model: "m" }).tool_choice;

  assert.equal(choiceOf({ type: "auto" }), "auto");
  assert.equal(choiceOf({ type: "none" }), "none");
  assert.equal(choiceOf({ type: "any" }), "required");
  assert.deepEqual(choiceOf({ type: "tool", name: "lookup" }), {
    type: "function",
    function: { name: "lookup" },
  });
  // Named-tool choice without a name degrades to auto but is still sent.
  assert.equal(choiceOf({ type: "tool" }), "auto");
  // Anything unrecognized leaves the property off the payload entirely.
  assert.equal(choiceOf({ type: "function", function: { name: "lookup" } }), undefined);
  assert.equal(choiceOf({ type: "teleport" }), undefined);
  assert.equal(choiceOf(null), undefined);

  const bare = anthropicToOpenAI(minimalBody(), { model: "m" });
  assert.ok(!("tool_choice" in bare));
});

test("model forcing: options.model wins over whatever Claude model was requested", () => {
  const out = anthropicToOpenAI(
    minimalBody({ model: "claude-opus-4-1", messages: [{ role: "user", content: "hi" }] }),
    { model: "x-preview-f-free" },
  );

  assert.equal(out.model, "x-preview-f-free");
});

test("max_tokens headroom math reserves answer tokens beyond the thinking budget", () => {
  const maxTokensOf = (extra, opts = {}) =>
    anthropicToOpenAI(minimalBody(extra), { model: "m", ...opts }).max_tokens;

  // No thinking: the requested budget is used as-is.
  assert.equal(maxTokensOf({ max_tokens: 5000 }), 5000);
  // Missing/non-finite max_tokens: 4096 default floor wins over min-answer headroom.
  assert.equal(maxTokensOf({}), 4096);
  assert.equal(maxTokensOf({ max_tokens: "8192" }), 4096);
  // Thinking budget larger than the cap lifts the total by the answer reserve.
  assert.equal(maxTokensOf({ max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 8000 } }), 9024);
  // Budget exactly equal to max_tokens still lifts (budget + minAnswerTokens).
  assert.equal(maxTokensOf({ max_tokens: 4096, thinking: { budget_tokens: 4096 } }), 5120);
  // Custom minAnswerTokens option is honored.
  assert.equal(
    maxTokensOf({ max_tokens: 100, thinking: { budget_tokens: 1000 } }, { minAnswerTokens: 256 }),
    1256,
  );
});

test("stream is forced true; nullable passthroughs appear only when supplied; stop_sequences map onto stop", () => {
  const full = anthropicToOpenAI(
    minimalBody({
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      top_p: 0.9,
      stop_sequences: ["a", "b"],
      seed: 7,
      user: "u_123",
    }),
    { model: "m" },
  );
  assert.equal(full.stream, true);
  assert.equal(full.temperature, 0);
  assert.equal(full.top_p, 0.9);
  assert.deepEqual(full.stop, ["a", "b"]);
  assert.equal(full.seed, 7);
  assert.equal(full.user, "u_123");

  const bare = anthropicToOpenAI(
    minimalBody({
      messages: [{ role: "user", content: "hello" }],
      temperature: null,
      top_p: null,
      stop_sequences: [],
      seed: null,
      user: null,
    }),
    { model: "m" },
  );
  assert.equal(bare.stream, true);
  for (const key of ["temperature", "top_p", "stop", "seed", "user"]) {
    assert.ok(!(key in bare), `${key} should be omitted when null/empty`);
  }
});
