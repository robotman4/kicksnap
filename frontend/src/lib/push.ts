import { api } from "./api";

export type PushState = "on" | "off" | "denied" | "install-first" | "unsupported";

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

const urlB64ToBytes = (s: string) => {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function registration() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.getRegistration().then((r) => r ?? navigator.serviceWorker.register("/sw.js"));
}

export async function pushState(): Promise<PushState> {
  // iOS only allows web push for apps added to the home screen
  if (isIOS() && !standalone()) return "install-first";
  if (!("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Must be called from a tap (iOS requires a user gesture for the permission prompt). */
export async function enablePush(): Promise<PushState> {
  const state = await pushState();
  if (state !== "off" && state !== "on") return state;
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const reg = await registration();
  if (!reg) return "unsupported";
  await navigator.serviceWorker.ready;
  const { key } = await api.pushKey();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) }));
  await api.pushSubscribe(sub.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

/** Re-send an existing subscription, e.g. after the server was reset. */
export async function syncPush() {
  const reg = await registration().catch(() => null);
  const sub = await reg?.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") await api.pushSubscribe(sub.toJSON()).catch(() => {});
}
