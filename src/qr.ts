import QRCode from "qrcode";

/**
 * Render a QR code using terminal colours and half-block characters. The white
 * background is intentional: it makes the code scannable regardless of the
 * terminal's configured foreground/background colours.
 */
export function renderQrCode(value: string): string {
  const code = QRCode.create(value, { errorCorrectionLevel: "M" });
  const margin = 4;
  const size = code.modules.size + margin * 2;
  const dark = (row: number, column: number) =>
    row >= margin && row < size - margin && column >= margin && column < size - margin &&
    code.modules.get(row - margin, column - margin) === 1;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "\x1b[47m\x1b[30m";
    for (let column = 0; column < size; column++) {
      const top = dark(row, column);
      const bottom = dark(row + 1, column);
      line += top ? bottom ? "█" : "▀" : bottom ? "▄" : " ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}
