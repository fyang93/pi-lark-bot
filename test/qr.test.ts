import assert from "node:assert/strict";
import test from "node:test";
import { renderQrCode } from "../src/qr.ts";

test("renders a terminal QR code with a white quiet zone", () => {
  const qr = renderQrCode("https://open.feishu.cn/verify?device_code=test");
  const lines = qr.split("\n");
  assert(lines.length > 10);
  assert(lines.every((line) => line.startsWith("\x1b[47m\x1b[30m") && line.endsWith("\x1b[0m")));
  const first = lines[0]!.slice("\x1b[47m\x1b[30m".length, -"\x1b[0m".length);
  assert.match(first, /^ +$/);
  assert.match(qr, /[█▀▄]/);
});
