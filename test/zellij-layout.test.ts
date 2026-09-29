import assert from "node:assert/strict";
import test from "node:test";
import { selectPlacement, splitDirection, type PaneGeometry } from "../src/zellij-layout.ts";

const parent: PaneGeometry = { id: 0, is_plugin: false, tab_id: 1, pane_rows: 40, pane_columns: 120 };

test("source geometry boundaries keep the parent and every sibling within size", () => {
  assert.deepEqual(selectPlacement([parent], 0), { paneId: 0, direction: "right" });
  assert.equal(splitDirection({ ...parent, pane_rows: 21, pane_columns: 104 }), "right");
  assert.equal(splitDirection({ ...parent, pane_rows: 19, pane_columns: 99 }), null);
  assert.equal(selectPlacement([{ ...parent, pane_rows: 41 }], 0)?.paneId, 0);
  assert.equal(selectPlacement([{ ...parent, pane_columns: 119 }, { ...parent, id: 7, pane_columns: 100 }], 0)?.paneId, 7);
  assert.equal(selectPlacement([parent, { ...parent, id: 7, pane_columns: 130 }], 0), null);
  assert.equal(selectPlacement([parent, { ...parent, id: 7, pane_columns: undefined }], 0), null);
  assert.equal(selectPlacement([parent, { ...parent, id: 7, is_fullscreen: true }], 0), null);
  assert.deepEqual(selectPlacement([parent, { ...parent, id: 7, tab_id: 2, is_fullscreen: true }], 0), { paneId: 0, direction: "right" });
  assert.deepEqual(selectPlacement([parent, { ...parent, id: 7, is_plugin: true }], 0), { paneId: 0, direction: "right" });
  assert.equal(selectPlacement([{ ...parent, pane_content_columns: 121 }], 0), null);
  assert.equal(selectPlacement([{ ...parent, is_floating: true }], 0), null);
});
