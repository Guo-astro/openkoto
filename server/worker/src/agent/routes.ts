// Cloud study agent (design doc §10.4): the hosted model drives the same tools as the MCP
// server, in-process, on behalf of the signed-in user. Each turn is billed in credits.

import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { LibraryClient, OpenKotoClient } from "@openkoto/client";
import { createOpenKotoMcpServer } from "@openkoto/mcp-tools";
import type { AppBindings, Env } from "../env";
import { principalOf, requireAuth } from "../auth/middleware";
import { signAccessToken } from "../auth/tokens";
import { currentPlan, planAtLeast } from "../billing/entitlements";
import { reserveCredits, settleCredits } from "../billing/credits";
import { ApiError, badRequest, forbidden } from "../lib/http";
import { newId } from "../lib/crypto";
import { creditsFor } from "../ai/service";
import type { Dispatch } from "../mcp/routes";

const MAX_STEPS = 8;
const MAX_HISTORY = 20;
// Generous reservation for one agent turn (settled to actual usage afterwards).
const RESERVE_INPUT_TOKENS = 60_000;
const RESERVE_OUTPUT_TOKENS = 6_000;

const SYSTEM_PROMPT = `You are OpenKoto's study assistant. OpenKoto is a language-learning app with a library of books, articles and song lyrics, and a vocabulary deck reviewed with FSRS.
You can read and modify the user's library through tools. Rules:
- Use tools to look things up instead of guessing ids; ids come from earlier tool results.
- Only make changes the user asked for. Summarise what you changed at the end (words added, packs created, translations saved).
- Tools that use AI (translate_lyrics, create_word_pack_from_text) spend the user's credits; use them only when asked.
- Answer in the user's language, concisely.`;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface AgentStep {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

async function callModel(env: Env, messages: ChatMessage[], tools: unknown[]) {
  const res = await fetch(`${(env.AI_API_BASE ?? "https://api.deepseek.com/v1").replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.AI_MODEL ?? "deepseek-chat", messages, tools, tool_choice: "auto", temperature: 0.3 }),
  });
  if (!res.ok) throw new ApiError(502, "AI_ERROR", `the AI provider failed (${res.status})`);
  const body = (await res.json()) as {
    choices?: { message?: ChatMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    message: body.choices?.[0]?.message ?? { role: "assistant" as const, content: "" },
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

function summarise(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function agentRoutes(dispatch: Dispatch) {
  return new Hono<AppBindings>().post("/chat", requireAuth("ai:use"), async (c) => {
    const p = principalOf(c);
    if (!c.env.AI_API_KEY) throw new ApiError(503, "AI_UNAVAILABLE", "hosted AI is not configured");
    const plan = await currentPlan(c.env, p.userId);
    if (!planAtLeast(plan, "plus")) throw forbidden("the study agent needs OpenKoto Plus or Pro", "PLAN_REQUIRED");

    const body = (await c.req.json()) as { messages?: { role: string; content: string }[]; timezone?: string };
    const history = (body.messages ?? [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 8000) }));
    if (!history.length || history.at(-1)!.role !== "user") throw badRequest("the last message must be from the user");

    // An internal short-lived token scoped to library + AI; it never leaves the Worker.
    const token = await signAccessToken(c.env, {
      sub: p.userId,
      did: "agent",
      scp: ["vocab:read", "vocab:write", "library:read", "library:write", "ai:use"],
      plan,
      email: p.email,
    });
    const api = new OpenKotoClient({
      baseUrl: new URL(c.env.APP_ORIGIN).origin,
      clientName: "agent/1",
      tokenStore: { get: async () => ({ accessToken: token }), set: async () => {} },
      fetch: async (url, init) => dispatch(new Request(url, init), c.env, c.executionCtx),
    });
    const server = createOpenKotoMcpServer(new LibraryClient(api, body.timezone), { sdk: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "openkoto-agent", version: "1" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    await mcp.connect(clientTransport);

    const requestId = newId();
    const reserved = creditsFor(RESERVE_INPUT_TOKENS, RESERVE_OUTPUT_TOKENS);
    if (!(await reserveCredits(c.env, p.userId, reserved, requestId))) throw new ApiError(402, "INSUFFICIENT_CREDITS", "not enough credits");

    let inputTokens = 0;
    let outputTokens = 0;
    const steps: AgentStep[] = [];
    try {
      const { tools } = await mcp.listTools();
      const fnTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
      const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

      for (let step = 0; step < MAX_STEPS; step++) {
        const out = await callModel(c.env, messages, fnTools);
        inputTokens += out.inputTokens;
        outputTokens += out.outputTokens;
        const calls = out.message.tool_calls ?? [];
        messages.push({ role: "assistant", content: out.message.content ?? "", ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) {
          const credits = creditsFor(inputTokens, outputTokens);
          await settleCredits(c.env, p.userId, reserved, credits, requestId);
          return c.json({ reply: out.message.content ?? "", steps, credits });
        }
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            // Malformed arguments are reported back to the model as a tool error.
          }
          const result = await mcp.callTool({ name: call.function.name, arguments: args }).catch((err: unknown) => ({
            isError: true,
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          }));
          const text = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
          steps.push({ tool: call.function.name, arguments: args, ok: !result.isError, summary: summarise(text) });
          messages.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, 12_000) });
        }
      }
      const credits = creditsFor(inputTokens, outputTokens);
      await settleCredits(c.env, p.userId, reserved, credits, requestId);
      return c.json({ reply: "（步骤过多，已停止。请把任务拆小一点再试。）", steps, credits, truncated: true });
    } catch (err) {
      await settleCredits(c.env, p.userId, reserved, inputTokens + outputTokens ? creditsFor(inputTokens, outputTokens) : 0, requestId);
      throw err;
    } finally {
      c.executionCtx.waitUntil(Promise.allSettled([mcp.close(), server.close()]));
    }
  });
}
