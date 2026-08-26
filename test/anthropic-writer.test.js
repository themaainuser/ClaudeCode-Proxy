import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicStreamWriter } from "../src/sse-anthropic-writer.js";
import {
  recorderRes,
  writtenText,
  parseAnthropicSSE,
} from "./helpers/stub-http.js";

const LENGTH_NOTE =
  "[proxy] The model exhausted max_tokens while reasoning and never produced an answer. Increase max_tokens (or ZEN_MIN_ANSWER_TOKENS) and retry.";

const GENERIC_NOTE =
  "[proxy] The upstream stream ended without producing any answer text (reason: upstream_stream_ended_without_finish_reason). This usually means the connection dropped or the upstream omitted finish_reason mid-answer.";

function eventsOf(res) {
  return parseAnthropicSSE(writtenText(res));
}

function blockStarts(events) {
  return events.filter((e) => e.event === "content_block_start");
}

function blockStops(events) {
  return events.filter((e) => e.event === "content_block_stop");
}

/**
 * Regression guard: every content_block_start must get exactly one matching
 * content_block_stop, and block indices must be strictly increasing.
 */
function assertBlocksPairCleanly(events) {
  const starts = blockStarts(events);
  const stops = blockStops(events);

  for (let i = 1; i < starts.length; i++) {
    assert.ok(
      starts[i].data.index > starts[i - 1].data.index,
      `content_block_start indices must strictly increase (${
        starts[i - 1].data.index
      } then ${starts[i].data.index})`,
    );
  }

  const stopCounts = new Map();
  for (const stop of stops) {
    stopCounts.set(stop.data.index, (stopCounts.get(stop.data.index) || 0) + 1);
  }

  for (const start of starts) {
    assert.equal(
      stopCounts.get(start.data.index),
      1,
      `index ${start.data.index} must be stopped exactly once`,
    );
  }

  assert.equal(
    stops.length,
    starts.length,
    "every content_block_stop must belong to a content_block_start",
  );

  for (const stop of stops) {
    const startEventIndex = events.findIndex(
      (e) => e.event === "content_block_start" && e.data.index === stop.data.index,
    );
    const stopEventIndex = events.indexOf(stop);
    assert.ok(
      stopEventIndex > startEventIndex,
      `stop for index ${stop.data.index} came before its start`,
    );
  }
}

test("start() emits the exact message_start skeleton and generates an id when none given", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "claude-sonnet-4-5");

  writer.start("msg_fixed", { prompt_tokens: 7 });

  const events = eventsOf(res);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message_start");
  assert.deepEqual(events[0].data, {
    type: "message_start",
    message: {
      id: "msg_fixed",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  });

  const res2 = recorderRes();
  const writer2 = new AnthropicStreamWriter(res2, "claude-sonnet-4-6");
  writer2.start();

  const generated = eventsOf(res2);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].event, "message_start");
  assert.match(generated[0].data.message.id, /^msg_[0-9a-f]{24}$/);
  assert.deepEqual(generated[0].data.message.usage, {
    input_tokens: 0,
    output_tokens: 0,
  });
});

test("second start() call is a no-op", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_first");
  writer.start("msg_second", { prompt_tokens: 99 });

  const events = eventsOf(res);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message_start");
  assert.equal(events[0].data.message.id, "msg_first");
  assert.equal(events[0].data.message.usage.input_tokens, 0);
});

test("consecutive text() deltas share one lazily-opened text block", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.text("Hello ");
  writer.text("world");
  writer.finish("stop");

  const events = eventsOf(res);
  const starts = blockStarts(events);

  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.index, 0);
  assert.deepEqual(starts[0].data.content_block, { type: "text", text: "" });

  const deltas = events.filter((e) => e.event === "content_block_delta");
  assert.deepEqual(deltas.map((d) => d.data.index), [0, 0]);
  assert.deepEqual(
    deltas.map((d) => d.data.delta),
    [
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world" },
    ],
  );

  assertBlocksPairCleanly(events);
});

test("thinking() then text(): thinking block closes BEFORE the text block starts", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_tt");
  writer.thinking("pondering");
  writer.thinking(" more");
  writer.text("answer");
  writer.finish("stop");

  const events = eventsOf(res);
  const kinds = events.map((e) => `${e.event}:${e.data.index ?? "-"}`);

  assert.deepEqual(kinds.slice(0, 8), [
    "message_start:-",
    "content_block_start:0",
    "content_block_delta:0",
    "content_block_delta:0",
    "content_block_stop:0",
    "content_block_start:1",
    "content_block_delta:1",
    "content_block_stop:1",
  ]);

  const thinkingStart = blockStarts(events)[0];
  assert.equal(thinkingStart.data.index, 0);
  assert.deepEqual(thinkingStart.data.content_block, {
    type: "thinking",
    thinking: "",
  });

  const thinkingDeltas = events.filter(
    (e) =>
      e.event === "content_block_delta" &&
      e.data.delta.type === "thinking_delta",
  );
  assert.deepEqual(thinkingDeltas.map((d) => d.data.delta.thinking), [
    "pondering",
    " more",
  ]);

  assertBlocksPairCleanly(events);
});

test('text("") after thinking closes the thinking block but opens no text block', () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_empty");
  writer.thinking("silent");
  writer.text("");
  writer.finish("stop");

  const events = eventsOf(res);

  const textStarts = blockStarts(events).filter(
    (e) => e.data.content_block.type === "text",
  );
  assert.equal(textStarts.length, 0);
  assert.equal(
    events.filter((e) => e.event === "content_block_delta").length,
    1,
    "only the thinking_delta should exist",
  );

  const stops = blockStops(events);
  assert.deepEqual(stops.map((s) => s.data.index), [0]);

  assert.equal(writtenText(res).includes("[proxy]"), false);

  assertBlocksPairCleanly(events);
});

test("toolDelta keys blocks by index ?? 0, reuses blocks per index, streams exact arg fragments", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_tools");
  writer.toolDelta({
    index: 1,
    id: "call_b",
    function: { name: "tool_b", arguments: '{"b":' },
  });
  writer.toolDelta({
    index: 0,
    id: "call_a",
    function: { name: "tool_a", arguments: '{"x":1' },
  });
  writer.toolDelta({ index: 0 });
  writer.toolDelta({ index: 0, function: { arguments: "}" } });
  writer.toolDelta({ index: 1, function: { arguments: "2}" } });
  writer.finish("tool_calls");

  const events = eventsOf(res);
  const starts = blockStarts(events);

  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].data, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "call_b", name: "tool_b", input: {} },
  });
  assert.deepEqual(starts[1].data, {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "call_a", name: "tool_a", input: {} },
  });

  const jsonDeltas = events.filter(
    (e) =>
      e.event === "content_block_delta" &&
      e.data.delta.type === "input_json_delta",
  );

  assert.deepEqual(
    jsonDeltas
      .filter((d) => d.data.index === 0)
      .map((d) => d.data.delta.partial_json),
    ['{"b":', "2}"],
  );
  assert.deepEqual(
    jsonDeltas
      .filter((d) => d.data.index === 1)
      .map((d) => d.data.delta.partial_json),
    ['{"x":1', "}"],
  );

  assert.deepEqual(blockStops(events).map((s) => s.data.index), [0, 1]);
  assertBlocksPairCleanly(events);

  const res2 = recorderRes();
  const writer2 = new AnthropicStreamWriter(res2, "m");
  writer2.toolDelta({
    id: "call_solo",
    function: { name: "solo", arguments: '{"k":1}' },
  });
  writer2.finish("tool_calls");

  const soloStarts = blockStarts(eventsOf(res2));
  assert.equal(soloStarts.length, 1);
  assert.equal(soloStarts[0].data.index, 0);
  assert.equal(soloStarts[0].data.content_block.id, "call_solo");
});

test("regression guard: thinking + text + 2 tools -> every block start pairs with exactly one stop", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_full");
  writer.thinking("step ");
  writer.thinking("one");
  writer.text("partial answer");
  writer.toolDelta({
    index: 0,
    id: "call_a",
    function: { name: "alpha", arguments: '{"n":1}' },
  });
  writer.toolDelta({
    index: 1,
    id: "call_b",
    function: { name: "beta", arguments: "{}" },
  });
  writer.finish("tool_calls");

  const events = eventsOf(res);
  const starts = blockStarts(events);

  assert.deepEqual(
    starts.map((s) => s.data.content_block.type),
    ["thinking", "text", "tool_use", "tool_use"],
  );
  assert.deepEqual(
    starts.map((s) => s.data.index),
    [0, 1, 2, 3],
  );

  assertBlocksPairCleanly(events);

  assert.deepEqual(events.slice(-2).map((e) => e.event), [
    "message_delta",
    "message_stop",
  ]);
  const finalDelta = events[events.length - 2];
  assert.equal(finalDelta.data.delta.stop_reason, "tool_use");
  assert.equal(res.writableEnded, true);
  assert.equal(writtenText(res).includes("[proxy]"), false);
});

test("finish injects the EXACT length-reason note when only thinking was produced", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_len", { prompt_tokens: 3 });
  writer.thinking("only reasoning");
  writer.finish("length", { completion_tokens: 9 });

  const events = eventsOf(res);
  const noteDeltas = events.filter(
    (e) =>
      e.event === "content_block_delta" && e.data.delta.type === "text_delta",
  );

  assert.equal(noteDeltas.length, 1);
  assert.deepEqual(noteDeltas[0].data.delta, {
    type: "text_delta",
    text: LENGTH_NOTE,
  });

  const noteStart = blockStarts(events).find(
    (e) => e.data.content_block.type === "text",
  );
  assert.equal(noteStart.data.index, 1);
  assert.deepEqual(blockStops(events).map((s) => s.data.index), [0, 1]);
  assertBlocksPairCleanly(events);

  const delta = events.filter((e) => e.event === "message_delta")[0];
  assert.equal(delta.data.delta.stop_reason, "max_tokens");
  assert.equal(delta.data.usage.output_tokens, 9);
});

test("finish injects the EXACT generic note for non-length reasons with only thinking", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_generic");
  writer.thinking("hmm");
  writer.finish("upstream_stream_ended_without_finish_reason");

  const events = eventsOf(res);
  const noteDeltas = events.filter(
    (e) =>
      e.event === "content_block_delta" && e.data.delta.type === "text_delta",
  );

  assert.equal(noteDeltas.length, 1);
  assert.equal(noteDeltas[0].data.delta.text, GENERIC_NOTE);

  const delta = events.filter((e) => e.event === "message_delta")[0];
  assert.equal(delta.data.delta.stop_reason, "end_turn");
  assertBlocksPairCleanly(events);
});

test("note is suppressed when real text or tool output exists", () => {
  const res1 = recorderRes();
  const writer1 = new AnthropicStreamWriter(res1, "m");
  writer1.start("msg_sup1");
  writer1.thinking("why");
  writer1.text("real answer");
  writer1.finish("length");

  const events1 = eventsOf(res1);
  const textDeltas1 = events1.filter(
    (e) =>
      e.event === "content_block_delta" && e.data.delta.type === "text_delta",
  );
  assert.deepEqual(textDeltas1.map((d) => d.data.delta.text), ["real answer"]);
  assert.equal(writtenText(res1).includes("[proxy]"), false);

  const res2 = recorderRes();
  const writer2 = new AnthropicStreamWriter(res2, "m");
  writer2.start("msg_sup2");
  writer2.thinking("why");
  writer2.toolDelta({
    index: 0,
    id: "call_t",
    function: { name: "t", arguments: "{}" },
  });
  writer2.finish("length");

  const events2 = eventsOf(res2);
  assert.equal(
    events2.some(
      (e) =>
        e.event === "content_block_delta" &&
        e.data.delta.type === "text_delta",
    ),
    false,
  );
  assert.equal(
    blockStarts(events2).some((e) => e.data.content_block.type === "text"),
    false,
  );
  assert.equal(writtenText(res2).includes("[proxy]"), false);
  assert.equal(
    events2.filter((e) => e.event === "message_delta")[0].data.delta.stop_reason,
    "max_tokens",
  );
  assertBlocksPairCleanly(events2);
});

test("finish emits message_delta then message_stop then ends res, mapping stop_reason", () => {
  const cases = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
  ];

  for (const [reason, expectedStopReason] of cases) {
    const res = recorderRes();
    const writer = new AnthropicStreamWriter(res, "claude-test-model");

    writer.start("msg_order");
    writer.text("payload");
    writer.finish(reason);

    const events = eventsOf(res);
    const delta = events[events.length - 2];
    const stop = events[events.length - 1];

    assert.equal(stop.event, "message_stop");
    assert.deepEqual(stop.data, { type: "message_stop" });

    assert.equal(delta.event, "message_delta");
    assert.equal(delta.data.type, "message_delta");
    assert.equal(delta.data.delta.stop_reason, expectedStopReason);
    assert.equal(delta.data.delta.stop_sequence, null);
    assert.equal(typeof delta.data.usage.output_tokens, "number");

    assert.equal(res.writableEnded, true);
    assert.equal(res.calls[res.calls.length - 1].kind, "end");
  }
});

test("outputTokens honors completion_tokens ?? previous-value semantics", () => {
  const res1 = recorderRes();
  const writer1 = new AnthropicStreamWriter(res1, "m");
  writer1.start("msg_zero");
  writer1.text("hi");
  writer1.outputTokens = 55;
  writer1.finish("stop", { completion_tokens: 0 });

  const delta1 = eventsOf(res1).filter((e) => e.event === "message_delta")[0];
  assert.equal(delta1.data.usage.output_tokens, 0);

  const res2 = recorderRes();
  const writer2 = new AnthropicStreamWriter(res2, "m");
  writer2.start("msg_keep");
  writer2.text("hi");
  writer2.outputTokens = 33;
  writer2.finish("stop", {});

  const delta2 = eventsOf(res2).filter((e) => e.event === "message_delta")[0];
  assert.equal(delta2.data.usage.output_tokens, 33);
});

test("finish/error/text after finish are fully inert", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_once");
  writer.text("a");
  writer.finish("stop");

  const snapshot = writtenText(res);
  const callCount = res.calls.length;

  writer.finish("stop");
  writer.error("api_error", "late");
  writer.text("more");
  writer.thinking("later still");

  assert.equal(writtenText(res), snapshot);
  assert.equal(res.calls.length, callCount);
  assert.equal(res.writableEnded, true);
});

test("error() emits the error event then ends the response", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_err");
  writer.error("api_error", "boom");

  const events = eventsOf(res);
  const last = events[events.length - 1];

  assert.equal(last.event, "error");
  assert.deepEqual(last.data, {
    type: "error",
    error: { type: "api_error", message: "boom" },
  });

  assert.equal(res.writableEnded, true);
  assert.equal(res.calls[res.calls.length - 1].kind, "end");
});

test("externally-set writer.outputTokens flows into message_delta usage", () => {
  const res = recorderRes();
  const writer = new AnthropicStreamWriter(res, "m");

  writer.start("msg_usage", { prompt_tokens: 5 });
  writer.outputTokens = 42;
  writer.finish("stop");

  const events = eventsOf(res);
  assert.equal(
    events.filter((e) => e.event === "message_start")[0].data.message.usage
      .input_tokens,
    5,
  );
  assert.equal(
    events.filter((e) => e.event === "message_delta")[0].data.usage
      .output_tokens,
    42,
  );
});
