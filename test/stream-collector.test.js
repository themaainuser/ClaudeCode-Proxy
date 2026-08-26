/**
 * Tests for src/sse-collector.js - OpenAIStreamCollector.
 *
 * Pins the non-streaming accumulation logic: content concatenation,
 * first-id-wins capture, last-write-wins usage / finish_reason,
 * sparse-index tool_call merging, and finalize() shaping.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIStreamCollector } from "../src/sse-collector.js";

test("content deltas concatenate in arrival order", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({ id: "c1", choices: [{ delta: { content: "Hel" } }] });
  collector.onChunk({ id: "c1", choices: [{ delta: { content: "lo " } }] });
  collector.onChunk({ id: "c1", choices: [{ delta: { content: "world" } }] });

  assert.equal(collector.finalMessage.content, "Hello world");
});

test("started is false initially and true after an id-bearing chunk", () => {
  const collector = new OpenAIStreamCollector();
  assert.equal(collector.started, false);

  collector.onChunk({ id: "c1", choices: [] });
  assert.equal(collector.started, true);
});

test("first id wins; later id-bearing chunk only contributes its deltas", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({
    id: "A",
    object: "chat.completion.chunk",
    model: "model-a",
    choices: [{ delta: { content: "from A" }, finish_reason: null }],
  });
  collector.onChunk({
    id: "B",
    object: "chat.completion.chunk",
    model: "model-b",
    choices: [{ delta: { content: " plus B" }, finish_reason: "stop" }],
  });

  const out = collector.finalize();
  assert.equal(out.id, "A");
  assert.equal(out.object, "chat.completion.chunk");
  assert.equal(out.model, "model-a");
  // Deltas from the B-id chunk still merged into the single message.
  assert.equal(out.choices[0].message.content, "from A plus B");
});

test("usage is last-write-wins and survives usage-less chunks", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({
    id: "u1",
    usage: { prompt_tokens: 1, completion_tokens: 2 },
    choices: [],
  });
  collector.onChunk({ id: "u1", choices: [] });
  collector.onChunk({
    id: "u1",
    usage: { prompt_tokens: 11, completion_tokens: 22 },
    choices: [],
  });

  const out = collector.finalize();
  assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 22 });
});

test("finish_reason is last-write-wins", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({
    id: "r1",
    choices: [{ delta: {}, finish_reason: "stop" }],
  });
  collector.onChunk({
    id: "r1",
    choices: [{ delta: {}, finish_reason: "length" }],
  });

  const out = collector.finalize();
  assert.equal(out.choices[0].finish_reason, "length");
});

test("tool_calls merge by sparse index; holes are preserved", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({
    id: "t1",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-zero",
              type: "function",
              function: { name: "fn_zero", arguments: "{}" },
            },
          ],
        },
      },
    ],
  });
  collector.onChunk({
    id: "t1",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 2,
              id: "call-two",
              type: "function",
              function: { name: "fn_two", arguments: "[]" },
            },
          ],
        },
      },
    ],
  });

  const calls = collector.finalMessage.tool_calls;
  assert.equal(calls.length, 3);
  assert.equal(calls[0].id, "call-zero");
  assert.equal(calls[0].function.name, "fn_zero");
  assert.equal(calls[1], undefined);
  assert.equal(calls[2].id, "call-two");
  assert.equal(calls[2].function.name, "fn_two");
});

test("fragmented arguments concatenate into complete JSON", () => {
  const collector = new OpenAIStreamCollector();

  const fragments = ['{"city":', '"Par', 'is","unit"', ':"c"}'];
  for (const piece of fragments) {
    collector.onChunk({
      id: "a1",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-a",
                type: "function",
                function: { name: "get_weather", arguments: piece },
              },
            ],
          },
        },
      ],
    });
  }

  const call = collector.finalMessage.tool_calls[0];
  assert.equal(call.function.arguments, '{"city":"Paris","unit":"c"}');
  assert.deepEqual(JSON.parse(call.function.arguments), {
    city: "Paris",
    unit: "c",
  });
});

test("later id fragment overrides initially generated call id", () => {
  let generated = 0;
  const collector = new OpenAIStreamCollector({
    newCallId: () => "gen-" + ++generated,
  });

  collector.onChunk({
    id: "g1",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { name: "lookup", arguments: '{"q":"' },
            },
          ],
        },
      },
    ],
  });
  assert.equal(generated, 1);
  assert.equal(collector.finalMessage.tool_calls[0].id, "gen-1");

  collector.onChunk({
    id: "g1",
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call-real", function: { arguments: 'x"}' } },
          ],
        },
      },
    ],
  });

  const call = collector.finalMessage.tool_calls[0];
  assert.equal(call.id, "call-real");
  assert.equal(call.function.arguments, '{"q":"x"}');
});

test("name arriving in a later fragment overrides the empty initial name", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({
    id: "n1",
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "call-n", arguments: "{}" }],
        },
      },
    ],
  });
  assert.equal(collector.finalMessage.tool_calls[0].function.name, "");

  collector.onChunk({
    id: "n1",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { name: "real_tool", arguments: "" },
            },
          ],
        },
      },
    ],
  });
  assert.equal(
    collector.finalMessage.tool_calls[0].function.name,
    "real_tool"
  );
});

test("finalize shapes choices=[{index:0,message,finish_reason}] and carries usage onto finalData", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({
    id: "f1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "zen-model",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
  });
  collector.onChunk({
    id: "f1",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });

  const out = collector.finalize();

  assert.equal(out.id, "f1");
  assert.equal(out.created, 1700000000);
  assert.deepEqual(out.choices, [
    {
      index: 0,
      message: { role: "assistant", content: "hi", tool_calls: [] },
      finish_reason: "stop",
    },
  ]);
  assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 3 });
});

test("finalize falls back to finish_reason \"stop\" when none was seen", () => {
  const collector = new OpenAIStreamCollector();

  collector.onChunk({
    id: "s1",
    choices: [{ delta: { content: "no reason given" }, finish_reason: null }],
  });

  const out = collector.finalize();
  assert.equal(out.choices[0].finish_reason, "stop");
});

test("finalize without any id-bearing chunk throws", () => {
  const collector = new OpenAIStreamCollector();
  collector.onChunk({ choices: [{ delta: { content: "orphan" } }] });

  assert.equal(collector.started, false);
  assert.throws(() => collector.finalize(), TypeError);
});
