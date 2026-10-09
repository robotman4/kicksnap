/** Small tactile + visual helpers shared across screens. */

export const buzz = (ms: number | number[] = 8) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};

export const ACCENTS = ["#C6FF3D", "#FFE14D", "#FF5C8A", "#FF8A3D", "#7C5CFF", "#3DD9FF", "#3DFFA8", "#FFFFFF"];

export function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export function applyAccent(hex: string) {
  document.documentElement.style.setProperty("--accent", hexToRgb(hex));
}

/** Text colour that reads on top of a given background. */
export function onColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? "#000" : "#fff";
}

export function ago(ts: number) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// stored under the pre-rename prefix so saved settings survive the rename to Kiks
export const pref = {
  get(key: string, fallback: string) {
    try {
      return localStorage.getItem(`kicksnap.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`kicksnap.${key}`, value);
    } catch {
      /* ignore */
    }
  },
};

export const TIMERS = [3, 5, 10, 0] as const;
export const timerLabel = (s: number) => (s === 0 ? "∞" : `${s}s`);

export type Rect = { x: number; y: number; w: number; h: number };

/** Where object-fit: contain puts media of size nw×nh inside a W×H box. */
export function containRect(nw: number, nh: number, W = window.innerWidth, H = window.innerHeight): Rect {
  if (!nw || !nh) return { x: 0, y: 0, w: W, h: H };
  const s = Math.min(W / nw, H / nh);
  return { x: (W - nw * s) / 2, y: (H - nh * s) / 2, w: nw * s, h: nh * s };
}
