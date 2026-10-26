import assert from "node:assert/strict";
import test from "node:test";
import { splitDirection } from "../src/herdr.ts";

test("splits leave at least 80 columns and 24 rows, otherwise use a tab", () => {
  for (const [width, height, expected] of [
    [160, 24, "right"], [159, 24, null], [160, 23, null],
    [80, 48, "down"], [80, 47, null], [79, 48, null],
    [120, 40, null], [160, 100, "down"],
  ] as const) assert.equal(splitDirection(width, height), expected, `${width}×${height}`);
});
