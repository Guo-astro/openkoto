import { exportJWK, importJWK, importPKCS8, jwtVerify, SignJWT, type JWK, type KeyObject } from "jose";
import type { Plan } from "@openkoto/core";
import type { Env } from "../env";
import { newId, randomBase62, randomToken, sha256Hex } from "../lib/crypto";
import { badRequest, unauthenticated } from "../lib/http";
import { currentPlan } from "../billing/entitlements";

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const AUDIENCE = "openkoto-api";
export const FIRST_PARTY_SCOPES = ["sync", "vocab:read", "vocab:write", "library:read", "library:write", "ai:use", "account"];
export const API_KEY_SCOPES = ["sync", "vocab:read", "vocab:write", "library:read", "library:write", "ai:use"];

type SigningKey = CryptoKey | KeyObject;

interface KeyMaterial {
  privateKey: SigningKey;
  publicKey: SigningKey | Uint8Array;
  publicJwk: JWK;
}

const keyCache = new Map<string, Promise<KeyMaterial>>();

async function loadKeys(pem: string): Promise<KeyMaterial> {
  const privateKey = await importPKCS8(pem, "EdDSA", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const { d: _d, ...publicJwk } = jwk;
  const kid = (await sha256Hex(`${publicJwk.x}`)).slice(0, 16);
  const publicKey = await importJWK({ ...publicJwk, alg: "EdDSA" }, "EdDSA");
  return { privateKey, publicKey, publicJwk: { ...publicJwk, kid, alg: "EdDSA", use: "sig" } };
}

function keys(env: Env): Promise<KeyMaterial> {
  if (!env.JWT_PRIVATE_KEY) throw new Error("JWT_PRIVATE_KEY is not configured");
  let material = keyCache.get(env.JWT_PRIVATE_KEY);
  if (!material) {
    material = loadKeys(env.JWT_PRIVATE_KEY);
    keyCache.set(env.JWT_PRIVATE_KEY, material);
  }
  return material;
}

export async function jwks(env: Env): Promise<{ keys: JWK[] }> {
  return { keys: [(await keys(env)).publicJwk] };
}

export interface AccessClaims {
  sub: string;
  did: string;
  scp: string[];
  plan: Plan;
  email: string;
}

export async function signAccessToken(env: Env, claims: AccessClaims): Promise<string> {
  const { privateKey, publicJwk } = await keys(env);
  return new SignJWT({ did: claims.did, scp: claims.scp, plan: claims.plan, email: claims.email })
    .setProtectedHeader({ alg: "EdDSA", kid: publicJwk.kid })
    .setIssuer(env.APP_ORIGIN)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_S}s`)
    .sign(privateKey);
}

export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims> {
  const { publicKey } = await keys(env);
  try {
    const { payload } = await jwtVerify(token, publicKey, { issuer: env.APP_ORIGIN, audience: AUDIENCE, algorithms: ["EdDSA"] });
    return {
      sub: String(payload.sub),
      did: String(payload.did),
      scp: Array.isArray(payload.scp) ? (payload.scp as string[]) : [],
      plan: (payload.plan as Plan) ?? "free",
      email: String(payload.email ?? ""),
    };
  } catch (err) {
    const expired = err instanceof Error && "code" in err && (err as { code?: string }).code === "ERR_JWT_EXPIRED";
    throw unauthenticated(expired ? "access token expired" : "invalid access token", expired ? "TOKEN_EXPIRED" : "UNAUTHENTICATED");
  }
}

export interface DeviceInfo {
  platform: string;
  name: string;
  appVersion?: string;
}

const PLATFORMS = new Set(["ios", "macos", "windows", "linux", "web", "cli", "android", "mcp", "other"]);

export function parseDeviceInfo(input: unknown): DeviceInfo {
  const obj = (input ?? {}) as Record<string, unknown>;
  const platform = String(obj.platform ?? "other").toLowerCase();
  return {
    platform: PLATFORMS.has(platform) ? platform : "other",
    name: String(obj.name ?? platform).slice(0, 80) || platform,
    appVersion: obj.appVersion ? String(obj.appVersion).slice(0, 40) : undefined,
  };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  deviceId: string;
  user: { id: string; email: string; name: string; plan: Plan };
}

async function userRow(env: Env, userId: string) {
  const user = await env.DB.prepare('select id, email, name from "user" where id = ?').bind(userId).first<{ id: string; email: string; name: string }>();
  if (!user) throw unauthenticated("user not found");
  return user;
}

async function issueRefreshToken(env: Env, userId: string, deviceId: string, familyId: string, now: number): Promise<string> {
  const token = `okr_${randomToken(32)}`;
  await env.DB.prepare(
    "insert into refresh_tokens (id, user_id, device_id, family_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), userId, deviceId, familyId, await sha256Hex(token), now + REFRESH_TOKEN_TTL_MS, now)
    .run();
  return token;
}

async function tokenResponse(env: Env, userId: string, deviceId: string, refreshToken: string): Promise<TokenResponse> {
  const user = await userRow(env, userId);
  const plan = await currentPlan(env, userId);
  const accessToken = await signAccessToken(env, { sub: userId, did: deviceId, scp: FIRST_PARTY_SCOPES, plan, email: user.email });
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_S,
    deviceId,
    user: { id: user.id, email: user.email, name: user.name, plan },
  };
}

/** Registers a device for the user and issues its first token pair. */
export async function issueForNewDevice(env: Env, userId: string, device: DeviceInfo): Promise<TokenResponse> {
  const now = Date.now();
  const deviceId = newId();
  await env.DB.prepare(
    "insert into devices (id, user_id, platform, name, app_version, created_at, last_seen_at) values (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(deviceId, userId, device.platform, device.name, device.appVersion ?? null, now, now)
    .run();
  const refreshToken = await issueRefreshToken(env, userId, deviceId, newId(), now);
  return tokenResponse(env, userId, deviceId, refreshToken);
}

interface RefreshRow {
  id: string;
  user_id: string;
  device_id: string;
  family_id: string;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export async function rotateRefreshToken(env: Env, presented: string): Promise<TokenResponse> {
  if (!presented?.startsWith("okr_")) throw badRequest("invalid refresh token", "invalid_grant");
  const now = Date.now();
  const row = await env.DB.prepare(
    "select r.id, r.user_id, r.device_id, r.family_id, r.expires_at, r.rotated_at, d.revoked_at from refresh_tokens r join devices d on d.id = r.device_id where r.token_hash = ?",
  )
    .bind(await sha256Hex(presented))
    .first<RefreshRow>();
  if (!row || row.revoked_at) throw unauthenticated("refresh token revoked", "invalid_grant");
  if (row.rotated_at) {
    // Reuse of a rotated token: assume theft and revoke the whole family.
    await revokeDevice(env, row.user_id, row.device_id);
    throw unauthenticated("refresh token reuse detected", "invalid_grant");
  }
  if (row.expires_at < now) throw unauthenticated("refresh token expired", "invalid_grant");

  const claimed = await env.DB.prepare("update refresh_tokens set rotated_at = ? where id = ? and rotated_at is null")
    .bind(now, row.id)
    .run();
  if (!claimed.meta.changes) throw unauthenticated("refresh token already used", "invalid_grant");

  await env.DB.prepare("update devices set last_seen_at = ? where id = ?").bind(now, row.device_id).run();
  const refreshToken = await issueRefreshToken(env, row.user_id, row.device_id, row.family_id, now);
  return tokenResponse(env, row.user_id, row.device_id, refreshToken);
}

export async function revokeDevice(env: Env, userId: string, deviceId: string): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare("update devices set revoked_at = ? where id = ? and user_id = ? and revoked_at is null").bind(now, deviceId, userId),
    env.DB.prepare("delete from refresh_tokens where device_id = ? and user_id = ?").bind(deviceId, userId),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0;
}

export async function revokeByRefreshToken(env: Env, presented: string): Promise<void> {
  const row = await env.DB.prepare("select user_id, device_id from refresh_tokens where token_hash = ?")
    .bind(await sha256Hex(presented))
    .first<{ user_id: string; device_id: string }>();
  if (row) await revokeDevice(env, row.user_id, row.device_id);
}

export async function isDeviceActive(env: Env, deviceId: string): Promise<boolean> {
  const row = await env.DB.prepare("select revoked_at from devices where id = ?").bind(deviceId).first<{ revoked_at: number | null }>();
  return !!row && !row.revoked_at;
}

// ---- API keys -----------------------------------------------------------

export interface CreatedApiKey {
  id: string;
  key: string;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: number | null;
}

export async function createApiKey(env: Env, userId: string, name: string, scopes: string[], expiresAt: number | null): Promise<CreatedApiKey> {
  const invalid = scopes.filter((s) => !API_KEY_SCOPES.includes(s));
  if (invalid.length) throw badRequest(`unknown scopes: ${invalid.join(", ")}`);
  if (!scopes.length) throw badRequest("at least one scope is required");
  const key = `ok_live_${randomBase62(32)}`;
  const id = newId();
  const prefix = key.slice(0, 12);
  await env.DB.prepare(
    "insert into api_keys (id, user_id, name, prefix, key_hash, scopes, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, name.slice(0, 80), prefix, await sha256Hex(key), JSON.stringify(scopes), Date.now(), expiresAt)
    .run();
  return { id, key, prefix, name, scopes, expiresAt };
}

export async function resolveApiKey(env: Env, key: string) {
  const row = await env.DB.prepare(
    'select k.id, k.user_id, k.scopes, k.expires_at, k.revoked_at, u.email from api_keys k join "user" u on u.id = k.user_id where k.key_hash = ?',
  )
    .bind(await sha256Hex(key))
    .first<{ id: string; user_id: string; scopes: string; expires_at: number | null; revoked_at: number | null; email: string }>();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < Date.now())) return null;
  // Best-effort usage timestamp; failures must not block the request.
  env.DB.prepare("update api_keys set last_used_at = ? where id = ?").bind(Date.now(), row.id).run().catch(() => {});
  return { keyId: row.id, userId: row.user_id, email: row.email, scopes: JSON.parse(row.scopes) as string[] };
}
