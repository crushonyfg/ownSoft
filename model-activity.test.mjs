import assert from "node:assert/strict";
import { test } from "node:test";
import { inactivityTimeout } from "./model-activity.mjs";

test("model activity extends a turn beyond its original timeout and inactivity still expires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let expired = 0;
  const timeout = inactivityTimeout(600_000, () => { expired += 1; });
  t.mock.timers.tick(590_000);
  timeout.touch();
  t.mock.timers.tick(590_000);
  assert.equal(expired, 0);
  t.mock.timers.tick(10_000);
  assert.equal(expired, 1);
  timeout.close();
  timeout.touch();
  t.mock.timers.tick(600_000);
  assert.equal(expired, 1);
});
