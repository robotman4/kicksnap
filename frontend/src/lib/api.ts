export type User = { username: string | null; color: string };
export type Friend = { username: string; color: string };
export type SnapMeta = { id: string; kind: "photo" | "video"; seconds: number; has_overlay: number; created_at: number; sender: string };
export type ChatState = "new" | "received" | "delivered" | "opened" | "none";
/** key is "u:<username>" for a friend, "g:<id>" for a group. */
export type Chat = { key: string; name: string; color: string; group: boolean; state: ChatState; kind: "snap" | "chat"; at: number; snaps: SnapMeta[]; unread: number };
export type Message = { id: number; body: string; at: number; from: string; color: string; mine: boolean };
export type InviteMode = "open" | "members" | "admin";
export type Group = {
  id: number;
  key: string;
  name: string;
  color: string;
  invite_mode: InviteMode;
  admin: boolean;
  can_invite: boolean;
  code: string | null;
  members: (Friend & { admin: boolean })[];
};
export type FriendLists = { friends: Friend[]; incoming: Friend[]; outgoing: Friend[] };
export type Device = { id: number; label: string; created_at: number; seen_at: number; this: boolean };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Auth is an httpOnly device cookie, so there's no token handling here at all.
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => res.statusText);
    throw new ApiError(res.status, typeof detail === "string" ? detail : "something broke");
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : (res.blob() as Promise<T>);
}

const json = (body: unknown) => JSON.stringify(body);
const post = <T>(path: string, body?: unknown) => call<T>(path, { method: "POST", body: body === undefined ? undefined : json(body) });

export const api = {
  me: () => call<User>("/api/me"),
  startFresh: () => post<User>("/api/devices/new"),
  nameFree: (name: string) => call<{ free: boolean; valid: boolean }>(`/api/names/${encodeURIComponent(name)}`),
  pickName: (username: string) => post<User>("/api/me/name", { username }),
  logout: () => post("/api/auth/logout"),
  setColor: (color: string) => call<User>("/api/me", { method: "PATCH", body: json({ color }) }),

  linkStart: () => post<{ code: string; secret: string; expires_in: number }>("/api/link/start"),
  linkPoll: (code: string, secret: string) =>
    call<{ approved: boolean; user?: User }>(`/api/link/${code}?secret=${encodeURIComponent(secret)}`),
  linkApprove: (code: string) => post(`/api/link/${encodeURIComponent(code)}/approve`),
  devices: () => call<{ devices: Device[]; passkeys: number }>("/api/devices"),
  removeDevice: (id: number) => call(`/api/devices/${id}`, { method: "DELETE" }),

  passkeyRegisterBegin: () => post<{ challenge_id: string; options: string }>("/api/passkeys/register/begin"),
  passkeyRegisterFinish: (challenge_id: string, credential: unknown) =>
    post("/api/passkeys/register/finish", { challenge_id, credential }),
  passkeyLoginBegin: () => post<{ challenge_id: string; options: string }>("/api/passkeys/login/begin"),
  passkeyLoginFinish: (challenge_id: string, credential: unknown) =>
    post<User>("/api/passkeys/login/finish", { challenge_id, credential }),

  pushKey: () => call<{ key: string }>("/api/push/key"),
  pushSubscribe: (sub: PushSubscriptionJSON) => post("/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => post("/api/push/unsubscribe", { endpoint }),

  friends: () => call<FriendLists>("/api/friends"),
  addFriend: (username: string) => post<{ username: string; status: "friends" | "requested" }>("/api/friends", { username }),
  chats: () => call<Chat[]>("/api/chats"),
  /** `to` holds chat keys: friends and groups in one list. */
  send: (blob: Blob, overlay: Blob | null, to: string[], seconds: number) => {
    const form = new FormData();
    form.append("file", blob, blob.type.startsWith("video") ? "snap.webm" : "snap.jpg");
    if (overlay) form.append("overlay", overlay, "overlay.png");
    form.append("to", to.filter((k) => k.startsWith("u:")).map((k) => k.slice(2)).join(","));
    form.append("groups", to.filter((k) => k.startsWith("g:")).map((k) => k.slice(2)).join(","));
    form.append("seconds", String(seconds));
    return call<{ sent_to: string[] }>("/api/snaps", { method: "POST", body: form });
  },
  media: (id: string) => call<Blob>(`/api/snaps/${id}/media`),
  overlay: (id: string) => call<Blob>(`/api/snaps/${id}/overlay`),
  open: (id: string) => post(`/api/snaps/${id}/open`),

  messages: (key: string) => call<{ messages: Message[]; seen_at: number }>(`/api/chats/${encodeURIComponent(key)}/messages`),
  say: (key: string, body: string) => post(`/api/chats/${encodeURIComponent(key)}/messages`, { body }),
  read: (key: string) => post(`/api/chats/${encodeURIComponent(key)}/read`),

  newGroup: (name: string, members: string[]) => post<Group>("/api/groups", { name, members }),
  group: (id: number) => call<Group>(`/api/groups/${id}`),
  updateGroup: (id: number, patch: { name?: string; invite_mode?: InviteMode; admin?: string }) =>
    call<Group>(`/api/groups/${id}`, { method: "PATCH", body: json(patch) }),
  invite: (id: number, usernames: string[]) => post<Group>(`/api/groups/${id}/members`, { usernames }),
  joinGroup: (code: string) => post<Group>("/api/groups/join", { code }),
  removeMember: (id: number, username: string) => call(`/api/groups/${id}/members/${encodeURIComponent(username)}`, { method: "DELETE" }),
  closeGroup: (id: number) => call(`/api/groups/${id}`, { method: "DELETE" }),
};

/** Characters as people count them: one emoji is one. */
export const MAX_CHARS = 160;
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export const charCount = (s: string) => (segmenter ? [...segmenter.segment(s)].length : [...s].length);
export const clip = (s: string, max = MAX_CHARS) =>
  segmenter ? [...segmenter.segment(s)].slice(0, max).map((g) => g.segment).join("") : [...s].slice(0, max).join("");

export type LiveEvent =
  | { type: "snap"; from: string }
  | { type: "opened"; by: string }
  | { type: "friends" }
  | { type: "message"; chat: string }
  | { type: "read"; chat: string }
  | { type: "group"; closed?: string };

/** WebSocket with dumb exponential reconnect. The cookie authenticates it. */
export function live(onConnect: () => void, onEvent: (e: LiveEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let ping: number | undefined;
  let retry = 1000;
  let reconnects = 0;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      // anything that happened while we were disconnected
      if (retry > 1000 || reconnects++) onConnect();
      retry = 1000;
      ping = window.setInterval(() => ws?.send("ping"), 25000);
    };
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => {
      clearInterval(ping);
      if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
    };
  };
  connect();
  return () => {
    closed = true;
    clearInterval(ping);
    ws?.close();
  };
}
