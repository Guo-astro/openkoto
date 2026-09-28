import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createGuard, createServer, type LibraryApi } from "../src/server";

function library() {
  return { listBooks: vi.fn(async () => ({ items: [{ id: "b1", title: "Novel" }], total: 1 })) } as unknown as LibraryApi & { listBooks: ReturnType<typeof vi.fn> };
}

async function connect(lib: LibraryApi, guard?: () => Promise<void>) {
  const server = createServer(lib, { guard });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}

describe("stdio server", () => {
  it("exposes the shared tool set", async () => {
    const { tools } = await (await connect(library())).listTools();
    expect(tools.length).toBeGreaterThanOrEqual(13);
    expect(tools.map((t) => t.name)).toContain("create_word_pack_from_text");
  });
});

describe("guard", () => {
  const me = (cli: boolean) => vi.fn(async () => ({ entitlements: { cli } }) as any);

  it("refuses when not logged in", async () => {
    const client = await connect(library(), createGuard("none", me(true)));
    const result = await client.callTool({ name: "list_books", arguments: {} });
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("NOT_LOGGED_IN");
  });

  it("enforces the Plus entitlement and caches a positive check", async () => {
    const deniedClient = await connect(library(), createGuard("credentials", me(false)));
    expect(payload(await deniedClient.callTool({ name: "list_books", arguments: {} })).error.code).toBe("PLAN_REQUIRED");

    const allowed = me(true);
    const lib = library();
    const client = await connect(lib, createGuard("api_key", allowed));
    await client.callTool({ name: "list_books", arguments: {} });
    await client.callTool({ name: "list_books", arguments: {} });
    expect(allowed).toHaveBeenCalledTimes(1);
    expect(lib.listBooks).toHaveBeenCalledTimes(2);
  });
});
