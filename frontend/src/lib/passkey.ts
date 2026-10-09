import { api, User } from "./api";

// The server sends WebAuthn options as JSON (base64url for binary fields).
// Convert by hand so this works on browsers without parse*OptionsFromJSON.

const fromB64 = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const toB64 = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Desc = { id: string; type: string; transports?: string[] };

export const passkeysSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window;

export async function addPasskey() {
  const { challenge_id, options } = await api.passkeyRegisterBegin();
  const o = JSON.parse(options);
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: fromB64(o.challenge),
      user: { ...o.user, id: fromB64(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c: Desc) => ({ ...c, id: fromB64(c.id) })),
    },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAttestationResponse;
  await api.passkeyRegisterFinish(challenge_id, {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      attestationObject: toB64(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  });
}

export async function signInWithPasskey(): Promise<User> {
  const { challenge_id, options } = await api.passkeyLoginBegin();
  const o = JSON.parse(options);
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...o,
      challenge: fromB64(o.challenge),
      allowCredentials: (o.allowCredentials ?? []).map((c: Desc) => ({ ...c, id: fromB64(c.id) })),
    },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAssertionResponse;
  return api.passkeyLoginFinish(challenge_id, {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      authenticatorData: toB64(r.authenticatorData),
      signature: toB64(r.signature),
      userHandle: r.userHandle ? toB64(r.userHandle) : null,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  });
}
