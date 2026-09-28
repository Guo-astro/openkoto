import { Hono } from "hono";
import {
  DEFAULT_PULL_LIMIT,
  isRecordType,
  MAX_PUSH_OPS,
  PLAN_LIMITS,
  PROTOCOL_VERSION,
  type PushOp,
  type RecordType,
  type SyncRecord,
} from "@openkoto/core";
import type { AppBindings, Env } from "../env";
import { principalOf, requireAuth } from "../auth/middleware";
import { currentPlan } from "../billing/entitlements";
import { ApiError, badRequest, notFound } from "../lib/http";
import type { UserVault, VaultRecord } from "./vault";

const MAX_PUSH_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;

export type VaultApi = Pick<
  UserVault,
  "pull" | "push" | "stats" | "writeAsServer" | "get" | "list" | "listByField" | "blobKeys" | "purge"
>;

// RPC stubs can't express `unknown` JSON payloads in their types; the methods are async either way.
export function vaultFor(env: Env, userId: string): VaultApi {
  return env.VAULT.get(env.VAULT.idFromName(userId)) as unknown as VaultApi;
}

function checkProtocol(header: string | undefined) {
  if (!header) return;
  const version = Number(header);
  if (Number.isFinite(version) && version < PROTOCOL_VERSION - 1) {
    throw new ApiError(426, "CLIENT_TOO_OLD", "please update the app");
  }
}

function toWire(record: VaultRecord, origin: string): SyncRecord {
  const { blobKey, ...rest } = record;
  return blobKey ? { ...rest, blobUrl: `${origin}/api/v1/sync/blob/${encodeURIComponent(blobKey)}` } : rest;
}

function blobObjectKey(userId: string, blobKey: string): string {
  if (!/^[A-Za-z]+\/[A-Za-z0-9_.:-]+\/[0-9a-f]{64}$/.test(blobKey)) throw badRequest("invalid blob key");
  return `blobs/${userId}/${blobKey}`;
}

export const syncApi = new Hono<AppBindings>()
  .use(requireAuth("sync"))
  .use(async (c, next) => {
    checkProtocol(c.req.header("X-OpenKoto-Protocol"));
    await next();
  })

  .get("/pull", async (c) => {
    const p = principalOf(c);
    const limit = Number(c.req.query("limit") ?? DEFAULT_PULL_LIMIT);
    const typesParam = c.req.query("types");
    const types = typesParam ? typesParam.split(",").filter(Boolean) : undefined;
    if (types?.some((t) => !isRecordType(t))) throw badRequest("unknown type in types");
    try {
      const result = await vaultFor(c.env, p.userId).pull({
        cursor: c.req.query("cursor") ?? null,
        limit: Number.isFinite(limit) ? limit : DEFAULT_PULL_LIMIT,
        types: types as RecordType[] | undefined,
      });
      return c.json({
        records: result.records.map((r) => toWire(r, c.env.APP_ORIGIN)),
        cursor: result.cursor,
        hasMore: result.hasMore,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("CURSOR_EXPIRED")) {
        throw new ApiError(410, "CURSOR_EXPIRED", "cursor expired, full resync required");
      }
      if (err instanceof Error && err.message.startsWith("invalid cursor")) throw badRequest(err.message);
      throw err;
    }
  })

  .post("/push", async (c) => {
    const p = principalOf(c);
    const raw = await c.req.text();
    if (raw.length > MAX_PUSH_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body too large");
    let body: { deviceId?: string; ops?: PushOp[] };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw badRequest("invalid JSON body");
    }
    if (!Array.isArray(body.ops)) throw badRequest("ops must be an array");
    if (body.ops.length > MAX_PUSH_OPS) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `at most ${MAX_PUSH_OPS} ops per request`);
    const deviceId = p.deviceId ?? String(body.deviceId ?? p.via);
    const plan = await currentPlan(c.env, p.userId);
    return c.json(await vaultFor(c.env, p.userId).push(deviceId, body.ops, plan));
  })

  .get("/stats", async (c) => {
    const p = principalOf(c);
    const plan = await currentPlan(c.env, p.userId);
    const stats = await vaultFor(c.env, p.userId).stats(plan);
    const prefix = `books/${p.userId}/`;
    let blobBytes = 0;
    let cursor: string | undefined;
    do {
      const page = await c.env.BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) blobBytes += obj.size;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return c.json({ ...stats, blobBytes, limits: PLAN_LIMITS[plan] });
  })

  .post("/blobs", async (c) => {
    const p = principalOf(c);
    const body = (await c.req.json()) as { type?: string; id?: string; size?: number; sha256?: string };
    if (!body.type || !isRecordType(body.type) || !body.id || !body.sha256 || !/^[0-9a-f]{64}$/.test(body.sha256)) {
      throw badRequest("type, id and sha256 are required");
    }
    if (!body.size || body.size > MAX_BLOB_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "blob too large");
    const blobKey = `${body.type}/${body.id.toLowerCase()}/${body.sha256}`;
    blobObjectKey(p.userId, blobKey);
    return c.json({
      blobKey,
      uploadUrl: `${c.env.APP_ORIGIN}/api/v1/sync/blob/${encodeURIComponent(blobKey)}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  })

  .put("/blob/:key", async (c) => {
    const p = principalOf(c);
    const key = blobObjectKey(p.userId, decodeURIComponent(c.req.param("key")));
    const length = Number(c.req.header("Content-Length") ?? 0);
    if (length > MAX_BLOB_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "blob too large");
    await c.env.BUCKET.put(key, c.req.raw.body, { httpMetadata: { contentType: "application/gzip" } });
    return c.json({ ok: true });
  })

  .get("/blob/:key", async (c) => {
    const p = principalOf(c);
    const obj = await c.env.BUCKET.get(blobObjectKey(p.userId, decodeURIComponent(c.req.param("key"))));
    if (!obj) throw notFound("blob not found");
    return new Response(obj.body, { headers: { "Content-Type": "application/gzip", "Cache-Control": "private, max-age=3600" } });
  });
