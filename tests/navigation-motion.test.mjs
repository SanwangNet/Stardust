import assert from "node:assert/strict";
import { test } from "node:test";
import { getNavigationDirection, getStaggerTiming, navigationMotion } from "../apps/web/dist/navigation-motion.js";

test("navigation direction follows the visible category and page order", () => {
  assert.equal(getNavigationDirection(0, 1), 1);
  assert.equal(getNavigationDirection(1, 3), 1);
  assert.equal(getNavigationDirection(3, 0), -1);
  assert.equal(getNavigationDirection(2, 1), -1);
});

test("staggered elements share one finish time and retain a visible minimum duration", () => {
  const finishTimes = Array.from({ length: 20 }, (_, index) => {
    const timing = getStaggerTiming(index);
    assert.ok(timing.duration >= navigationMotion.minimumStaggerDurationMs);
    assert.ok(timing.delay >= 0);
    return timing.delay + timing.duration;
  });

  assert.ok(finishTimes.every((finishAt) => finishAt === navigationMotion.pageDurationMs));
  assert.equal(getStaggerTiming(0).duration, navigationMotion.pageDurationMs);
  assert.equal(getStaggerTiming(1).delay, navigationMotion.staggerIntervalMs);
});
