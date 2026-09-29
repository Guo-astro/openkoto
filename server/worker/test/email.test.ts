import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { parseAddress, sendEmail } from "../src/lib/email";

describe("email", () => {
  it("parses display-name addresses", () => {
    expect(parseAddress("OpenKoto <noreply@openkoto.com>")).toEqual({ name: "OpenKoto", email: "noreply@openkoto.com" });
    expect(parseAddress("noreply@openkoto.com")).toEqual({ email: "noreply@openkoto.com" });
  });

  it("sends through the Cloudflare binding", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1" });
    const env = { EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "OpenKoto <noreply@openkoto.com>", EMAIL: { send } } as unknown as Env;
    await sendEmail(env, { to: "a@example.com", subject: "s", text: "t" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "a@example.com", from: { name: "OpenKoto", email: "noreply@openkoto.com" } }));
  });
});
