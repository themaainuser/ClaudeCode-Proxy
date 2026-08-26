/**
 * Tests for src/logger.js - prefixed stderr loggers built from config flags.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createLoggers, silentLog } from "../src/logger.js";
import { loadConfig } from "../src/config.js";

/**
 * Replace console.error with a no-op recorder for the duration of one test
 * (t.mock restores it automatically when the test ends).
 */
function captureConsoleError(t) {
  return t.mock.method(console, "error", () => {});
}

/** Join recorded console.error arguments exactly as the real console would render them. */
function renderedLine(mockCall) {
  return mockCall.arguments.map((arg) => String(arg)).join(" ");
}

test("disabled loggers write nothing", (t) => {
  const error = captureConsoleError(t);
  const log = createLoggers(loadConfig({}));

  log.debug("hello");
  log.debugRequest("x");
  log.debugResponse("y");

  assert.equal(error.mock.callCount(), 0);
});

test("enabled debug writes exact \"[proxy] \" prefix", (t) => {
  const error = captureConsoleError(t);
  const log = createLoggers(loadConfig({ DEBUG: "1" }));

  log.debug("hello", "world");

  assert.equal(error.mock.callCount(), 1);
  assert.equal(renderedLine(error.mock.calls[0]), "[proxy] hello world");
});

test("enabled debugRequest writes exact \"[claude->proxy] \" prefix", (t) => {
  const error = captureConsoleError(t);
  const log = createLoggers(loadConfig({ DEBUG_REQUEST: "1" }));

  log.debugRequest("x");

  assert.equal(error.mock.callCount(), 1);
  assert.equal(renderedLine(error.mock.calls[0]), "[claude->proxy] x");
});

test("enabled debugResponse writes exact \"[zen->proxy] \" prefix", (t) => {
  const error = captureConsoleError(t);
  const log = createLoggers(loadConfig({ DEBUG_RESPONSE: "1" }));

  log.debugResponse("y");

  assert.equal(error.mock.callCount(), 1);
  assert.equal(renderedLine(error.mock.calls[0]), "[zen->proxy] y");
});

test("each logger is gated independently by its own flag", (t) => {
  const error = captureConsoleError(t);
  const log = createLoggers(
    loadConfig({ DEBUG: "true", DEBUG_REQUEST: "yes", DEBUG_RESPONSE: "true" })
  );

  log.debug("a", "b");
  log.debugRequest("c");
  log.debugResponse("d");

  assert.equal(error.mock.callCount(), 3);
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments),
    [
      ["[proxy]", "a", "b"],
      ["[claude->proxy]", "c"],
      ["[zen->proxy]", "d"],
    ]
  );
});

test("silentLog calls are no-ops", (t) => {
  const error = captureConsoleError(t);

  assert.equal(silentLog.debug("anything"), undefined);
  assert.equal(silentLog.debugRequest("anything"), undefined);
  assert.equal(silentLog.debugResponse("anything"), undefined);

  assert.equal(error.mock.callCount(), 0);
});
