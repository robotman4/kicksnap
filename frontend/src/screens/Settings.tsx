import { Bell, BellOff, Check, Fingerprint, LogOut, QrCode, RefreshCw, Smartphone, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Scanner } from "../components/Scanner";
import { Sheet } from "../components/Sheet";
import { api, Device, User } from "../lib/api";
import { ACCENTS, ago, buzz, onColor, timerLabel, TIMERS } from "../lib/feel";
import { addPasskey, passkeysSupported } from "../lib/passkey";
import { disablePush, enablePush, pushState, PushState } from "../lib/push";
import { reloadApp, updateAvailable } from "../lib/update";

export function Settings({
  open,
  me,
  seconds,
  onClose,
  onColor: setColor,
  onSeconds,
  onLogout,
  toast,
}: {
  open: boolean;
  me: User & { username: string };
  seconds: number;
  onClose: () => void;
  onColor: (c: string) => void;
  onSeconds: (s: number) => void;
  onLogout: () => void;
  toast: (t: string) => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [passkeys, setPasskeys] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [push, setPush] = useState<PushState>("unsupported");
  const [fresh, setFresh] = useState(false);

  const load = () =>
    api
      .devices()
      .then((d) => {
        setDevices(d.devices);
        setPasskeys(d.passkeys);
      })
      .catch(() => {});

  useEffect(() => {
    if (!open) return;
    load();
    pushState().then(setPush);
    updateAvailable().then(setFresh);
  }, [open]);

  const togglePush = async () => {
    buzz(8);
    if (push === "install-first") return toast("tap Share → Add to Home Screen, then open kicksnap from there");
    if (push === "denied") return toast("notifications are blocked in your browser settings");
    if (push === "unsupported") return toast("this browser can't do notifications");
    const next = push === "on" ? await disablePush() : await enablePush().catch(() => "off" as const);
    setPush(next);
    if (next === "on") toast("notifications on 🔔");
  };

  const passkey = async () => {
    try {
      await addPasskey();
      buzz([10, 50, 20]);
      toast("passkey added 🔑");
      load();
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") toast((e as Error).message);
    }
  };

  const approve = async (code: string) => {
    setScanning(false);
    try {
      await api.linkApprove(code.replace(/^kicksnap-link:/i, ""));
      buzz([10, 50, 20]);
      toast("device added ✨");
      setTimeout(load, 2500);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <Sheet open={open} onClose={onClose}>
        <div className="max-h-[80vh] overflow-y-auto px-6 pb-[max(env(safe-area-inset-bottom),24px)]">
          <div className="flex flex-col items-center gap-3 pt-2">
            <Avatar name={me.username} color={me.color} size={96} />
            <p className="text-3xl font-black">@{me.username}</p>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <Tile onClick={togglePush} icon={push === "on" ? <Bell size={30} strokeWidth={2.5} /> : <BellOff size={30} strokeWidth={2.5} />} wide on={push === "on"}>
              {push === "on" ? "notifications on" : push === "install-first" ? "notifications: add to home screen first" : "turn on notifications"}
            </Tile>
            <Tile onClick={() => setScanning(true)} icon={<QrCode size={30} strokeWidth={2.5} />}>
              add a device
            </Tile>
            {passkeysSupported() && (
              <Tile onClick={passkey} icon={<Fingerprint size={30} strokeWidth={2.5} />}>
                {passkeys ? `passkeys · ${passkeys}` : "add a passkey"}
              </Tile>
            )}
          </div>

          <Label>your colour</Label>
          <div className="flex flex-wrap gap-3">
            {ACCENTS.map((c) => (
              <button
                key={c}
                onClick={() => {
                  buzz(6);
                  setColor(c);
                }}
                className="grid h-12 w-12 place-items-center rounded-full transition ease-spring active:scale-90"
                style={{ background: c, color: onColor(c) }}
                aria-label={c}
              >
                {c.toLowerCase() === me.color.toLowerCase() && <Check size={24} strokeWidth={3.5} />}
              </button>
            ))}
          </div>

          <Label>photos show for</Label>
          <div className="flex gap-2">
            {TIMERS.map((t) => (
              <button
                key={t}
                onClick={() => {
                  buzz(5);
                  onSeconds(t);
                }}
                className={`flex-1 rounded-full py-4 text-xl font-black transition ease-spring active:scale-95 ${t === seconds ? "bg-accent text-black" : "bg-white/10"}`}
              >
                {timerLabel(t)}
              </button>
            ))}
          </div>

          <button
            onClick={() => (buzz(8), reloadApp())}
            className={`mt-8 flex w-full items-center justify-center gap-2 rounded-full py-5 text-lg font-bold active:scale-[.98] ${
              fresh ? "bg-accent text-black" : "bg-white/5 text-white/60"
            }`}
          >
            {fresh ? <Sparkles size={22} /> : <RefreshCw size={22} />} {fresh ? "update available" : "refresh app"}
          </button>

          <Label>signed in on</Label>
          {devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 py-2">
              <div className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
                <Smartphone size={22} />
              </div>
              <div className="flex-1">
                <p className="font-bold">
                  {d.label} {d.this && <span className="text-accent">· this one</span>}
                </p>
                <p className="text-sm text-white/40">active {ago(d.seen_at) || "now"}</p>
              </div>
              {!d.this && (
                <button
                  onClick={() => api.removeDevice(d.id).then(load)}
                  className="grid h-11 w-11 place-items-center rounded-full bg-white/5 text-white/60 active:scale-90"
                  aria-label="sign out that device"
                >
                  <X size={20} />
                </button>
              )}
            </div>
          ))}

          <button
            onClick={onLogout}
            className="mt-8 flex w-full items-center justify-center gap-2 rounded-full bg-white/5 py-5 text-lg font-bold text-white/60 active:scale-[.98]"
          >
            <LogOut size={22} /> sign out here
          </button>
        </div>
      </Sheet>
      {scanning && <Scanner hint="scan the code on the new device" onClose={() => setScanning(false)} onCode={approve} />}
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 mt-8 text-sm font-black uppercase tracking-wider text-white/40">{children}</p>;
}

function Tile({ children, icon, onClick, wide, on }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; wide?: boolean; on?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-start gap-3 rounded-[1.75rem] p-5 text-left text-lg font-black leading-tight transition ease-spring active:scale-95 ${
        wide ? "col-span-2 flex-row items-center" : "flex-col"
      } ${on ? "bg-accent text-black" : "bg-white/10 active:bg-white/15"}`}
    >
      <span className={on ? "" : "text-accent"}>{icon}</span>
      {children}
    </button>
  );
}
