// Just enough ZIP to pull a ROM out of an archive, using the browser's
// built-in inflate.

const ROM_EXT = /\.(gba|agb|bin)$/i;
const MAX_SIZE = 32 * 1024 * 1024; // largest GBA cartridge

export function isZip(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** Extract the first GBA ROM in the archive, or null if there isn't one. */
export async function extractRom(zip: Uint8Array): Promise<{ name: string; data: Uint8Array } | null> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // End-of-central-directory record: scan backwards past any comment.
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;

  let pos = view.getUint32(eocd + 16, true);
  for (let n = view.getUint16(eocd + 10, true); n > 0; n--) {
    if (view.getUint32(pos, true) !== 0x02014b50) return null;
    const method = view.getUint16(pos + 10, true);
    const packedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(zip.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
    if (!ROM_EXT.test(name) || size > MAX_SIZE) continue;

    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = zip.subarray(dataStart, dataStart + packedSize);
    const base = name.split("/").pop()!;
    if (method === 0) return { name: base, data: packed.slice() };
    if (method !== 8) return null;
    const stream = new Blob([packed.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return { name: base, data: new Uint8Array(await new Response(stream).arrayBuffer()) };
  }
  return null;
}
