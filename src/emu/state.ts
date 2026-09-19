// Binary serialization helpers for save states. Each component writes its
// fields in a fixed order and reads them back the same way; the format is
// guarded by a single version number in gba.ts.

export class StateWriter {
  private buf = new Uint8Array(1 << 19);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.reserve(1); this.buf[this.pos++] = v; }
  bool(v: boolean): void { this.u8(v ? 1 : 0); }
  u16(v: number): void { this.reserve(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v: number): void { this.reserve(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v: number): void { this.reserve(4); this.view.setInt32(this.pos, v | 0, true); this.pos += 4; }
  f64(v: number): void { this.reserve(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }

  /** Fixed-size blob: the reader must know the length. */
  bytes(a: Uint8Array): void {
    this.reserve(a.length);
    this.buf.set(a, this.pos);
    this.pos += a.length;
  }

  /** Any typed array, written as its raw bytes. */
  array(a: ArrayBufferView): void {
    this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }

  /** Length-prefixed blob. */
  blob(a: Uint8Array): void { this.u32(a.length); this.bytes(a); }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class StateReader {
  private view: DataView;
  private pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError("save state truncated");
  }

  u8(): number { this.need(1); return this.buf[this.pos++]; }
  bool(): boolean { return this.u8() !== 0; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  bytesInto(target: Uint8Array): void {
    this.need(target.length);
    target.set(this.buf.subarray(this.pos, this.pos + target.length));
    this.pos += target.length;
  }

  arrayInto(target: ArrayBufferView): void {
    this.bytesInto(new Uint8Array(target.buffer, target.byteOffset, target.byteLength));
  }

  blob(): Uint8Array {
    const n = this.u32();
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}
