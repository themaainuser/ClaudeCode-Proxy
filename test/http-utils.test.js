import test from "node:test";
import assert from "node:assert/strict";
import { json, anthropicError, readBody } from "../src/http-utils.js";
import { recorderRes, stubReq } from "./helpers/stub-http.js";

/** recorderRes plus capture of the end() payload (helpers' end() drops it). */
function recordingEndRes() {
  const res = recorderRes();
  const ended = [];
  res.end = (...args) => {
    ended.push(args);
    return recorderEnd(res, args);
  };
  function recorderEnd(target, args) {
    Object.defineProperty(target, "writableEnded", { value: true, configurable: true });
    target.calls.push({ kind: "end" });
    return target;
  }
  return { res, ended };
}

test("json() sets content-type, correct content-length, and ends with the serialized body", () => {
  const { res, ended } = recordingEndRes();
  const body = { ok: true, items: ["a", "b"] };

  json(res, 200, body);

  const head = res.calls.find((c) => c.kind === "writeHead");
  assert.ok(head, "writeHead should have been called");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "application/json; charset=utf-8");

  const data = JSON.stringify(body);
  assert.equal(head.headers["content-length"], Buffer.byteLength(data));

  assert.equal(ended.length, 1);
  assert.equal(ended[0][0], data); // exact serialized string passed to end()
  assert.equal(JSON.parse(ended[0][0]).items.join(","), "a,b");
});

test("json() encodes non-ascii payloads with utf-8 byte length in content-length", () => {
  const res = recorderRes();
  const body = { text: "héllo → 世界" };

  json(res, 201, body);

  const head = res.calls.find((c) => c.kind === "writeHead");
  const data = JSON.stringify(body);
  assert.equal(head.status, 201);
  assert.equal(head.headers["content-length"], Buffer.byteLength(data));
});

test("json() is a no-op when writableEnded is already true", () => {
  const res = recorderRes();
  res.end(); // simulate already-ended response

  const callsBefore = res.calls.length;
  json(res, 200, { anything: true });

  assert.equal(res.calls.length, callsBefore, "no additional writeHead/write/end calls");
  assert.equal(res.headersSent, false);
});

test("anthropicError() emits {type:error,error:{type,message,...extra}} with extra spread after message", () => {
  const { res, ended } = recordingEndRes();

  anthropicError(res, 502, "api_connection_error", "boom", { detail: "x", retryable: true });

  const head = res.calls.find((c) => c.kind === "writeHead");
  assert.equal(head.status, 502);

  const payload = JSON.parse(ended[0][0]);
  assert.deepEqual(payload, {
    type: "error",
    error: { type: "api_connection_error", message: "boom", detail: "x", retryable: true },
  });
  // Key order inside error: type, message, then extra fields
  assert.deepEqual(Object.keys(payload.error), ["type", "message", "detail", "retryable"]);
  assert.equal(head.headers["content-length"], Buffer.byteLength(ended[0][0]));
});

test("anthropicError() works without extra (defaults to {})", () => {
  const { res, ended } = recordingEndRes();

  anthropicError(res, 400, "invalid_request_error", "bad input");

  const head = res.calls.find((c) => c.kind === "writeHead");
  assert.equal(head.status, 400);
  assert.equal(ended.length, 1);
  const payload = JSON.parse(ended[0][0]);
  assert.deepEqual(payload, {
    type: "error",
    error: { type: "invalid_request_error", message: "bad input" },
  });
});

test("readBody() concatenates multiple utf8 chunks into one string", async () => {
  const req = stubReq(Buffer.from("hello "), Buffer.from("wörld"), Buffer.from("!"));

  const raw = await readBody(req);
  assert.equal(raw, "hello wörld!");
});
