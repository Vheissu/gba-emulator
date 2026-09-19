// GBA PPU: 240x160, 6 video modes, text + affine backgrounds, sprites,
// windows, alpha blending / fade, mosaic.
//
// Scanline timing: 1232 cycles/line (960 draw + 272 hblank),
// 228 lines/frame (160 visible + 68 vblank) = 280896 cycles/frame.
//
// Each layer is rendered for the whole line into a buffer of 15-bit
// colours (TRANSPARENT where nothing was drawn), then composed.

import type { StateReader, StateWriter } from "./state";

export const SCREEN_W = 240;
export const SCREEN_H = 160;

const HDRAW_CYCLES = 960;
const LINE_CYCLES = 1232;
const TOTAL_LINES = 228;

const TRANSPARENT = 0x8000;
const LAYER_OBJ = 4;
const LAYER_BACKDROP = 5;

// DISPSTAT bits
const STAT_VBLANK = 1, STAT_HBLANK = 2, STAT_VCOUNT = 4;
const STAT_VBLANK_IRQ = 8, STAT_HBLANK_IRQ = 0x10, STAT_VCOUNT_IRQ = 0x20;

// objAttr bits alongside the 2-bit priority
const OBJ_SEMI = 4;

const OBJ_SIZES = [ // [shape][size] -> [w, h]
  [[8, 8], [16, 16], [32, 32], [64, 64]],
  [[16, 8], [32, 8], [32, 16], [64, 32]],
  [[8, 16], [8, 32], [16, 32], [32, 64]],
  [[8, 8], [8, 8], [8, 8], [8, 8]],
];

export class PPU {
  vram!: Uint8Array;
  pal16!: Uint16Array;
  oam16!: Uint16Array;

  private fb32 = new Uint32Array(SCREEN_W * SCREEN_H);
  /** RGBA bytes of the most recently drawn frame. */
  readonly framebuffer = new Uint8Array(this.fb32.buffer);
  /** 15-bit BGR -> packed RGBA. */
  private colorLut = new Uint32Array(0x8000);

  // IO registers
  private dispcnt = 0x80;
  private dispstat = 0;
  private vcount = 0;
  private bgcnt = new Uint16Array(4);
  private bghofs = new Uint16Array(4);
  private bgvofs = new Uint16Array(4);
  // Affine parameters for BG2/BG3, indexed by bg - 2.
  private bgpa = new Int16Array(2);
  private bgpb = new Int16Array(2);
  private bgpc = new Int16Array(2);
  private bgpd = new Int16Array(2);
  private bgx = new Int32Array(2);
  private bgy = new Int32Array(2);
  /** Internal reference points: reloaded from bgx/bgy each frame (or when
   *  written) and stepped by pb/pd after every visible line. */
  private refX = new Int32Array(2);
  private refY = new Int32Array(2);

  private winh = new Uint16Array(2);
  private winv = new Uint16Array(2);
  private winin = 0;
  private winout = 0;
  private mosaic = 0;
  private bldcnt = 0;
  private bldalpha = 0;
  private bldy = 0;

  private cycles = 0;

  // Per-line scratch.
  private bgLine = [0, 1, 2, 3].map(() => new Uint16Array(SCREEN_W));
  private objLine = new Uint16Array(SCREEN_W);
  private objAttr = new Uint8Array(SCREEN_W);
  private objWindow = new Uint8Array(SCREEN_W);
  private winMask = new Uint8Array(SCREEN_W);
  private layerOrder = new Uint8Array(4);

  onVBlank: () => void = () => {};
  /** HBlank of a visible line (the only lines HBlank DMA runs on). */
  onHBlank: () => void = () => {};
  requestIrq: (bit: number) => void = () => {};

  constructor() {
    this.setColorCorrection(false);
  }

  reset(): void {
    this.dispcnt = 0x80;
    this.dispstat = 0;
    this.vcount = 0;
    this.cycles = 0;
    this.bgcnt.fill(0); this.bghofs.fill(0); this.bgvofs.fill(0);
    this.bgpa.fill(0x100); this.bgpb.fill(0); this.bgpc.fill(0); this.bgpd.fill(0x100);
    this.bgx.fill(0); this.bgy.fill(0); this.refX.fill(0); this.refY.fill(0);
    this.winh.fill(0); this.winv.fill(0);
    this.winin = this.winout = this.mosaic = 0;
    this.bldcnt = this.bldalpha = this.bldy = 0;
    this.fb32.fill(0xff000000);
  }

  /** Raw 5-bit expansion, or an approximation of the washed-out, slightly
   *  dark response of the real (non-backlit) LCD. */
  setColorCorrection(on: boolean): void {
    const lut = this.colorLut;
    for (let c = 0; c < 0x8000; c++) {
      const r5 = c & 31, g5 = (c >> 5) & 31, b5 = c >> 10;
      let r: number, g: number, b: number;
      if (on) {
        const lr = Math.pow(r5 / 31, 4), lg = Math.pow(g5 / 31, 4), lb = Math.pow(b5 / 31, 4);
        const out = (v: number) => Math.round(Math.pow(v / 255, 1 / 2.2) * 255 * (255 / 280));
        r = out(255 * lr + 50 * lg);
        g = out(10 * lr + 230 * lg + 30 * lb);
        b = out(50 * lr + 10 * lg + 220 * lb);
      } else {
        r = (r5 << 3) | (r5 >> 2); g = (g5 << 3) | (g5 >> 2); b = (b5 << 3) | (b5 >> 2);
      }
      lut[c] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // ------------------------------------------------------------------
  // Timing
  // ------------------------------------------------------------------

  cyclesUntilEvent(): number {
    return (this.dispstat & STAT_HBLANK ? LINE_CYCLES : HDRAW_CYCLES) - this.cycles;
  }

  advance(elapsed: number): void {
    this.cycles += elapsed;
    for (;;) {
      if (!(this.dispstat & STAT_HBLANK)) {
        if (this.cycles < HDRAW_CYCLES) return;
        this.beginHBlank();
      } else {
        if (this.cycles < LINE_CYCLES) return;
        this.cycles -= LINE_CYCLES;
        this.beginLine();
      }
    }
  }

  private beginHBlank(): void {
    this.dispstat |= STAT_HBLANK;
    if (this.vcount < SCREEN_H) this.renderLine(this.vcount);
    if (this.dispstat & STAT_HBLANK_IRQ) this.requestIrq(1);
    if (this.vcount < SCREEN_H) this.onHBlank();
  }

  private beginLine(): void {
    this.dispstat &= ~STAT_HBLANK;
    if (++this.vcount === TOTAL_LINES) {
      this.vcount = 0;
      this.dispstat &= ~STAT_VBLANK;
      this.refX.set(this.bgx);
      this.refY.set(this.bgy);
    } else if (this.vcount === SCREEN_H) {
      this.dispstat |= STAT_VBLANK;
      if (this.dispstat & STAT_VBLANK_IRQ) this.requestIrq(0);
      this.onVBlank();
    } else if (this.vcount === TOTAL_LINES - 1) {
      this.dispstat &= ~STAT_VBLANK; // the flag drops one line early
    }
    if (this.vcount === this.dispstat >>> 8) {
      this.dispstat |= STAT_VCOUNT;
      if (this.dispstat & STAT_VCOUNT_IRQ) this.requestIrq(2);
    } else {
      this.dispstat &= ~STAT_VCOUNT;
    }
  }

  // ------------------------------------------------------------------
  // IO (halfword registers, 0x000-0x05F). Reads return -1 when write-only.
  // ------------------------------------------------------------------

  ioRead(off: number): number {
    switch (off) {
      case 0x00: return this.dispcnt;
      case 0x02: return 0; // green swap
      case 0x04: return this.dispstat;
      case 0x06: return this.vcount;
      case 0x08: case 0x0a: case 0x0c: case 0x0e: return this.bgcnt[(off - 0x08) >> 1];
      case 0x48: return this.winin;
      case 0x4a: return this.winout;
      case 0x50: return this.bldcnt;
      case 0x52: return this.bldalpha;
    }
    return -1;
  }

  ioWrite(off: number, value: number): void {
    if (off >= 0x20 && off < 0x40) { this.writeAffine((off >> 4) - 2, off & 0xf, value); return; }
    switch (off) {
      case 0x00: this.dispcnt = value & 0xfff7; return; // bit 3 (CGB mode) is BIOS-only
      case 0x04: this.dispstat = (this.dispstat & 7) | (value & 0xff38); return;
      case 0x08: case 0x0a: this.bgcnt[(off - 0x08) >> 1] = value & 0xdfff; return;
      case 0x0c: case 0x0e: this.bgcnt[(off - 0x08) >> 1] = value; return;
      case 0x10: case 0x14: case 0x18: case 0x1c: this.bghofs[(off - 0x10) >> 2] = value & 0x1ff; return;
      case 0x12: case 0x16: case 0x1a: case 0x1e: this.bgvofs[(off - 0x12) >> 2] = value & 0x1ff; return;
      case 0x40: case 0x42: this.winh[(off - 0x40) >> 1] = value; return;
      case 0x44: case 0x46: this.winv[(off - 0x44) >> 1] = value; return;
      case 0x48: this.winin = value & 0x3f3f; return;
      case 0x4a: this.winout = value & 0x3f3f; return;
      case 0x4c: this.mosaic = value; return;
      case 0x50: this.bldcnt = value & 0x3fff; return;
      case 0x52: this.bldalpha = value & 0x1f1f; return;
      case 0x54: this.bldy = value & 0x1f; return;
    }
  }

  private writeAffine(i: number, reg: number, value: number): void {
    switch (reg) {
      case 0x0: this.bgpa[i] = value; return;
      case 0x2: this.bgpb[i] = value; return;
      case 0x4: this.bgpc[i] = value; return;
      case 0x6: this.bgpd[i] = value; return;
      // 28-bit signed reference points; a write takes effect immediately.
      case 0x8: this.refX[i] = this.bgx[i] = (this.bgx[i] & ~0xffff) | value; return;
      case 0xa: this.refX[i] = this.bgx[i] = ((this.bgx[i] & 0xffff) | (value << 16)) << 4 >> 4; return;
      case 0xc: this.refY[i] = this.bgy[i] = (this.bgy[i] & ~0xffff) | value; return;
      case 0xe: this.refY[i] = this.bgy[i] = ((this.bgy[i] & 0xffff) | (value << 16)) << 4 >> 4; return;
    }
  }

  // ------------------------------------------------------------------
  // Line rendering
  // ------------------------------------------------------------------

  private renderLine(y: number): void {
    const dispcnt = this.dispcnt;
    if (dispcnt & 0x80) {
      // Forced blank shows white.
      this.fb32.fill(this.colorLut[0x7fff], y * SCREEN_W, (y + 1) * SCREEN_W);
    } else {
      const mode = dispcnt & 7;
      let layers = (dispcnt >> 8) & 0x1f;
      switch (mode) {
        case 0:
          for (let bg = 0; bg < 4; bg++) if (layers & (1 << bg)) this.renderTextBg(bg, y);
          break;
        case 1:
          layers &= ~8;
          if (layers & 1) this.renderTextBg(0, y);
          if (layers & 2) this.renderTextBg(1, y);
          if (layers & 4) this.renderAffineBg(2);
          break;
        case 2:
          layers &= ~3;
          if (layers & 4) this.renderAffineBg(2);
          if (layers & 8) this.renderAffineBg(3);
          break;
        case 3: case 4: case 5:
          layers &= ~0xb;
          if (layers & 4) this.renderBitmap(mode);
          break;
        default:
          layers &= 0x10;
      }
      if (layers & 0x10) this.renderSprites(y, mode >= 3);
      this.compose(y, layers);
    }
    for (let i = 0; i < 2; i++) {
      this.refX[i] += this.bgpb[i];
      this.refY[i] += this.bgpd[i];
    }
  }

  private applyMosaic(line: Uint16Array, size: number): void {
    for (let x = 0; x < SCREEN_W; x++) {
      const rem = x % size;
      if (rem) line[x] = line[x - rem];
    }
  }

  private renderTextBg(bg: number, y: number): void {
    const cnt = this.bgcnt[bg];
    const vram = this.vram, pal = this.pal16, out = this.bgLine[bg];
    const charBase = ((cnt >> 2) & 3) * 0x4000;
    const screenBase = ((cnt >> 8) & 0x1f) * 0x800;
    const wide = (cnt & 0x4000) !== 0, tall = (cnt & 0x8000) !== 0;
    const color256 = (cnt & 0x80) !== 0;
    const useMosaic = (cnt & 0x40) !== 0;

    if (useMosaic) y -= y % (((this.mosaic >> 4) & 0xf) + 1);
    const sy = (y + this.bgvofs[bg]) & (tall ? 511 : 255);
    // Screen blocks are 32x32 tiles: [0][1] across, then [2][3] below (or
    // [0]/[1] stacked when only tall).
    const rowBase = screenBase + (sy >= 256 ? (wide ? 0x1000 : 0x800) : 0) + ((sy >> 3) & 31) * 64;
    const tileRow = sy & 7;

    let sx = this.bghofs[bg];
    let x = 0;
    while (x < SCREEN_W) {
      sx &= wide ? 511 : 255;
      const mapOff = rowBase + (sx >= 256 ? 0x800 : 0) + ((sx >> 3) & 31) * 2;
      const entry = vram[mapOff] | (vram[mapOff + 1] << 8);
      const row = entry & 0x800 ? 7 - tileRow : tileRow;
      const hflip = (entry & 0x400) !== 0;
      let col = sx & 7;
      const n = Math.min(8 - col, SCREEN_W - x);
      sx += n;
      if (color256) {
        const addr = charBase + (entry & 0x3ff) * 64 + row * 8;
        for (let i = 0; i < n; i++, col++) {
          const idx = vram[addr + (hflip ? 7 - col : col)];
          out[x++] = idx ? pal[idx] & 0x7fff : TRANSPARENT;
        }
      } else {
        const addr = charBase + (entry & 0x3ff) * 32 + row * 4;
        const bank = (entry >> 8) & 0xf0;
        for (let i = 0; i < n; i++, col++) {
          const c = hflip ? 7 - col : col;
          const idx = (vram[addr + (c >> 1)] >> ((c & 1) * 4)) & 0xf;
          out[x++] = idx ? pal[bank | idx] & 0x7fff : TRANSPARENT;
        }
      }
    }
    if (useMosaic && this.mosaic & 0xf) this.applyMosaic(out, (this.mosaic & 0xf) + 1);
  }

  private renderAffineBg(bg: number): void {
    const cnt = this.bgcnt[bg];
    const vram = this.vram, pal = this.pal16, out = this.bgLine[bg];
    const charBase = ((cnt >> 2) & 3) * 0x4000;
    const screenBase = ((cnt >> 8) & 0x1f) * 0x800;
    const sizeShift = 7 + ((cnt >> 14) & 3); // 128..1024 px
    const size = 1 << sizeShift;
    const wrap = (cnt & 0x2000) !== 0;
    const pa = this.bgpa[bg - 2], pc = this.bgpc[bg - 2];
    let fx = this.refX[bg - 2], fy = this.refY[bg - 2];

    for (let x = 0; x < SCREEN_W; x++, fx += pa, fy += pc) {
      let sx = fx >> 8, sy = fy >> 8;
      if (wrap) { sx &= size - 1; sy &= size - 1; }
      else if ((sx | sy) < 0 || sx >= size || sy >= size) { out[x] = TRANSPARENT; continue; }
      const tile = vram[screenBase + ((sy >> 3) << (sizeShift - 3)) + (sx >> 3)];
      const idx = vram[charBase + tile * 64 + (sy & 7) * 8 + (sx & 7)];
      out[x] = idx ? pal[idx] & 0x7fff : TRANSPARENT;
    }
    if (cnt & 0x40 && this.mosaic & 0xf) this.applyMosaic(out, (this.mosaic & 0xf) + 1);
  }

  /** Modes 3-5: BG2 is a bitmap, still run through the affine transform. */
  private renderBitmap(mode: number): void {
    const vram = this.vram, pal = this.pal16, out = this.bgLine[2];
    const w = mode === 5 ? 160 : 240, h = mode === 5 ? 128 : 160;
    const frame = mode !== 3 && this.dispcnt & 0x10 ? 0xa000 : 0;
    const pa = this.bgpa[0], pc = this.bgpc[0];
    let fx = this.refX[0], fy = this.refY[0];

    for (let x = 0; x < SCREEN_W; x++, fx += pa, fy += pc) {
      const sx = fx >> 8, sy = fy >> 8;
      if ((sx | sy) < 0 || sx >= w || sy >= h) { out[x] = TRANSPARENT; continue; }
      if (mode === 4) {
        const idx = vram[frame + sy * 240 + sx];
        out[x] = idx ? pal[idx] & 0x7fff : TRANSPARENT;
      } else {
        const o = frame + (sy * w + sx) * 2;
        out[x] = (vram[o] | (vram[o + 1] << 8)) & 0x7fff;
      }
    }
    if (this.bgcnt[2] & 0x40 && this.mosaic & 0xf) this.applyMosaic(out, (this.mosaic & 0xf) + 1);
  }

  // ------------------------------------------------------------------
  // Sprites
  // ------------------------------------------------------------------

  private renderSprites(y: number, bitmapMode: boolean): void {
    const oam = this.oam16, vram = this.vram, pal = this.pal16;
    const objLine = this.objLine, objAttr = this.objAttr, objWindow = this.objWindow;
    const mosaicH = ((this.mosaic >> 8) & 0xf) + 1;
    const mosaicV = ((this.mosaic >> 12) & 0xf) + 1;
    objLine.fill(TRANSPARENT);
    objWindow.fill(0);

    // Lowest OAM index wins among equal priorities, so walk forwards and
    // only let a strictly better priority replace an existing pixel.
    for (let n = 0; n < 128; n++) {
      const a0 = oam[n * 4];
      const affine = (a0 & 0x100) !== 0;
      if (!affine && a0 & 0x200) continue; // hidden
      const a1 = oam[n * 4 + 1];
      const [w, h] = OBJ_SIZES[a0 >> 14][a1 >> 14];
      const dbl = affine && (a0 & 0x200) !== 0;
      const boxW = dbl ? w * 2 : w, boxH = dbl ? h * 2 : h;

      let top = a0 & 0xff;
      if (top + boxH > 256) top -= 256;
      let line = y - top;
      if (line < 0 || line >= boxH) continue;
      let left = a1 & 0x1ff;
      if (left >= 240) left -= 512;
      if (left + boxW <= 0) continue;

      const a2 = oam[n * 4 + 2];
      const tileBase = a2 & 0x3ff;
      if (bitmapMode && tileBase < 512) continue; // that VRAM holds the bitmap
      const color256 = (a0 & 0x2000) !== 0;
      const objMode = (a0 >> 10) & 3;
      if (objMode === 3) continue;
      const useMosaic = (a0 & 0x1000) !== 0;
      const attr = ((a2 >> 10) & 3) | (objMode === 1 ? OBJ_SEMI : 0);
      const prio = attr & 3;
      const palBase = color256 ? 256 : 256 + ((a2 >> 12) << 4);
      const charBase = 0x10000 + tileBase * 32;
      const tilesWide = w >> 3;
      if (useMosaic) line = Math.max(0, line - (y % mosaicV));

      let pa = 0x100, pb = 0, pc = 0, pd = 0x100;
      if (affine) {
        const g = ((a1 >> 9) & 0x1f) * 16;
        pa = oam[g + 3] << 16 >> 16; pb = oam[g + 7] << 16 >> 16;
        pc = oam[g + 11] << 16 >> 16; pd = oam[g + 15] << 16 >> 16;
      }
      const hflip = !affine && (a1 & 0x1000) !== 0;
      const vflip = !affine && (a1 & 0x2000) !== 0;
      const dy = line - (boxH >> 1);

      const x0 = Math.max(0, left), x1 = Math.min(SCREEN_W, left + boxW);
      for (let x = x0; x < x1; x++) {
        let col = x - left;
        if (useMosaic) col = Math.max(0, col - (x % mosaicH));
        let tx: number, ty: number;
        if (affine) {
          const dx = col - (boxW >> 1);
          tx = ((pa * dx + pb * dy) >> 8) + (w >> 1);
          ty = ((pc * dx + pd * dy) >> 8) + (h >> 1);
          if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        } else {
          tx = hflip ? w - 1 - col : col;
          ty = vflip ? h - 1 - line : line;
        }
        let idx: number;
        if (color256) {
          const tile = ((ty >> 3) * tilesWide + (tx >> 3)) * 64;
          idx = vram[(charBase + tile + (ty & 7) * 8 + (tx & 7)) & 0x17fff];
        } else {
          const tile = ((ty >> 3) * tilesWide + (tx >> 3)) * 32;
          const b = vram[(charBase + tile + (ty & 7) * 4 + ((tx & 7) >> 1)) & 0x17fff];
          idx = tx & 1 ? b >> 4 : b & 0xf;
        }
        if (!idx) continue;
        if (objMode === 2) { objWindow[x] = 1; continue; }
        if (objLine[x] !== TRANSPARENT && (objAttr[x] & 3) <= prio) continue;
        objLine[x] = pal[palBase + idx] & 0x7fff;
        objAttr[x] = attr;
      }
    }
  }

  // ------------------------------------------------------------------
  // Compositing
  // ------------------------------------------------------------------

  private fillRange(mask: Uint8Array, range: number, value: number): void {
    const x1 = range >> 8, x2 = Math.min(range & 0xff, SCREEN_W);
    // x1 > x2 wraps around the screen edge.
    if (x1 <= x2) mask.fill(value, x1, x2);
    else { mask.fill(value, 0, x2); mask.fill(value, Math.min(x1, SCREEN_W)); }
  }

  private buildWindowMask(y: number): void {
    const mask = this.winMask, dispcnt = this.dispcnt;
    mask.fill(this.winout & 0x3f);
    if (dispcnt & 0x8000) {
      const objMask = this.winout >> 8;
      for (let x = 0; x < SCREEN_W; x++) if (this.objWindow[x]) mask[x] = objMask;
    }
    // Win0 has priority over Win1, so draw it last.
    for (let w = 1; w >= 0; w--) {
      if (!(dispcnt & (0x2000 << w))) continue;
      const top = this.winv[w] >> 8, bottom = this.winv[w] & 0xff;
      const inside = top <= bottom ? y >= top && y < bottom : y >= top || y < bottom;
      if (inside) this.fillRange(mask, this.winh[w], (this.winin >> (w * 8)) & 0x3f);
    }
  }

  private compose(y: number, layers: number): void {
    const windowed = (this.dispcnt & 0xe000) !== 0;
    if (windowed) this.buildWindowMask(y);

    // BGs front to back: by priority, then by index.
    const order = this.layerOrder;
    let count = 0;
    for (let prio = 0; prio < 4; prio++) {
      for (let bg = 0; bg < 4; bg++) {
        if (layers & (1 << bg) && (this.bgcnt[bg] & 3) === prio) order[count++] = bg;
      }
    }

    const bgLine = this.bgLine, bgcnt = this.bgcnt;
    const objLine = this.objLine, objAttr = this.objAttr, winMask = this.winMask;
    const objOn = (layers & 0x10) !== 0;
    const effect = (this.bldcnt >> 6) & 3;
    const target1 = this.bldcnt & 0x3f, target2 = (this.bldcnt >> 8) & 0x3f;
    const eva = Math.min(16, this.bldalpha & 0x1f);
    const evb = Math.min(16, this.bldalpha >> 8);
    const evy = Math.min(16, this.bldy);
    const backdrop = this.pal16[0] & 0x7fff;
    const lut = this.colorLut, fb = this.fb32;
    let p = y * SCREEN_W;

    for (let x = 0; x < SCREEN_W; x++, p++) {
      const mask = windowed ? winMask[x] : 0x3f;

      // Find the two frontmost opaque layers.
      let top = backdrop, topLayer = LAYER_BACKDROP;
      let below = backdrop, belowLayer = LAYER_BACKDROP;
      let found = 0;
      let obj = objOn && mask & 0x10 ? objLine[x] : TRANSPARENT;
      const objPrio = objAttr[x] & 3;
      for (let i = 0; i < count && found < 2; i++) {
        const bg = order[i];
        if (obj !== TRANSPARENT && objPrio <= (bgcnt[bg] & 3)) {
          if (found++ === 0) { top = obj; topLayer = LAYER_OBJ; }
          else { below = obj; belowLayer = LAYER_OBJ; break; }
          obj = TRANSPARENT;
        }
        const c = bgLine[bg][x];
        if (c === TRANSPARENT || !(mask & (1 << bg))) continue;
        if (found++ === 0) { top = c; topLayer = bg; }
        else { below = c; belowLayer = bg; }
      }
      if (obj !== TRANSPARENT && found < 2) {
        if (found === 0) { top = obj; topLayer = LAYER_OBJ; }
        else { below = obj; belowLayer = LAYER_OBJ; }
      }

      let color = top;
      if (mask & 0x20) {
        const topBit = 1 << topLayer;
        // A semi-transparent OBJ alpha-blends whatever BLDCNT's mode says.
        const semi = topLayer === LAYER_OBJ && (objAttr[x] & OBJ_SEMI) !== 0;
        if ((semi || (effect === 1 && target1 & topBit)) && target2 & (1 << belowLayer)) {
          const r = Math.min(31, ((top & 31) * eva + (below & 31) * evb) >> 4);
          const g = Math.min(31, (((top >> 5) & 31) * eva + ((below >> 5) & 31) * evb) >> 4);
          const b = Math.min(31, ((top >> 10) * eva + (below >> 10) * evb) >> 4);
          color = r | (g << 5) | (b << 10);
        } else if (effect === 2 && target1 & topBit) {
          const r = top & 31, g = (top >> 5) & 31, b = top >> 10;
          color = (r + (((31 - r) * evy) >> 4)) | ((g + (((31 - g) * evy) >> 4)) << 5) | ((b + (((31 - b) * evy) >> 4)) << 10);
        } else if (effect === 3 && target1 & topBit) {
          const r = top & 31, g = (top >> 5) & 31, b = top >> 10;
          color = (r - ((r * evy) >> 4)) | ((g - ((g * evy) >> 4)) << 5) | ((b - ((b * evy) >> 4)) << 10);
        }
      }
      fb[p] = lut[color];
    }
  }

  // ------------------------------------------------------------------
  // Save states
  // ------------------------------------------------------------------

  saveState(w: StateWriter): void {
    w.u16(this.dispcnt); w.u16(this.dispstat); w.u16(this.vcount); w.i32(this.cycles);
    w.array(this.bgcnt); w.array(this.bghofs); w.array(this.bgvofs);
    w.array(this.bgpa); w.array(this.bgpb); w.array(this.bgpc); w.array(this.bgpd);
    w.array(this.bgx); w.array(this.bgy); w.array(this.refX); w.array(this.refY);
    w.array(this.winh); w.array(this.winv);
    w.u16(this.winin); w.u16(this.winout); w.u16(this.mosaic);
    w.u16(this.bldcnt); w.u16(this.bldalpha); w.u16(this.bldy);
  }

  loadState(r: StateReader): void {
    this.dispcnt = r.u16(); this.dispstat = r.u16(); this.vcount = r.u16(); this.cycles = r.i32();
    r.arrayInto(this.bgcnt); r.arrayInto(this.bghofs); r.arrayInto(this.bgvofs);
    r.arrayInto(this.bgpa); r.arrayInto(this.bgpb); r.arrayInto(this.bgpc); r.arrayInto(this.bgpd);
    r.arrayInto(this.bgx); r.arrayInto(this.bgy); r.arrayInto(this.refX); r.arrayInto(this.refY);
    r.arrayInto(this.winh); r.arrayInto(this.winv);
    this.winin = r.u16(); this.winout = r.u16(); this.mosaic = r.u16();
    this.bldcnt = r.u16(); this.bldalpha = r.u16(); this.bldy = r.u16();
  }
}
