/**
 * Unit tests for src/convert-response.js - pure conversion functions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  mapFinishReason,
  parseToolArguments,
  openAIMessageToAnthropic,
  openAIToAnthropic,
} from "../src/convert-response.js";

test("mapFinishReason maps every known OpenAI reason to its Anthropic reason", () => {
  const table = [
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["length", "max_tokens"],
    ["stop", "end_turn"],
    [null, "end_turn"],
    [undefined, "end_turn"],
    ["weird_reason", "end_turn"],
  ];

  for (const [reason, expected] of table) {
    assert.equal(mapFinishReason(reason), expected, `finish_reason ${String(reason)}`);
  }
});

test("parseToolArguments handles null, empty strings, objects, JSON strings, and garbage", () => {
  assert.deepEqual(parseToolArguments(null), {});
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments(""), {});

  const obj = { city: "Tokyo" };
  assert.strictEqual(parseToolArguments(obj), obj);

  assert.deepEqual(parseToolArguments('{"city":"Tokyo"}'), { city: "Tokyo" });
  assert.deepEqual(parseToolArguments("{}"), {});

  assert.deepEqual(parseToolArguments("not json"), { _raw_arguments: "not json" });
  assert.deepEqual(parseToolArguments("{broken"), { _raw_arguments: "{broken" });
});

test("openAIMessageToAnthropic converts plain string content to a single text block", () => {
  const blocks = openAIMessageToAnthropic({ role: "assistant", content: "Hello there" });

  assert.deepEqual(blocks, [{ type: "text", text: "Hello there" }]);
});

test("openAIMessageToAnthropic keeps only text parts from array content", () => {
  const blocks = openAIMessageToAnthropic({
    role: "assistant",
    content: [
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      { type: "text", text: "first" },
      { type: "other", data: "ignored" },
      { type: "text", text: "second" },
      { type: "text", text: "" },
    ],
  });

  assert.deepEqual(blocks, [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ]);
});

test("openAIMessageToAnthropic never converts reasoning_content into a thinking block", () => {
  const blocks = openAIMessageToAnthropic({
    role: "assistant",
    content: "",
    reasoning_content: "internal chain of thought",
  });

  assert.equal(blocks.some((block) => block.type === "thinking"), false);
  assert.equal(JSON.stringify(blocks).includes("chain of thought"), false);
  assert.deepEqual(blocks, [{ type: "text", text: "" }]);

  const withText = openAIMessageToAnthropic({
    role: "assistant",
    content: "answer",
    reasoning_content: "hidden",
  });

  assert.deepEqual(withText, [{ type: "text", text: "answer" }]);
});

test("openAIMessageToAnthropic maps tool_calls with id, name, and input fallbacks", () => {
  const blocks = openAIMessageToAnthropic({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_abc",
        function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
      },
      {
        function: { arguments: "not json" },
      },
      {
        id: "call_xyz",
        function: {},
      },
    ],
  });

  assert.equal(blocks[0].type, "tool_use");
  assert.equal(blocks[0].id, "call_abc");
  assert.equal(blocks[0].name, "get_weather");
  assert.deepEqual(blocks[0].input, { city: "Oslo" });

  assert.match(blocks[1].id, /^toolu_[0-9a-f]{24}$/);
  assert.equal(blocks[1].name, "unknown_tool");
  assert.deepEqual(blocks[1].input, { _raw_arguments: "not json" });

  assert.equal(blocks[2].id, "call_xyz");
  assert.equal(blocks[2].name, "unknown_tool");
  assert.deepEqual(blocks[2].input, {});
});

test("openAIMessageToAnthropic falls back to one empty text block for an empty message", () => {
  assert.deepEqual(openAIMessageToAnthropic({}), [{ type: "text", text: "" }]);
  assert.deepEqual(openAIMessageToAnthropic({ role: "assistant", content: null }), [
    { type: "text", text: "" },
  ]);
});

test("openAIToAnthropic builds the Anthropic message envelope", () => {
  const result = openAIToAnthropic(
    {
      id: "chatcmpl-123",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi", tool_calls: [] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    },
    "claude-sonnet-4-5",
    "x-preview-f-free"
  );

  assert.deepEqual(result, {
    id: "chatcmpl-123",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 34 },
  });
});

test("openAIToAnthropic generates an id when upstream omits one", () => {
  const result = openAIToAnthropic(
    { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    "claude-sonnet-4-5",
    "x-preview-f-free"
  );

  assert.match(result.id, /^msg_[0-9a-f]{24}$/);
});

test("openAIToAnthropic uses the fallback model when the requested model is empty", () => {
  const result = openAIToAnthropic(
    { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    "",
    "x-preview-f-free"
  );

  assert.equal(result.model, "x-preview-f-free");
});

test("openAIToAnthropic zero-defaults usage and always sends stop_sequence null", () => {
  const result = openAIToAnthropic(
    { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    "claude-sonnet-4-5",
    "x-preview-f-free"
  );

  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(result.stop_sequence, null);
  assert.equal(result.role, "assistant");
  assert.equal(result.type, "message");
});
