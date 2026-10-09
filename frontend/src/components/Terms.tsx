import { Info, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

/** The small (i) that opens the boring page. */
export function TermsLink({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="terms and privacy" className={`grid h-10 w-10 place-items-center rounded-full text-white/35 active:scale-90 ${className}`}>
        <Info size={22} />
      </button>
      {open && <Terms onClose={() => setOpen(false)} />}
    </>
  );
}

const SECTIONS: [string, string[]][] = [
  [
    "The short version",
    [
      "Kiks is a small app run by whoever runs this server. You use it as it is, at your own risk.",
      "You are responsible for what you send. We are not responsible for what anyone sends, or for what the people you send to do with it.",
    ],
  ],
  [
    "Once you send it, it's out of your hands",
    [
      "Snaps disappear in the app, but the person you send to can still screenshot, screen record or film their screen with another phone. We can't stop that and we can't get it back for you.",
      "Only send things you're OK with the other person keeping.",
    ],
  ],
  [
    "End-to-end encrypted",
    [
      "Snaps and chats are end-to-end encrypted. They're locked on your phone and only unlocked on the phones of the people you send them to. The server only ever holds the locked version and can't see what's in them.",
      "Each of your devices has its own key, and your devices only get your account's key from another of your devices (when you scan the code to add one). Friends see \"key changed\" if your key ever changes, and scanning each other's code in person verifies you.",
      "The server still knows who you send to, when, and whether it's a photo, a video or a chat.",
      "If you report someone, your app sends the snap or texts you picked to the people who run this server, unlocked, so they can look at it. Nothing else is ever unlocked for them.",
    ],
  ],
  [
    "What the server keeps",
    [
      "Snaps are stored only until every recipient has opened them, then the file is deleted. Snaps nobody opens are deleted after 24 hours.",
      "Chat messages are deleted after 24 hours.",
      "We don't keep copies after that.",
      "To make the app work, the server keeps: your username and colour, who your friends are, your groups, who you've blocked, your signed-in devices (name and when last active), the public half of your passkeys and of your encryption keys. Like any web server it can also log IP addresses.",
      "Notifications go through Apple's or Google's push service and only say who sent something, never what.",
      "No ads, no tracking, nothing sold.",
    ],
  ],
  [
    "Deleting",
    [
      "Profile → delete my account removes your account and everything above from the server, and frees your username for someone else.",
    ],
  ],
  [
    "Be decent",
    [
      "Don't send illegal stuff, don't harass people, don't send things to people who don't want them. Block anyone who bothers you.",
      "The server owner can remove accounts that break this.",
    ],
  ],
  [
    "No promises",
    [
      "The app comes with no guarantee. It can go down, lose messages or change at any time.",
      "Using it means you're fine with all of the above.",
    ],
  ],
];

export function Terms({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black text-white" data-nodrag>
      <div className="mx-auto max-w-lg px-6 pb-[max(env(safe-area-inset-bottom),32px)] pt-[max(env(safe-area-inset-top),16px)]">
        <div className="sticky top-0 -mx-6 flex items-center justify-between bg-black/90 px-6 py-3 backdrop-blur">
          <h1 className="text-3xl font-black">the boring stuff</h1>
          <button onClick={onClose} aria-label="close" className="grid h-12 w-12 place-items-center rounded-full bg-white/10 active:scale-90">
            <X size={26} strokeWidth={2.75} />
          </button>
        </div>
        {SECTIONS.map(([title, lines]) => (
          <section key={title} className="mt-6">
            <h2 className="text-lg font-black text-accent">{title}</h2>
            {lines.map((l) => (
              <p key={l} className="mt-2 leading-relaxed text-white/75" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                {l}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>,
    document.body
  );
}
