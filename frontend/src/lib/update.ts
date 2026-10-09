/**
 * Is a newer build deployed? Every build gets a new hashed bundle name, so compare
 * the one this page runs with the one the server's index.html points at now.
 */
const bundle = (html: string) => html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;

export async function updateAvailable(): Promise<boolean> {
  const mine = bundle(document.documentElement.outerHTML);
  if (!mine) return false; // dev server
  try {
    const res = await fetch("/", { cache: "no-store" });
    const latest = bundle(await res.text());
    return !!latest && latest !== mine;
  } catch {
    return false;
  }
}

const FLAG = "ks-updated";

/** Reload into the latest build; the service worker serves the shell network-first.
 *  `celebrate`: the new build throws confetti when it loads (the "update available" button). */
export async function reloadApp(celebrate = false) {
  if (celebrate) {
    try {
      sessionStorage.setItem(FLAG, "1");
    } catch {
      // private mode etc.: just no confetti
    }
  }
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  await reg?.update().catch(() => {});
  location.reload();
}

/** Called once at startup: confetti if we just reloaded into an update. */
export function celebrateIfUpdated() {
  let updated = false;
  try {
    updated = sessionStorage.getItem(FLAG) === "1";
    sessionStorage.removeItem(FLAG);
  } catch {
    return;
  }
  if (updated) setTimeout(() => import("./confetti").then((m) => m.confetti()), 400);
}
