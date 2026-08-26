/**
 * Tests for src/sse-openai-parser.js - frame splitting, DONE handling,
 * non-data lines, malformed payloads, buffering, and end()-flushing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { OpenAISSEParser } from "../src/sse-openai-parser.js";

/** Collect events/malformed payloads from one parser instance. */
function collect(parser) {
  const events = [];
  const malformed = [];
  parser.onEvent = (event) => events.push(event);
  parser.onMalformed = (payload) => malformed.push(payload);
  return { events, malformed };
}

function makeParser() {
  const parser = new OpenAISSEParser(() => {}, undefined);
  const collected = collect(parser);
  return { parser, ...collected };
}

test("LF-separated frames are parsed in order", () => {
  const { parser, events } = makeParser();

  parser.feed('data: {"a":1}\ndata: {"b":2}\ndata: {"c":3}\n');

  assert.deepEqual(events, [
    { done: false, data: { a: 1 } },
    { done: false, data: { b: 2 } },
    { done: false, data: { c: 3 } },
  ]);
});

test("CRLF-separated frames are handled identically", () => {
  const { parser, events } = makeParser();

  parser.feed('data: {"x":"one"}\r\ndata: {"x":"two"}\r\n');

  assert.deepEqual(events, [
    { done: false, data: { x: "one" } },
    { done: false, data: { x: "two" } },
  ]);
});

test("data: [DONE] emits {done:true}", () => {
  const { parser, events } = makeParser();

  parser.feed('data: {"ok":true}\ndata: [DONE]\n');

  assert.deepEqual(events, [
    { done: false, data: { ok: true } },
    { done: true },
  ]);
});

test("bare data: (empty payload) also emits {done:true}", () => {
  const { parser, events } = makeParser();

  parser.feed("data: \n");

  assert.deepEqual(events, [{ done: true }]);
});

test("event/comment/id lines are ignored entirely", () => {
  const { parser, events, malformed } = makeParser();

  parser.feed(
    [
      "event: message.delta",
      ": keep-alive comment",
      "id: 5",
      'data: {"n":7}',
      "",
      "",
    ].join("\n"),
  );

  assert.deepEqual(events, [{ done: false, data: { n: 7 } }]);
  assert.equal(malformed.length, 0);
});

test("malformed JSON reports exact payload via onMalformed and parsing continues", () => {
  let malformedPayload;
  const events = [];
  const parser = new OpenAISSEParser((e) => events.push(e), {
    onMalformed: (payload) => {
      malformedPayload = payload;
    },
  });

  parser.feed('data: {not-json-here\ndata: {"after":true}\n');

  assert.equal(malformedPayload, "{not-json-here");
  assert.deepEqual(events, [{ done: false, data: { after: true } }]);
});

test("malformed frame emits no onEvent data", () => {
  const { parser, events } = makeParser();

  parser.feed('data: {{{oops}}}\n');

  assert.deepEqual(events, []);
});

test("partial frame split across feed() calls is buffered until complete", () => {
  const first = makeParser();
  first.parser.feed('data: {"par');
  assert.deepEqual(first.events, [], "no event before the line terminates");

  first.parser.feed('tial":42}\n');

  assert.deepEqual(first.events, [{ done: false, data: { partial: 42 } }]);
  assert.deepEqual(first.malformed, []);
});

test("end() flushes a trailing complete line lacking a newline", () => {
  const { parser, events } = makeParser();

  parser.feed('data: {"a":1}\n');
  parser.feed("data: [DONE]");
  assert.deepEqual(events, [{ done: false, data: { a: 1 } }]);

  parser.end();

  assert.deepEqual(events, [
    { done: false, data: { a: 1 } },
    { done: true },
  ]);
});

test("end() with empty buffer is a safe no-op", () => {
  const fresh = makeParser();
  assert.doesNotThrow(() => fresh.parser.end());
  assert.deepEqual(fresh.events, []);

  const drained = makeParser();
  drained.parser.feed('data: {"a":1}\n');
  drained.parser.end();
  assert.doesNotThrow(() => drained.parser.end());
  assert.deepEqual(drained.events, [{ done: false, data: { a: 1 } }]);
});
