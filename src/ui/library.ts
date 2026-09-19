// Persistent ROM library, battery saves and save-state slots.
// ROM images live apart from their metadata so listing the library never
// has to pull megabytes of ROM data out of IndexedDB.

import { idbDel, idbGet, idbKeys, idbPut, romKey } from "./idb";

export interface LibraryEntry {
  id: string;
  name: string;
  size: number;
  lastPlayed: number;
}

export interface StateSlot {
  state: Uint8Array;
  shot: string;
  ts: number;
}

/** v1 kept everything in one record. */
interface LegacyRom { name: string; data: Uint8Array; ts: number; }

type ByteRecord = Uint8Array | { data: number[] | Uint8Array };

function toBytes(rec: ByteRecord | undefined): Uint8Array | null {
  if (!rec) return null;
  if (rec instanceof Uint8Array) return rec;
  return rec.data instanceof Uint8Array ? rec.data : Uint8Array.from(rec.data);
}

export async function addRom(data: Uint8Array, name: string): Promise<LibraryEntry> {
  const entry: LibraryEntry = { id: romKey(data), name, size: data.length, lastPlayed: Date.now() };
  await idbPut("roms", entry.id, data);
  await idbPut("library", entry.id, entry);
  return entry;
}

export async function getRom(id: string): Promise<Uint8Array | null> {
  return toBytes(await idbGet<ByteRecord>("roms", id));
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const entries: LibraryEntry[] = [];
  const known = new Set(await idbKeys("library"));
  for (const id of await idbKeys("roms")) {
    if (known.has(id)) continue;
    // Index a ROM stored by the v1 schema.
    const old = await idbGet<LegacyRom>("roms", id);
    if (!old?.data) continue;
    await idbPut("library", id, { id, name: old.name, size: old.data.length, lastPlayed: old.ts });
    known.add(id);
  }
  for (const id of known) {
    const e = await idbGet<LibraryEntry>("library", id);
    if (e) entries.push(e);
  }
  return entries.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

/** Forget a ROM along with its battery save and save states. */
export async function removeRom(id: string, slots: number): Promise<void> {
  await Promise.all([
    idbDel("roms", id), idbDel("library", id), idbDel("saves", id),
    ...Array.from({ length: slots }, (_, i) => idbDel("states", slotKey(id, i))),
  ]);
}

export async function loadBattery(id: string): Promise<Uint8Array | null> {
  return toBytes(await idbGet<ByteRecord>("saves", id));
}

export function storeBattery(id: string, data: Uint8Array): Promise<void> {
  return idbPut("saves", id, data);
}

function slotKey(id: string, slot: number): string {
  return `${id}:s${slot}`;
}

export async function getSlot(id: string, slot: number): Promise<StateSlot | null> {
  const rec = await idbGet<StateSlot>("states", slotKey(id, slot));
  // v1 slots held an ArrayBuffer in a format the core no longer reads.
  return rec && rec.state instanceof Uint8Array ? rec : null;
}

export function putSlot(id: string, slot: number, rec: StateSlot): Promise<void> {
  return idbPut("states", slotKey(id, slot), rec);
}

export function deleteSlot(id: string, slot: number): Promise<void> {
  return idbDel("states", slotKey(id, slot));
}

export async function loadBios(): Promise<Uint8Array | null> {
  return toBytes(await idbGet<ByteRecord>("meta", "bios"));
}

export function storeBios(data: Uint8Array | null): Promise<void> {
  return data ? idbPut("meta", "bios", data) : idbDel("meta", "bios");
}
