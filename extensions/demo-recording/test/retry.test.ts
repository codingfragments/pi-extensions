import assert from "node:assert/strict";
import { test } from "node:test";
import { retryOnce } from "./helpers/retry.ts";

test("retryOnce: passes when a later attempt passes, fails when every attempt fails, runs once when it passes", async () => {
  let n = 0;
  await retryOnce(() => {
    n++;
    if (n < 2) throw new Error("first attempt fails");
  })();
  assert.equal(n, 2, "a flake is retried");
  let m = 0;
  await retryOnce(() => {
    m++;
  })();
  assert.equal(m, 1, "a pass is not repeated");
  let k = 0;
  await assert.rejects(
    retryOnce(() => {
      k++;
      throw new Error("always");
    })(),
    /always/,
  );
  assert.equal(k, 2, "a real failure fails every attempt and is reported");
});
