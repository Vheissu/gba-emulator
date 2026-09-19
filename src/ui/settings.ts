// User preferences, kept in localStorage.

export const BUTTONS = ["A", "B", "Select", "Start", "Right", "Left", "Up", "Down", "R", "L"] as const;
export type Button = (typeof BUTTONS)[number];

/** KEYINPUT bit for each button. */
export const BUTTON_BIT: Record<Button, number> = {
  A: 1, B: 2, Select: 4, Start: 8, Right: 16, Left: 32, Up: 64, Down: 128, R: 256, L: 512,
};

export type KeyBindings = Record<Button, string>; // KeyboardEvent.code

export const DEFAULT_KEYS: KeyBindings = {
  A: "KeyX", B: "KeyZ", Select: "Shift", Start: "Enter",
  Right: "ArrowRight", Left: "ArrowLeft", Up: "ArrowUp", Down: "ArrowDown",
  R: "KeyS", L: "KeyA",
};

export interface Settings {
  volume: number;          // 0..1
  muted: boolean;
  crt: boolean;
  colorCorrection: boolean;
  /** Blend consecutive frames like the slow LCD did; steadies games that
   *  flicker sprites for transparency. */
  ghosting: boolean;
  smoothing: boolean;
  rewind: boolean;
  pauseWhenHidden: boolean;
  keys: KeyBindings;
}

const DEFAULTS: Settings = {
  volume: 0.7,
  muted: false,
  crt: true,
  colorCorrection: false,
  ghosting: false,
  smoothing: false,
  rewind: true,
  pauseWhenHidden: true,
  keys: DEFAULT_KEYS,
};

const STORAGE_KEY = "agb-emu:settings";

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Settings>;
    return { ...DEFAULTS, ...stored, keys: { ...DEFAULT_KEYS, ...stored.keys } };
  } catch {
    return { ...DEFAULTS, keys: { ...DEFAULT_KEYS } };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private browsing: preferences just won't persist.
  }
}

/** KeyboardEvent.code with left/right modifier variants folded together. */
export function normalizeCode(code: string): string {
  return code.replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, "$1");
}

/** Short label for a normalized key code. */
export function keyLabel(code: string): string {
  const arrows: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  if (arrows[code]) return arrows[code];
  if (code === "Enter") return "↵";
  if (code === "Space") return "Space";
  if (code === "Shift") return "⇧";
  return code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
}
