import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { buzz } from "../lib/feel";
import { requestKeys, resetIdentity, useKeys } from "../lib/e2e";
import { Sheet } from "./Sheet";

/**
 * This device's encryption keys. Locked (signed in without the keys, e.g. with a passkey):
 * show a QR for another of your devices to scan, or start fresh keys. Otherwise: your safety code.
 */
export function KeysSheet({ open, me, onClose, toast }: { open: boolean; me: string; onClose: () => void; toast: (t: string) => void }) {
  const keys = useKeys();
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [check, setCheck] = useState("");
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!open || !keys.locked) return;
    let stopped = false;
    setResetting(false);
    const run = async () => {
      while (!stopped) {
        const done = await requestKeys(
          me,
          (text, c, n) => {
            setCode(c);
            setCheck(n);
            QRCode.toDataURL(text, { margin: 1, width: 480, color: { dark: "#000", light: "#0000" } }).then(setQr);
          },
          () => stopped
        ).catch(() => null);
        if (done?.ready) {
          buzz([10, 50, 20]);
          toast("this device is set up 🔑");
          onClose();
          return;
        }
        if (!stopped) await new Promise((ok) => setTimeout(ok, 1000)); // expired: a fresh code
      }
    };
    run();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keys.locked, me]);

  const reset = async () => {
    if (!resetting) return setResetting(true);
    try {
      await resetIdentity(me);
      buzz([10, 50, 20]);
      toast("new keys made 🔑");
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="max-h-[80vh] overflow-y-auto px-6 pb-[max(env(safe-area-inset-bottom),24px)]">
        {keys.locked ? (
          <>
            <h2 className="flex items-center gap-2 text-3xl font-black">
              <KeyRound size={28} /> set up this device
            </h2>
            <p className="mt-1 text-white/60">
              Snaps and chats are end-to-end encrypted. This device doesn't have your keys yet, so it can't open or send them.
            </p>
            <div className="mt-5 flex items-center gap-5 rounded-[2rem] bg-accent p-5 text-black">
              <div className="h-32 w-32 shrink-0">{qr && <img src={qr} alt="key code" className="h-full w-full" />}</div>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-black opacity-60">
                  <Smartphone size={16} /> on your other device
                </p>
                <p className="mt-1 text-lg font-black leading-tight">tap your face, add a device, scan this</p>
                <p className="mt-2 font-mono text-2xl font-black tracking-[0.2em]">{code || "······"}</p>
                {check && <p className="text-sm font-bold opacity-60">check {check}</p>}
              </div>
            </div>
            <button
              onClick={reset}
              className={`mt-6 w-full rounded-full py-4 font-bold active:scale-[.98] ${resetting ? "bg-red-500 text-white" : "bg-white/5 text-white/60"}`}
            >
              {resetting ? "tap again: friends will see your key changed" : "no other device? make new keys"}
            </button>
            {resetting && (
              <p className="mt-2 text-center text-sm text-white/50">Your other signed-in devices will need setting up again from this one.</p>
            )}
          </>
        ) : (
          <>
            <h2 className="flex items-center gap-2 text-3xl font-black">
              <ShieldCheck size={28} /> encrypted
            </h2>
            <p className="mt-1 text-white/60">
              Snaps and chats are end-to-end encrypted. Only the people in the chat can open them, not the server.
            </p>
            <p className="mt-5 text-sm font-black uppercase tracking-wider text-white/40">your safety code</p>
            <p className="mt-1 font-mono text-2xl font-black tracking-wider">{keys.fingerprint ?? "…"}</p>
            <p className="mt-2 text-sm text-white/50">
              Friends who scan your code in person are verified automatically. If a friend's key changes, you'll see it on their chat.
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
