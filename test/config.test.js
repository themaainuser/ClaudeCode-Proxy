import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MIN_ANSWER_TOKENS,
  isTruthy,
  loadConfig,
} from "../src/config.js";

test("loadConfig({}) returns documented defaults", () => {
  const cfg = loadConfig({});

  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 8787);
  assert.equal(typeof cfg.port, "number");
  assert.equal(cfg.zenUrl, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(cfg.zenModel, "x-preview-f-free");
  assert.equal(cfg.zenApiKey, "");
  assert.equal(cfg.debug, false);
  assert.equal(cfg.debugRequest, false);
  assert.equal(cfg.debugResponse, false);
  assert.equal(cfg.minAnswerTokens, DEFAULT_MIN_ANSWER_TOKENS);
  assert.equal(cfg.minAnswerTokens, 1024);
});

test("isTruthy accepts 1/true/yes case-insensitively", () => {
  for (const value of ["1", "true", "yes", "TRUE", "True", "YES", "Yes"]) {
    assert.equal(isTruthy(value), true, `expected ${value} to be truthy`);
  }
  // The regex runs against value || "", so an empty string is falsy.
  assert.equal(isTruthy(""), false);
  assert.equal(isTruthy(null), false);
});

test("isTruthy rejects 0/false/no/garbage/undefined", () => {
  for (const value of ["0", "false", "no", "garbage", "on", "enabled", " 1 ", undefined]) {
    assert.equal(isTruthy(value), false, `expected ${value} to be falsy`);
  }
});

test("loadConfig honors and coerces environment overrides", () => {
  const cfg = loadConfig({
    HOST: "0.0.0.0",
    PORT: "9000",
    ZEN_BASE_URL: "http://localhost:9999/v1/chat/completions",
    ZEN_MODEL: "gpt-test-model",
    ZEN_API_KEY: "sk-test",
  });

  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 9000);
  assert.equal(typeof cfg.port, "number");
  assert.equal(cfg.zenUrl, "http://localhost:9999/v1/chat/completions");
  assert.equal(cfg.zenModel, "gpt-test-model");
  assert.equal(cfg.zenApiKey, "sk-test");
});

test("ZEN_MIN_ANSWER_TOKENS garbage propagates NaN (preserved quirk)", () => {
  const cfg = loadConfig({ ZEN_MIN_ANSWER_TOKENS: "not-a-number" });

  assert.ok(Number.isNaN(cfg.minAnswerTokens));
});

test("loadConfig returns a frozen object", () => {
  const cfg = loadConfig({});

  assert.ok(Object.isFrozen(cfg));

  assert.throws(() => {
    "use strict";
    cfg.port = 1;
  }, TypeError);

  assert.throws(() => {
    "use strict";
    cfg.newField = "nope";
  }, TypeError);
});
