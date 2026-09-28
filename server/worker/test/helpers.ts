import { SELF } from "cloudflare:test";
import { vi } from "vitest";

export const ORIGIN = "http://localhost:8787";

export function url(path: string): string {
  return `${ORIGIN}${path}`;
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON (status ${res.status}): ${text.slice(0, 300)}`);
  }
}

/** Signs in through the email OTP flow and returns the session cookie. */
export async function signInWithEmail(email: string): Promise<string> {
  const log = vi.spyOn(console, "log");
  const send = await SELF.fetch(url("/api/auth/email-otp/send-verification-otp"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  if (!send.ok) throw new Error(`send otp failed: ${send.status} ${await send.text()}`);
  const printed = log.mock.calls.map((args) => args.join(" ")).find((line) => line.includes(`to=${email}`));
  log.mockRestore();
  const otp = /(\d{6})/.exec(printed?.split("\n").slice(1).join("\n") ?? "")?.[1];
  if (!otp) throw new Error("otp not captured");

  const signIn = await SELF.fetch(url("/api/auth/sign-in/email-otp"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, otp }),
  });
  if (!signIn.ok) throw new Error(`sign in failed: ${signIn.status} ${await signIn.text()}`);
  const cookies = signIn.headers.getSetCookie().map((c) => c.split(";")[0]);
  return cookies.join("; ");
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  user: { id: string; email: string; plan: string };
}

/** Full native login: email OTP → /auth/native/authorize → token exchange. */
export async function nativeLogin(email: string, platform = "ios"): Promise<Tokens> {
  const cookie = await signInWithEmail(email);
  const { verifier, challenge } = await pkce();
  const redirectUri = "openkoto://auth/callback";
  const authorize = await SELF.fetch(
    url(`/auth/native/authorize?client_id=ios&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`),
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  // The authorize endpoint only forwards to the consent page; approving there issues the code.
  const consent = authorize.headers.get("Location") ?? "";
  if (!consent.startsWith("/authorize-app?")) throw new Error(`expected consent redirect: ${authorize.status} ${consent}`);
  const params = Object.fromEntries(new URLSearchParams(consent.slice("/authorize-app?".length)));
  const approved = await SELF.fetch(url("/api/v1/auth/native/approve"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify(params),
  });
  const location = (await json<{ redirect: string }>(approved)).redirect;
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in redirect: ${approved.status} ${location}`);
  const res = await SELF.fetch(url("/api/v1/auth/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, device: { platform, name: "Test" } }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return json<Tokens>(res);
}

export function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(url(path), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-OpenKoto-Protocol": "1", ...(init.headers ?? {}) },
  });
}

let hlcCounter = 0;
export function hlc(wall = Date.now(), node = "a1b2c3d4"): string {
  hlcCounter = (hlcCounter + 1) % 10000;
  return `${String(wall).padStart(13, "0")}-${String(hlcCounter).padStart(4, "0")}-${node}`;
}
