import type { Env } from "../env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** "OpenKoto <noreply@openkoto.com>" → { name, email } */
export function parseAddress(value: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m?.[2] ? { email: m[2], ...(m[1] ? { name: m[1].replace(/^"|"$/g, "") } : {}) } : { email: value.trim() };
}

export async function sendEmail(env: Env, message: EmailMessage): Promise<void> {
  if (env.EMAIL_PROVIDER === "cloudflare") {
    if (!env.EMAIL) throw new Error("send_email binding EMAIL is not configured");
    await env.EMAIL.send({ from: parseAddress(env.EMAIL_FROM), to: message.to, subject: message.subject, text: message.text, html: message.html });
    return;
  }
  if (env.EMAIL_PROVIDER === "resend") {
    if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text()}`);
    return;
  }
  // Local development: print instead of sending.
  console.log(`[email] to=${message.to} subject=${message.subject}\n${message.text}`);
}

export function otpEmail(appName: string, otp: string): Omit<EmailMessage, "to"> {
  return {
    subject: `${otp} 是你的 ${appName} 登录验证码`,
    text: `你的 ${appName} 登录验证码是：${otp}\n\n验证码 10 分钟内有效。如果不是你本人操作，请忽略这封邮件。\n\nYour ${appName} sign-in code is ${otp}. It expires in 10 minutes.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 12px">${appName}</h2><p>你的登录验证码 / Your sign-in code:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${otp}</p><p style="color:#666;font-size:13px">10 分钟内有效。如果不是你本人操作，请忽略这封邮件。<br>Expires in 10 minutes.</p></div>`,
  };
}
