// Tiny 3x5 bitmap font for drawing text into the 240x160 canvas when no
// ROM is loaded (idle / "insert cartridge" screens).

const GLYPHS: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0],
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3],
  D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7],
  J: [1, 1, 1, 5, 2], K: [5, 6, 4, 6, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2],
  P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [6, 1, 2, 4, 7],
  "3": [6, 1, 2, 1, 6], "4": [1, 5, 7, 1, 1], "5": [7, 4, 6, 1, 6],
  "6": [3, 4, 6, 5, 2], "7": [7, 1, 2, 2, 2], "8": [2, 5, 2, 5, 2],
  "9": [2, 5, 3, 1, 6],
  ".": [0, 0, 0, 0, 2], "!": [2, 2, 2, 0, 2], ":": [0, 2, 0, 2, 0],
  "-": [0, 0, 7, 0, 0], "/": [1, 1, 2, 4, 4], "_": [0, 0, 0, 0, 7],
  ">": [4, 2, 1, 2, 4], "*": [0, 5, 2, 5, 0],
};

export function pixelTextWidth(text: string, scale: number): number {
  return text.length * 4 * scale - scale;
}

export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  scale: number,
  color: string,
): void {
  ctx.fillStyle = color;
  let cx = x;
  for (const raw of text.toUpperCase()) {
    const g = GLYPHS[raw] || GLYPHS[" "];
    for (let row = 0; row < 5; row++) {
      const bits = g[row];
      for (let col = 0; col < 3; col++) {
        if (bits & (4 >> col)) {
          ctx.fillRect(cx + col * scale, y + row * scale, scale, scale);
        }
      }
    }
    cx += 4 * scale;
  }
}

/** Centered helper. */
export function drawPixelTextCentered(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  text: string,
  scale: number,
  color: string,
): void {
  drawPixelText(ctx, cx - Math.floor(pixelTextWidth(text, scale) / 2), y, text, scale, color);
}
