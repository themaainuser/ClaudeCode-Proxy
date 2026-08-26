import test from "node:test";
import assert from "node:assert/strict";
import { makeId } from "../src/ids.js";

test('makeId("call") matches /^call_[0-9a-f]{24}$/ across several samples', () => {
  const pattern = /^call_[0-9a-f]{24}$/;
  for (let i = 0; i < 50; i++) {
    assert.match(makeId("call"), pattern);
  }
});

test("makeId generates unique ids across 1000 calls", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    ids.add(makeId("call"));
  }
  assert.equal(ids.size, 1000);
});

test("makeId respects the given prefix", () => {
  assert.match(makeId("msg"), /^msg_[0-9a-f]{24}$/);
  assert.match(makeId("toolu"), /^toolu_[0-9a-f]{24}$/);
  assert.equal(makeId("msg").startsWith("msg_"), true);
  assert.notEqual(makeId("msg").slice(0, 5), "call_");
});
