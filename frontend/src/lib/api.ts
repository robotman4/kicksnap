export type User = { username: string | null; color: string; admin?: boolean; suspended_until?: number };
/** key: the friend's identity key (E2E, docs/e2e.md), null until their app has made one */
export type Friend = { username: string; color: string; key?: string | null };
export type SnapMeta = { id: string; kind: "photo" | "video"; seconds: number; has_overlay: number; created_at: number; sender: string; e2e?: number };
export type ChatState = "new" | "received" | "delivered" | "opened" | "none";
/** key is "u:<username>" for a friend, "g:<id>" for a group. */
export type Chat = { key: string; name: string; color: string; group: boolean; away?: boolean; state: ChatState; kind: "snap" | "chat"; at: number; snaps: SnapMeta[]; unread: number };
/** body is the encrypted envelope while e2e and not yet opened; e2e.openTexts swaps in the text. */
export type Message = {
  id: number;
  body: string;
  at: number;
  from: string;
  color: string;
  mine: boolean;
  e2e?: boolean;
  key?: string | null;
  /** couldn't be opened here: "nokey" = sent before this device was set up */
  locked?: "nokey" | "bad" | "changed";
  /** what a report needs to prove the sender signed it */
  proof?: { sent_at: number; nonce: string; sig: string };
};
export type DeviceList = { payload: string; sig: string; version: number };
export type KeyBundle = { identity_key: string | null; device_list: DeviceList | null; devices: { id: number; enc_key: string }[] };
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

export type Reason = "spam" | "nudity" | "harassment" | "violence" | "other";
export type AdminReport = {
  id: number;
  reported: string;
  reported_gone: boolean;
  reported_suspended: boolean;
  reporter: string;
  reason: Reason;
  note: string;
  media: string | null;
  media_kind: "photo" | "video" | null;
  /** their texts, copied when reported; group is null for direct texts */
  texts: { body: string; at: number; group: string | null; verified?: boolean | null }[];
  /** E2E snaps: true = the sender's signature checks out, false = it doesn't, null = from before E2E */
  media_verified?: boolean | null;
  overlay?: string | null;
  shots: string[];
  was_friend: boolean;
  friend_reporters: number;
  at: number;
};
export type Suspension =
  | { suspended: false }
  | {
      suspended: true;
      /** 0 = until an admin lifts it */
      until: number;
      reason: string;
      appeal: { body: string; at: number; outcome: "lifted" | "rejected" | null; reply: string } | null;
    };
export type AdminAppeal = { id: number; username: string; body: string; at: number; until: number; reason: string };
export type TheirText = { id: number; body: string; at: number; group: string | null; e2e?: boolean; key?: string | null; to?: string; proof?: Message["proof"] };
export type AdminUser = { username: string; color: string; created_at: number; devices: number; admin: boolean; suspended: boolean; suspended_until: number | null; open_reports: number };
export type Reserved = { name: string; reason: string; by: string; at: number; expires_at: number | null };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Auth is an httpOnly device cookie, so there's no token handling here at all.
// (Native apps send the same secret as a bearer token; the web app never sees it.)
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
  me: () => call<User>("/api/v1/me"),
  startFresh: () => post<User>("/api/v1/devices/new"),
  nameFree: (name: string) => call<{ free: boolean; valid: boolean }>(`/api/v1/names/${encodeURIComponent(name)}`),
  pickName: (username: string) => post<User>("/api/v1/me/name", { username }),
  logout: () => post("/api/v1/auth/logout"),
  setColor: (color: string) => call<User>("/api/v1/me", { method: "PATCH", body: json({ color }) }),

  linkStart: (link_key?: string) => post<{ code: string; secret: string; expires_in: number }>("/api/v1/link/start", { link_key }),
  linkPoll: (code: string, secret: string) =>
    // the poll secret goes in a header, so it stays out of proxy access logs
    call<{ approved: boolean; user?: User; key_blob?: string | null }>(`/api/v1/link/${code}`, { headers: { "X-Kiks-Secret": secret } }),
  linkKey: (code: string) => call<{ link_key: string | null }>(`/api/v1/link/${encodeURIComponent(code)}/key`),
  linkApprove: (code: string, key_blob?: string) => post(`/api/v1/link/${encodeURIComponent(code)}/approve`, { key_blob }),

  keys: {
    me: () => call<KeyBundle & { device_id: number }>("/api/v1/keys/me"),
    identity: (identity_key: string, replace = false) => call("/api/v1/keys/identity", { method: "PUT", body: json({ identity_key, replace }) }),
    device: (enc_key: string) => call("/api/v1/keys/device", { method: "PUT", body: json({ enc_key }) }),
    devices: (payload: string, sig: string) => call("/api/v1/keys/devices", { method: "PUT", body: json({ payload, sig }) }),
    bundles: (users: string[], groups: number[]) =>
      call<{ users: Record<string, KeyBundle> }>(`/api/v1/keys?users=${users.map(encodeURIComponent).join(",")}&groups=${groups.join(",")}`),
    request: (link_key: string) => post<{ code: string; secret: string; expires_in: number }>("/api/v1/keys/requests", { link_key }),
    requestInfo: (code: string) => call<{ link_key: string }>(`/api/v1/keys/requests/${encodeURIComponent(code)}`),
    approve: (code: string, key_blob: string) => post(`/api/v1/keys/requests/${encodeURIComponent(code)}/approve`, { key_blob }),
    poll: (code: string, secret: string) =>
      call<{ key_blob: string | null }>(`/api/v1/keys/requests/${encodeURIComponent(code)}/poll`, { headers: { "X-Kiks-Secret": secret } }),
  },
  devices: () => call<{ devices: Device[]; passkeys: number }>("/api/v1/devices"),
  removeDevice: (id: number) => call(`/api/v1/devices/${id}`, { method: "DELETE" }),

  passkeyRegisterBegin: () => post<{ challenge_id: string; options: string }>("/api/v1/passkeys/register/begin"),
  passkeyRegisterFinish: (challenge_id: string, credential: unknown) =>
    post("/api/v1/passkeys/register/finish", { challenge_id, credential }),
  passkeyLoginBegin: () => post<{ challenge_id: string; options: string }>("/api/v1/passkeys/login/begin"),
  passkeyLoginFinish: (challenge_id: string, credential: unknown) =>
    post<User>("/api/v1/passkeys/login/finish", { challenge_id, credential }),

  pushKey: () => call<{ key: string }>("/api/v1/push/key"),
  pushSubscribe: (sub: PushSubscriptionJSON) => post("/api/v1/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => post("/api/v1/push/unsubscribe", { endpoint }),

  friends: () => call<FriendLists>("/api/v1/friends"),
  addFriend: (username: string) => post<{ username: string; status: "friends" | "requested" }>("/api/v1/friends", { username }),
  removeFriend: (username: string) => call(`/api/v1/friends/${encodeURIComponent(username)}`, { method: "DELETE" }),
  blocks: () => call<Friend[]>("/api/v1/blocks"),
  block: (username: string) => post("/api/v1/blocks", { username }),
  unblock: (username: string) => call(`/api/v1/blocks/${encodeURIComponent(username)}`, { method: "DELETE" }),
  deleteAccount: (username: string) => call("/api/v1/me", { method: "DELETE", body: json({ username }) }),
  chats: () => call<Chat[]>("/api/v1/chats"),
  suspension: () => call<Suspension>("/api/v1/appeal"),
  appeal: (body: string) => post("/api/v1/appeal", { body }),
  reportTexts: (username: string) => call<TheirText[]>(`/api/v1/reports/texts/${encodeURIComponent(username)}`),
  report: (
    username: string,
    reason: Reason,
    note: string,
    block: boolean,
    proof: { snap?: Blob | null; snapOverlay?: Blob | null; snapProof?: object | null; texts?: TheirText[]; shots?: File[] } = {}
  ) => {
    const form = new FormData();
    form.append("username", username);
    form.append("reason", reason);
    form.append("note", note);
    form.append("block", String(block));
    const { snap, snapOverlay, snapProof, texts = [], shots = [] } = proof;
    if (snap) form.append("file", snap, snap.type.startsWith("video") ? "snap.webm" : "snap.jpg");
    if (snap && snapProof) form.append("snap_proof", JSON.stringify(snapProof));
    if (snap && snapOverlay) form.append("overlay", snapOverlay, "overlay.png");
    texts.forEach((t) => form.append("message_ids", String(t.id)));
    // E2E texts: what this device decrypted, plus the sender's signature for the server to check
    const proofs = texts.filter((t) => t.e2e && t.proof).map((t) => ({ id: t.id, body: t.body, ...t.proof }));
    if (proofs.length) form.append("text_proofs", JSON.stringify(proofs));
    shots.forEach((f) => form.append("shots", f, f.name || "screenshot.jpg"));
    return call("/api/v1/reports", { method: "POST", body: form });
  },

  admin: {
    reports: () => call<AdminReport[]>("/api/v1/admin/reports"),
    appeals: () => call<AdminAppeal[]>("/api/v1/admin/appeals"),
    decide: (id: number, lift: boolean, reply: string) => post(`/api/v1/admin/appeals/${id}`, { lift, reply }),
    dismiss: (id: number) => post(`/api/v1/admin/reports/${id}/dismiss`),
    suspend: (name: string, days: number | null) => post(`/api/v1/admin/users/${encodeURIComponent(name)}/suspend`, { days }),
    unsuspend: (name: string) => post(`/api/v1/admin/users/${encodeURIComponent(name)}/unsuspend`),
    remove: (name: string, reserve: boolean) => post(`/api/v1/admin/users/${encodeURIComponent(name)}/delete`, { reserve }),
    users: (q: string) => call<AdminUser[]>(`/api/v1/admin/users?q=${encodeURIComponent(q)}`),
    reserved: () => call<Reserved[]>("/api/v1/admin/reserved"),
    reserve: (name: string, reason: string) => post("/api/v1/admin/reserved", { name, reason }),
    release: (name: string) => call(`/api/v1/admin/reserved/${encodeURIComponent(name)}`, { method: "DELETE" }),
    log: () => call<{ admin: string; action: string; target: string; detail: string; at: number }[]>("/api/v1/admin/log"),
  },
  /** An encrypted snap from e2e.sealSnap. `to` holds chat keys: friends and groups in one list. */
  send: (s: { file: Blob; overlay: Blob | null; envelope: string; keys: object; kind: string }, to: string[], seconds: number) => {
    const form = new FormData();
    form.append("file", s.file, "snap");
    if (s.overlay) form.append("overlay", s.overlay, "overlay");
    form.append("to", to.filter((k) => k.startsWith("u:")).map((k) => k.slice(2)).join(","));
    form.append("groups", to.filter((k) => k.startsWith("g:")).map((k) => k.slice(2)).join(","));
    form.append("seconds", String(seconds));
    form.append("kind", s.kind);
    form.append("envelope", s.envelope);
    form.append("keys", JSON.stringify(s.keys));
    return call<{ sent_to: string[] }>("/api/v1/snaps", { method: "POST", body: form });
  },
  snapKey: (id: string) =>
    call<{ e2e: boolean; envelope: string | null; key: string | null; sender: string; to: string }>(`/api/v1/snaps/${id}/key`),
  media: (id: string) => call<Blob>(`/api/v1/snaps/${id}/media`),
  overlay: (id: string) => call<Blob>(`/api/v1/snaps/${id}/overlay`),
  open: (id: string) => post(`/api/v1/snaps/${id}/open`),

  messages: (key: string) => call<{ messages: Message[]; seen_at: number }>(`/api/v1/chats/${encodeURIComponent(key)}/messages`),
  say: (key: string, sealed: { body: string; keys: Record<string, string> }) => post(`/api/v1/chats/${encodeURIComponent(key)}/messages`, sealed),
  read: (key: string) => post(`/api/v1/chats/${encodeURIComponent(key)}/read`),

  newGroup: (name: string, members: string[]) => post<Group>("/api/v1/groups", { name, members }),
  group: (id: number) => call<Group>(`/api/v1/groups/${id}`),
  updateGroup: (id: number, patch: { name?: string; invite_mode?: InviteMode; admin?: string }) =>
    call<Group>(`/api/v1/groups/${id}`, { method: "PATCH", body: json(patch) }),
  invite: (id: number, usernames: string[]) => post<Group>(`/api/v1/groups/${id}/members`, { usernames }),
  joinGroup: (code: string) => post<Group>("/api/v1/groups/join", { code }),
  removeMember: (id: number, username: string) => call(`/api/v1/groups/${id}/members/${encodeURIComponent(username)}`, { method: "DELETE" }),
  closeGroup: (id: number) => call(`/api/v1/groups/${id}`, { method: "DELETE" }),
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
  | { type: "group"; closed?: string }
  | { type: "reports" }
  | { type: "keys"; user: string };

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
    ws = new WebSocket(`${proto}://${location.host}/api/v1/ws`);
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
