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

/** Reload into the latest build; the service worker serves the shell network-first. */
export async function reloadApp() {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  await reg?.update().catch(() => {});
  location.reload();
}
