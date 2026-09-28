import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCredits } from "../src/billing/credits";
import { generateActivationCodes } from "../src/billing/routes";
import { api, json, nativeLogin } from "./helpers";

const realFetch = globalThis.fetch;
afterEach(() => vi.restoreAllMocks());

async function makePlus(token: string) {
  const [code] = await generateActivationCodes(env, { batch: "agent", plan: "plus", durationDays: 30, credits: 0, count: 1 });
  await api(token, "/api/v1/billing/redeem", { method: "POST", body: JSON.stringify({ code }) });
}

describe("cloud agent", () => {
  it("requires Plus", async () => {
    const t = await nativeLogin("agent-free@example.com");
    const res = await api(t.accessToken, "/api/v1/agent/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    expect(res.status).toBe(403);
  });

  it("runs tools in a loop and bills actual usage", async () => {
    const t = await nativeLogin("agent@example.com");
    await makePlus(t.accessToken);
    await addCredits(env, t.user.id, 2000, "adjust", "test");
    // Seed one word through the library API so the tool has something to find.
    await api(t.accessToken, "/api/v1/library/vocab", { method: "POST", body: JSON.stringify({ word: "桜", meaning: "cherry blossom" }) });

    let turn = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://ai.test/")) return realFetch(input as RequestInfo, init);
      const body = JSON.parse(String(init?.body)) as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
      turn += 1;
      if (turn === 1) {
        expect(body.tools.map((x) => x.function.name)).toContain("get_review_stats");
        return Response.json({
          choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_review_stats", arguments: "{}" } }] } }],
          usage: { prompt_tokens: 3000, completion_tokens: 50 },
        });
      }
      const toolMsg = body.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("1");
      return Response.json({ choices: [{ message: { role: "assistant", content: "你有 1 个生词。" } }], usage: { prompt_tokens: 3500, completion_tokens: 20 } });
    });

    const res = await json<{ reply: string; steps: { tool: string; ok: boolean }[]; credits: number }>(
      await api(t.accessToken, "/api/v1/agent/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "我有多少生词？" }] }) }),
    );
    expect(res.reply).toBe("你有 1 个生词。");
    expect(res.steps).toEqual([expect.objectContaining({ tool: "get_review_stats", ok: true })]);
    const me = await json<{ credits: number }>(await api(t.accessToken, "/api/v1/me"));
    expect(me.credits).toBe(2000 - res.credits);
    expect(res.credits).toBeGreaterThan(0);
  });
});
