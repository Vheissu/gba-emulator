// GBA PPU: 240x160, 6 video modes, text + affine backgrounds, sprites,
// windows, alpha blending / fade, mosaic.
//
// Scanline timing: 1232 cycles/line (240px draw + 68px hblank),
// 228 lines/frame (160 visible + 68 vblank) = 280896 cycles/frame.

import { BusDevice } from "./bus";

const HDRAW_CYCLES = 960;
const LINE_CYCLES = 1232;
const VISIBLE_LINES = 160;
const TOTAL_LINES = 228;

const SIZE_TEXT = [ // [h][w] in tiles
  [32, 32], [64, 32], [32, 64], [64, 64],
];
const SIZE_OBJ = [ // [shape][size] -> [w,h] px
  [[8, 8], [16, 16], [32, 32], [64, 64]],
  [[16, 8], [32, 8], [32, 16], [64, 32]],
  [[8, 16], [8, 32], [16, 32], [32, 64]],
];

export class PPU implements BusDevice {
  vram!: Uint8Array;
  pal!: Uint8Array;
  oam!: Uint8Array;

  framebuffer = new Uint8Array(240 * 160 * 4);

  // IO register mirrors
  dispcnt = 0x80;
  dispstat = 0;
  vcount = 0;
  bgcnt = new Uint16Array(4);
  bghofs = new Uint16Array(4);
  bgvofs = new Uint16Array(4);
  bgpa = new Int16Array(2);
  bgpb = new Int16Array(2);
  bgpc = new Int16Array(2);
  bgpd = new Int16Array(2);
  bgx = new Int32Array(2); // written values
  bgy = new Int32Array(2);
  // internal affine reference points (latched per line)
  private refX = new Int32Array(2);
  private refY = new Int32Array(2);
  private refLineX = new Int32Array(2);
  private refLineY = new Int32Array(2);

  win0h = 0; win1h = 0; win0v = 0; win1v = 0;
  winin = 0; winout = 0;
  mosaic = 0;
  bldcnt = 0;
  bldalpha = 0;
  bldy = 0;

  private cycles = 0;

  // Per-line scratch buffers. bg line: palette color index (0 = transparent
  // for blending purposes handled via color==backdrop check).
  private bgLine = new Uint16Array(4 * 240); // packed: (layer<<14) not needed; store color idx
  private bgHas = new Uint8Array(4 * 240);
  private objColor = new Uint16Array(240);   // 15-bit color
  private objPrio = new Uint8Array(240);
  private objSemi = new Uint8Array(240);
  private objWin = new Uint8Array(240);
  private objHas = new Uint8Array(240);

  onVBlank: () => void = () => {};
  onHBlank: () => void = () => {};
  requestIrq: (bit: number) => void = () => {};

  private vcountSetting = 0;

  reset(): void {
    this.dispcnt = 0x80;
    this.dispstat = 0;
    this.vcount = 0;
    this.cycles = 0;
    this.bgcnt.fill(0);
    this.bghofs.fill(0);
    this.bgvofs.fill(0);
    this.bgx.fill(0);
    this.bgy.fill(0);
    this.refX.fill(0);
    this.refY.fill(0);
  }

  // ------------------------------------------------------------------
  // Timing
  // ------------------------------------------------------------------

  advance(elapsed: number): void {
    this.cycles += elapsed;
    if (this.cycles >= LINE_CYCLES) {
      this.cycles -= LINE_CYCLES;
      this.endScanline();
    }
    // HBlank flag rises at the hdraw boundary.
    if (this.cycles >= HDRAW_CYCLES && !(this.dispstat & 2)) {
      this.dispstat |= 2;
      if (this.dispstat & 0x10) this.requestIrq(1);
      this.onHBlank();
      if (this.vcount < VISIBLE_LINES) this.renderLine(this.vcount);
    }
  }

  private endScanline(): void {
    this.dispstat &= ~2;
    this.vcount++;
    if (this.vcount >= TOTAL_LINES) {
      this.vcount = 0;
      // Latch affine refs for new frame
      this.refX[0] = this.bgx[0];
      this.refY[0] = this.bgy[0];
      this.refX[1] = this.bgx[1];
      this.refY[1] = this.bgy[1];
    }
    if (this.vcount === VISIBLE_LINES) {
      this.dispstat |= 1;
      if (this.dispstat & 8) this.requestIrq(0);
      this.onVBlank();
    } else if (this.vcount < VISIBLE_LINES) {
      this.dispstat &= ~1;
    }
    if (this.vcount === 227) this.dispstat &= ~1;
    // VCOUNT match
    if (this.vcount === this.vcountSetting) {
      this.dispstat |= 4;
      if (this.dispstat & 0x20) this.requestIrq(2);
    } else {
      this.dispstat &= ~4;
    }
  }

  // ------------------------------------------------------------------
  // IO
  // ------------------------------------------------------------------

  ioRead(off: number): number {
    switch (off) {
      case 0x00: return this.dispcnt;
      case 0x04: return this.dispstat;
      case 0x06: return this.vcount;
      case 0x08: case 0x0a: case 0x0c: case 0x0e:
        return this.bgcnt[(off - 0x08) >> 1];
      case 0x48: return this.winin;
      case 0x4a: return this.winout;
      case 0x50: return this.bldcnt;
      case 0x52: return this.bldalpha;
      case 0x54: return -1; // write-only
    }
    return -1;
  }

  ioWrite(off: number, value: number): void {
    switch (off) {
      case 0x00: this.dispcnt = value; return;
      case 0x04:
        // Only irq-enable bits + vcount setting are writable.
        this.dispstat = (this.dispstat & 7) | (value & 0xff38);
        this.vcountSetting = (value >>> 8) & 0xff;
        return;
      case 0x08: case 0x0a: case 0x0c: case 0x0e:
        this.bgcnt[(off - 0x08) >> 1] = value;
        return;
      case 0x10: case 0x14: case 0x18: case 0x1c:
        this.bghofs[(off - 0x10) >> 2] = value & 0x1ff;
        return;
      case 0x12: case 0x16: case 0x1a: case 0x1e:
        this.bgvofs[(off - 0x12) >> 2] = value & 0x1ff;
        return;
      case 0x20: this.bgpa[0] = value; return;
      case 0x22: this.bgpb[0] = value; return;
      case 0x24: this.bgpc[0] = value; return;
      case 0x26: this.bgpd[0] = value; return;
      case 0x28:
        this.bgx[0] = (this.bgx[0] & ~0xffff) | value;
        this.refX[0] = this.affineLatch(this.bgx[0]);
        return;
      case 0x2a:
        this.bgx[0] = (this.bgx[0] & 0xffff) | ((value & 0x0fff) << 16);
        this.bgx[0] = (this.bgx[0] << 4) >> 4; // sign-extend 28-bit
        this.refX[0] = this.affineLatch(this.bgx[0]);
        return;
      case 0x2c:
        this.bgy[0] = (this.bgy[0] & ~0xffff) | value;
        this.refY[0] = this.affineLatch(this.bgy[0]);
        return;
      case 0x2e:
        this.bgy[0] = (this.bgy[0] & 0xffff) | ((value & 0x0fff) << 16);
        this.bgy[0] = (this.bgy[0] << 4) >> 4;
        this.refY[0] = this.affineLatch(this.bgy[0]);
        return;
      case 0x30: this.bgpa[1] = value; return;
      case 0x32: this.bgpb[1] = value; return;
      case 0x34: this.bgpc[1] = value; return;
      case 0x36: this.bgpd[1] = value; return;
      case 0x38:
        this.bgx[1] = (this.bgx[1] & ~0xffff) | value;
        this.refX[1] = this.affineLatch(this.bgx[1]);
        return;
      case 0x3a:
        this.bgx[1] = (this.bgx[1] & 0xffff) | ((value & 0x0fff) << 16);
        this.bgx[1] = (this.bgx[1] << 4) >> 4;
        this.refX[1] = this.affineLatch(this.bgx[1]);
        return;
      case 0x3c:
        this.bgy[1] = (this.bgy[1] & ~0xffff) | value;
        this.refY[1] = this.affineLatch(this.bgy[1]);
        return;
      case 0x3e:
        this.bgy[1] = (this.bgy[1] & 0xffff) | ((value & 0x0fff) << 16);
        this.bgy[1] = (this.bgy[1] << 4) >> 4;
        this.refY[1] = this.affineLatch(this.bgy[1]);
        return;
      case 0x40: this.win0h = value; return;
      case 0x42: this.win1h = value; return;
      case 0x44: this.win0v = value; return;
      case 0x46: this.win1v = value; return;
      case 0x48: this.winin = value; return;
      case 0x4a: this.winout = value; return;
      case 0x4c: this.mosaic = value; return;
      case 0x50: this.bldcnt = value; return;
      case 0x52: this.bldalpha = value & 0x1f1f; return;
      case 0x54: this.bldy = value & 0x1f; return;
    }
  }

  private affineLatch(v: number): number {
    return v;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private renderLine(y: number): void {
    const mode = this.dispcnt & 7;
    const fb = this.framebuffer;
    const rowBase = y * 240 * 4;

    if (this.dispcnt & 0x80) {
      // Forced blank: white line.
      for (let x = 0; x < 240; x++) {
        const p = rowBase + x * 4;
        fb[p] = 0xf8; fb[p + 1] = 0xf8; fb[p + 2] = 0xf8; fb[p + 3] = 0xff;
      }
      return;
    }

    // Step affine refs at start of each visible line after line 0.
    if (y > 0) {
      this.refX[0] += this.bgpb[0];
      this.refY[0] += this.bgpd[0];
      this.refX[1] += this.bgpb[1];
      this.refY[1] += this.bgpd[1];
    }
    this.refLineX[0] = this.refX[0];
    this.refLineY[0] = this.refY[0];
    this.refLineX[1] = this.refX[1];
    this.refLineY[1] = this.refY[1];

    this.bgHas.fill(0);
    this.objHas.fill(0);
    this.objWin.fill(0);

    switch (mode) {
      case 0:
        this.renderTextBG(0, y);
        this.renderTextBG(1, y);
        this.renderTextBG(2, y);
        this.renderTextBG(3, y);
        break;
      case 1:
        this.renderTextBG(0, y);
        this.renderTextBG(1, y);
        this.renderAffineBG(0, y, 2);
        break;
      case 2:
        this.renderAffineBG(0, y, 2);
        this.renderAffineBG(1, y, 3);
        break;
      case 3:
        this.renderBitmap3(y);
        break;
      case 4:
        this.renderBitmap4(y);
        break;
      case 5:
        this.renderBitmap5(y);
        break;
      default:
        break;
    }

    if (this.dispcnt & 0x1000) this.renderSprites(y);

    this.compose(y);
  }

  private palColor(index: number): number {
    const o = index * 2;
    return this.pal[o] | (this.pal[o + 1] << 8);
  }

  private renderTextBG(bg: number, y: number): void {
    if (!(this.dispcnt & (0x100 << bg))) return;
    const cnt = this.bgcnt[bg];
    const color256 = (cnt & 0x80) !== 0;
    const charBase = ((cnt >>> 2) & 3) * 0x4000;
    const screenBase = ((cnt >>> 8) & 0x1f) * 0x800;
    const [tw, th] = SIZE_TEXT[(cnt >>> 14) & 3];
    const px = tw * 8, py = th * 8;
    const hofs = this.bghofs[bg];
    const vofs = this.bgvofs[bg];
    const mosH = (this.cnt6(bg) ? (this.mosaic & 0xf) : -1) + 1;
    const out = this.bgLine.subarray(bg * 240, bg * 240 + 240);
    const has = this.bgHas.subarray(bg * 240, bg * 240 + 240);

    let mosCounter = 0;
    let mosIndex = 0;
    for (let x = 0; x < 240; x++) {
      if (mosCounter === 0) {
        const sx = (x + hofs) & (px - 1);
        const sy = (y + vofs) & (py - 1);
        const tileX = sx >> 3, tileY = sy >> 3;
        // Screen block layout: blocks are 32x32 tiles, laid out row-major
        // per dimension beyond 32.
        const blockX = tileX >> 5, blockY = tileY >> 5;
        let block: number;
        if (tw === 64) block = blockX + blockY * 2;
        else block = blockX + blockY * (th === 64 ? 2 : 1) * 0; // 32x64: single col
        if (tw === 32 && th === 64) block = blockY;
        else if (tw === 64 && th === 32) block = blockX;
        else if (tw === 64 && th === 64) block = blockX + blockY * 2;
        else block = 0;
        const mapOff = screenBase + block * 0x800 + (tileY & 31) * 64 + (tileX & 31) * 2;
        const entry = this.vram[mapOff] | (this.vram[mapOff + 1] << 8);
        const tile = entry & 0x3ff;
        const hflip = (entry & 0x400) !== 0;
        const vflip = (entry & 0x800) !== 0;
        const palBank = (entry >>> 12) & 0xf;
        let fx = sx & 7, fy = sy & 7;
        if (hflip) fx = 7 - fx;
        if (vflip) fy = 7 - fy;
        if (color256) {
          const tileAddr = charBase + tile * 64 + fy * 8 + fx;
          mosIndex = this.vram[tileAddr] & 0xff;
        } else {
          const tileAddr = charBase + tile * 32 + fy * 4 + (fx >> 1);
          const b = this.vram[tileAddr];
          const nib = (fx & 1) ? (b >>> 4) : (b & 0xf);
          mosIndex = nib ? palBank * 16 + nib : 0;
        }
      }
      out[x] = mosIndex;
      has[x] = mosIndex !== 0 ? 1 : 0;
      if (++mosCounter >= mosH) mosCounter = 0;
    }
  }

  private cnt6(bg: number): boolean {
    return (this.bgcnt[bg] & 0x40) !== 0;
  }

  private renderAffineBG(af: number, y: number, bg: number): void {
    if (!(this.dispcnt & (0x100 << bg))) return;
    const cnt = this.bgcnt[bg];
    const charBase = ((cnt >>> 2) & 3) * 0x4000;
    const screenBase = ((cnt >>> 8) & 0x1f) * 0x800;
    const sizeTiles = 16 << ((cnt >>> 14) & 3); // 128/256/512/1024 px
    const wrap = (cnt & 0x2000) !== 0;
    const pa = this.bgpa[af], pc = this.bgpc[af];
    let lx = this.refLineX[af], ly = this.refLineY[af];
    const out = this.bgLine.subarray(bg * 240, bg * 240 + 240);
    const has = this.bgHas.subarray(bg * 240, bg * 240 + 240);
    const px = sizeTiles; // width in pixels (128/256/512/1024)

    for (let x = 0; x < 240; x++) {
      let sx = lx >> 8;
      let sy = ly >> 8;
      lx += pa;
      ly += pc;
      if (wrap) {
        sx &= px - 1;
        sy &= px - 1;
      } else if (sx < 0 || sx >= px || sy < 0 || sy >= px) {
        out[x] = 0; has[x] = 0;
        continue;
      }
      const tileX = sx >> 3, tileY = sy >> 3;
      const mapOff = screenBase + (tileY * (px >> 3) + tileX);
      const tile = this.vram[mapOff];
      const tileAddr = charBase + tile * 64 + (sy & 7) * 8 + (sx & 7);
      const idx = this.vram[tileAddr] & 0xff;
      out[x] = idx;
      has[x] = idx !== 0 ? 1 : 0;
    }
  }

  private renderBitmap3(y: number): void {
    if (!(this.dispcnt & 0x400)) return;
    // 240x160 15-bit colors at vram[0]; uses affine transform of BG2.
    const pa = this.bgpa[0], pc = this.bgpc[0];
    let lx = this.refLineX[0], ly = this.refLineY[0];
    const out = this.bgLine.subarray(2 * 240, 2 * 240 + 240);
    const has = this.bgHas.subarray(2 * 240, 2 * 240 + 240);
    for (let x = 0; x < 240; x++) {
      const sx = lx >> 8, sy = ly >> 8;
      lx += pa; ly += pc;
      if (sx < 0 || sx >= 240 || sy < 0 || sy >= 160) { out[x] = 0; has[x] = 0; continue; }
      const o = (sy * 240 + sx) * 2;
      const c = this.vram[o] | (this.vram[o + 1] << 8);
      out[x] = 0x8000 | c; // mark direct color
      has[x] = 1;
    }
  }

  private renderBitmap4(y: number): void {
    if (!(this.dispcnt & 0x400)) return;
    const frame = (this.dispcnt & 0x10) ? 0xa000 : 0;
    const pa = this.bgpa[0], pc = this.bgpc[0];
    let lx = this.refLineX[0], ly = this.refLineY[0];
    const out = this.bgLine.subarray(2 * 240, 2 * 240 + 240);
    const has = this.bgHas.subarray(2 * 240, 2 * 240 + 240);
    for (let x = 0; x < 240; x++) {
      const sx = lx >> 8, sy = ly >> 8;
      lx += pa; ly += pc;
      if (sx < 0 || sx >= 240 || sy < 0 || sy >= 160) { out[x] = 0; has[x] = 0; continue; }
      const idx = this.vram[frame + sy * 240 + sx] & 0xff;
      out[x] = idx;
      has[x] = idx !== 0 ? 1 : 0;
    }
  }

  private renderBitmap5(y: number): void {
    if (!(this.dispcnt & 0x400)) return;
    const frame = (this.dispcnt & 0x10) ? 0xa000 : 0;
    const pa = this.bgpa[0], pc = this.bgpc[0];
    let lx = this.refLineX[0], ly = this.refLineY[0];
    const out = this.bgLine.subarray(2 * 240, 2 * 240 + 240);
    const has = this.bgHas.subarray(2 * 240, 2 * 240 + 240);
    for (let x = 0; x < 240; x++) {
      const sx = lx >> 8, sy = ly >> 8;
      lx += pa; ly += pc;
      if (sx < 0 || sx >= 160 || sy < 0 || sy >= 128) { out[x] = 0; has[x] = 0; continue; }
      const o = frame + (sy * 160 + sx) * 2;
      const c = this.vram[o] | (this.vram[o + 1] << 8);
      out[x] = 0x8000 | c;
      has[x] = 1;
    }
  }

  // ------------------------------------------------------------------
  // Sprites
  // ------------------------------------------------------------------

  private renderSprites(y: number): void {
    const map1D = (this.dispcnt & 0x40) !== 0;
    const oam = this.oam;
    const objColor = this.objColor, objPrio = this.objPrio;
    const objSemi = this.objSemi, objWin = this.objWin, objHas = this.objHas;
    const mosaicObjH = ((this.mosaic >>> 8) & 0xf) + 1;
    const mosaicObjV = ((this.mosaic >>> 12) & 0xf) + 1;
    void mosaicObjV;

    // Affine parameter table lives in OAM at entries 0x20..: 4 params * 4
    // slots each 4 bytes? Actually: 32 groups of 4 halfwords starting at
    // byte offsets 0x06 + group*0x20.
    // Forward order + "reject when existing prio <= new" means the lowest
    // OAM index wins ties, matching hardware.
    for (let n = 0; n < 128; n++) {
      const base = n * 8;
      const a0 = oam[base] | (oam[base + 1] << 8);
      const a1 = oam[base + 2] | (oam[base + 3] << 8);
      const a2 = oam[base + 4] | (oam[base + 5] << 8);

      const objMode = (a0 >>> 8) & 3;
      const gfxMode = (a0 >>> 10) & 3;
      if (gfxMode === 3) continue; // disabled

      let sy = a0 & 0xff;
      if (sy >= 160) sy -= 256;
      const shape = (a0 >>> 14) & 3;
      const size = (a1 >>> 14) & 3;
      const [w0, h0] = SIZE_OBJ[shape][size];
      const dbl = gfxMode === 2 ? 1 : 0;
      const w = w0 << dbl, h = h0 << dbl;
      if (y < sy || y >= sy + h) continue;

      const isAffine = gfxMode === 1 || gfxMode === 2;
      const color256 = (a0 >>> 13) & 1;
      const mosaic = (a0 >>> 12) & 1;
      const prio = (a2 >>> 10) & 3;
      let sx = a1 & 0x1ff;
      if (sx >= 256) sx -= 512;

      // sprite row within the (possibly doubled) box
      const line = y - sy;

      if (isAffine) {
        const group = ((a1 >>> 9) & 0x1f) * 32;
        const pa = (oam[group + 6] | (oam[group + 7] << 8)) << 16 >> 16;
        const pb = (oam[group + 14] | (oam[group + 15] << 8)) << 16 >> 16;
        const pc = (oam[group + 22] | (oam[group + 23] << 8)) << 16 >> 16;
        const pd = (oam[group + 30] | (oam[group + 31] << 8)) << 16 >> 16;
        const cx = w0 / 2, cy = h0 / 2;
        const bx = w / 2;
        const iy = line - (h >> 1);
        for (let x = 0; x < 240; x++) {
          const ix = x - sx - bx;
          let tx = ((pa * ix + pb * iy) >> 8) + cx;
          let ty = ((pc * ix + pd * iy) >> 8) + cy;
          if (tx < 0 || tx >= w0 || ty < 0 || ty >= h0) continue;
          this.plotSpritePixel(x, n, tx, ty, w0, a2, color256, map1D,
            objMode, prio, mosaic, objColor, objPrio, objSemi, objWin, objHas);
        }
      } else {
        const hflip = (a1 & 0x1000) !== 0;
        const vflip = (a1 & 0x2000) !== 0;
        const ty = vflip ? h0 - 1 - line : line;
        for (let px = 0; px < w0; px++) {
          const x = sx + px;
          if (x < 0 || x >= 240) continue;
          const tx = hflip ? w0 - 1 - px : px;
          this.plotSpritePixel(x, n, tx, ty, w0, a2, color256, map1D,
            objMode, prio, mosaic, objColor, objPrio, objSemi, objWin, objHas);
        }
      }
      void mosaicObjH;
    }
  }

  private plotSpritePixel(
    x: number, n: number, tx: number, ty: number, w0: number,
    a2: number, color256: number, map1D: boolean,
    objMode: number, prio: number, mosaic: number,
    objColor: Uint16Array, objPrio: Uint8Array,
    objSemi: Uint8Array, objWin: Uint8Array, objHas: Uint8Array,
  ): void {
    void n;
    void mosaic;
    const tileBase = a2 & 0x3ff;
    const tileX = tx >> 3, tileY = ty >> 3;
    let tileAddr: number;
    if (map1D) {
      const strideTiles = w0 >> 3;
      const t = tileBase * (color256 ? 2 : 1);
      tileAddr = 0x10000 + (t + tileY * strideTiles + tileX) * 32;
    } else {
      // 2D: 32-tile-wide grid; 8bpp tiles occupy 2 cells.
      const t = color256 ? (tileBase & ~1) * 2 : tileBase;
      tileAddr = 0x10000 + t * 32 + tileX * (color256 ? 64 : 32) + tileY * (color256 ? 2048 : 1024);
    }
    let idx: number;
    if (color256) {
      idx = this.vram[tileAddr + (ty & 7) * 8 + (tx & 7)] & 0xff;
    } else {
      const b = this.vram[tileAddr + (ty & 7) * 4 + ((tx & 7) >> 1)];
      idx = (tx & 1) ? (b >>> 4) : (b & 0xf);
    }
    if (idx === 0) return;

    if (objMode === 2) {
      // OBJ window: writes to window mask only.
      objWin[x] = 1;
      return;
    }

    const palIdx = color256 ? 256 + idx : 256 + ((a2 >>> 12) & 0xf) * 16 + idx;
    if (objHas[x] && objPrio[x] <= prio) return;
    objHas[x] = 1;
    objPrio[x] = prio;
    objColor[x] = palIdx;
    objSemi[x] = objMode === 1 ? 1 : 0;
  }

  // ------------------------------------------------------------------
  // Compositing
  // ------------------------------------------------------------------

  private compose(y: number): void {
    const dispcnt = this.dispcnt;
    const mode = dispcnt & 7;
    const winEnabled = (dispcnt & 0xe000) !== 0;

    // Which BG layers exist in this mode:
    // mode0: 0,1,2,3; mode1: 0,1,2(aff); mode2: 2,3(aff); 3/4/5: 2(bitmap)
    const layerPrio = [this.bgcnt[0] & 3, this.bgcnt[1] & 3, this.bgcnt[2] & 3, this.bgcnt[3] & 3];
    const bgEnabled = [
      (dispcnt & 0x100) !== 0 && (mode === 0 || mode === 1),
      (dispcnt & 0x200) !== 0 && (mode === 0 || mode === 1),
      (dispcnt & 0x400) !== 0 && mode <= 5,
      (dispcnt & 0x800) !== 0 && (mode === 0 || mode === 2),
    ];
    const objOn = (dispcnt & 0x1000) !== 0;

    const win0 = (dispcnt & 0x2000) !== 0;
    const win1 = (dispcnt & 0x4000) !== 0;
    const winObj = (dispcnt & 0x8000) !== 0;
    const w0l = (this.win0h >>> 8) & 0xff, w0r = this.win0h & 0xff;
    const w1l = (this.win1h >>> 8) & 0xff, w1r = this.win1h & 0xff;
    const w0t = (this.win0v >>> 8) & 0xff, w0b = this.win0v & 0xff;
    const w1t = (this.win1v >>> 8) & 0xff, w1b = this.win1v & 0xff;
    const inWin0V = this.inRange(y, w0t, w0b);
    const inWin1V = this.inRange(y, w1t, w1b);

    const effect = (this.bldcnt >>> 6) & 3;
    const t1 = this.bldcnt & 0x3f;
    const t2 = (this.bldcnt >>> 8) & 0x3f;
    const eva = Math.min(16, this.bldalpha & 0x1f);
    const evb = Math.min(16, (this.bldalpha >>> 8) & 0x1f);
    const evy = Math.min(16, this.bldy & 0x1f);

    const fb = this.framebuffer;
    const backdrop = this.palColor(0);

    for (let x = 0; x < 240; x++) {
      // Window mask: 6 bits, bit per layer (BG0-3, OBJ, effect)
      let mask = 0x3f;
      if (winEnabled) {
        mask = this.winout & 0x3f;
        let effMask = (this.winout >>> 8) & 1;
        if (winObj && this.objWin[x]) { mask = (this.winout >>> 8) & 0x3f; effMask = this.winout >>> 13 & 1; }
        if (win1 && inWin1V && this.inRange(x, w1l, w1r)) { mask = (this.winin >>> 8) & 0x3f; effMask = (this.winin >>> 13) & 1; }
        if (win0 && inWin0V && this.inRange(x, w0l, w0r)) { mask = this.winin & 0x3f; effMask = (this.winin >>> 5) & 1; }
        mask |= effMask << 6;
      }

      // Collect top two opaque layers by priority. Evaluated in hardware
      // tie-break order (OBJ first, then BG0..BG3) with strict <, so an
      // earlier layer wins equal priorities.
      let topColor = -1, topLayer = -1, topPrio = 99;
      let sndColor = -1, sndLayer = -1, sndPrio = 99;

      const consider = (color: number, layer: number, prio: number) => {
        if (prio < topPrio) {
          sndColor = topColor; sndLayer = topLayer; sndPrio = topPrio;
          topColor = color; topLayer = layer; topPrio = prio;
        } else if (prio < sndPrio) {
          sndColor = color; sndLayer = layer; sndPrio = prio;
        }
      };

      if (objOn && this.objHas[x] && (mask & 0x10)) {
        consider(this.objColor[x], 4, this.objPrio[x]);
      }
      for (let l = 0; l < 4; l++) {
        if (!bgEnabled[l] || !(mask & (1 << l))) continue;
        if (!this.bgHas[l * 240 + x]) continue;
        consider(this.bgLine[l * 240 + x], l, layerPrio[l]);
      }

      let color: number;
      if (topColor === -1) {
        color = backdrop;
        topLayer = 5;
      } else {
        color = topColor & 0x8000 ? topColor & 0x7fff : this.palColor(topColor);
      }

      // Blending
      const semi = topLayer === 4 && this.objSemi[x];
      if (effect !== 0 && (mask & 0x20 || !winEnabled)) {
        if (effect === 1 && (semi || (t1 & (1 << topLayer)))) {
          // Alpha blend: top is target1 (or semi OBJ), bottom target2.
          if (sndColor !== -1 && sndLayer >= 0 && (t2 & (1 << sndLayer))) {
            const cA = color;
            const cB = sndColor & 0x8000 ? sndColor & 0x7fff : this.palColor(sndColor);
            const rA = cA & 31, gA = (cA >>> 5) & 31, bA = (cA >>> 10) & 31;
            const rB = cB & 31, gB = (cB >>> 5) & 31, bB = (cB >>> 10) & 31;
            const r = Math.min(31, (rA * eva + rB * evb) >> 4);
            const g = Math.min(31, (gA * eva + gB * evb) >> 4);
            const b = Math.min(31, (bA * eva + bB * evb) >> 4);
            color = r | (g << 5) | (b << 10);
          } else if (semi) {
            // Semi-transparent sprite with nothing blendable below: normal.
          }
        } else if (effect === 2 && (t1 & (1 << topLayer))) {
          const r = Math.min(31, (color & 31) + ((31 - (color & 31)) * evy >> 4));
          const g = Math.min(31, ((color >>> 5) & 31) + ((31 - ((color >>> 5) & 31)) * evy >> 4));
          const b = Math.min(31, ((color >>> 10) & 31) + ((31 - ((color >>> 10) & 31)) * evy >> 4));
          color = r | (g << 5) | (b << 10);
        } else if (effect === 3 && (t1 & (1 << topLayer))) {
          const r = (color & 31) - ((color & 31) * evy >> 4);
          const g = ((color >>> 5) & 31) - (((color >>> 5) & 31) * evy >> 4);
          const b = ((color >>> 10) & 31) - (((color >>> 10) & 31) * evy >> 4);
          color = r | (g << 5) | (b << 10);
        }
      }

      const p = (y * 240 + x) * 4;
      const r8 = (color & 31) << 3;
      const g8 = ((color >>> 5) & 31) << 3;
      const b8 = ((color >>> 10) & 31) << 3;
      fb[p] = r8 | (r8 >>> 5);
      fb[p + 1] = g8 | (g8 >>> 5);
      fb[p + 2] = b8 | (b8 >>> 5);
      fb[p + 3] = 0xff;
    }
  }

  private inRange(v: number, a: number, b: number): boolean {
    // Window ranges wrap (a > b means "all except inside").
    if (a <= b) return v >= a && v < b;
    return v >= a || v < b;
  }
}
