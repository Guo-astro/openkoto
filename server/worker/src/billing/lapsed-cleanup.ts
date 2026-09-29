import { PLAN_LIMITS } from "@openkoto/core";
import type { Env } from "../env";
import { sendEmail } from "../lib/email";
import { currentPlan } from "./entitlements";

const DAY_MS = 24 * 60 * 60 * 1000;
export const REMIND_AFTER_MS = 60 * DAY_MS;
export const PURGE_AFTER_MS = 90 * DAY_MS;
/** However long ago a membership lapsed, a reminder always goes out this long before removal. */
export const MIN_NOTICE_MS = 30 * DAY_MS;

interface StoredFile {
  key: string;
  size: number;
  uploaded: number;
}

/** Cloud book files: web/CLI uploads (books/) and files synced from the apps (blobs/…/Book/). */
async function bookFiles(env: Env, userId: string): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  for (const prefix of [`books/${userId}/`, `blobs/${userId}/Book/`]) {
    let cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) files.push({ key: o.key, size: o.size, uploaded: o.uploaded.getTime() });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return files;
}

/** Files to remove so what is left fits the free storage, keeping the most recently uploaded. */
export function filesOverFreeQuota(files: StoredFile[], quota = PLAN_LIMITS.free.fileBytesTotal): StoredFile[] {
  const newestFirst = [...files].sort((a, b) => b.uploaded - a.uploaded);
  const remove: StoredFile[] = [];
  let kept = 0;
  for (const f of newestFirst) {
    if (kept + f.size <= quota) kept += f.size;
    else remove.push(f);
  }
  return remove;
}

function reminderEmail(appName: string, excessMb: number, purgeDate: string) {
  return {
    subject: `${appName}：会员已到期，超出免费空间的云端书籍文件将于 ${purgeDate} 清理`,
    text: [
      `你的 ${appName} 会员已到期。云端书籍文件目前比免费空间（50 MB）多出约 ${excessMb} MB。`,
      `如果在 ${purgeDate} 前没有续费，我们会按上传时间保留最新的书籍文件，清理超出 50 MB 的较早文件。`,
      `生词、歌词、阅读进度等内容不会被删除；已经下载到你设备上的书也不受影响。续费即可保留全部文件：https://openkoto.com/pricing`,
      ``,
      `Your ${appName} membership has ended and your cloud book files are about ${excessMb} MB over the free 50 MB.`,
      `Unless you renew by ${purgeDate}, the oldest files above 50 MB will be removed (newest kept). Words, lyrics and reading progress are not deleted, and books already on your devices are unaffected.`,
    ].join("\n"),
  };
}

/**
 * Daily cron. For accounts whose last paid period ended 60+ days ago and that store more book
 * files than the free plan allows: email a reminder, then (90+ days after lapse and at least
 * MIN_NOTICE_MS after the reminder) remove the oldest book files above the free storage.
 * Records (words, lyrics, progress, book entries) are never touched.
 */
export async function runLapsedCleanup(env: Env, now = Date.now(), batch = 100): Promise<{ reminded: number; purged: number }> {
  const { results } = await env.DB.prepare(
    `select s.user_id, max(case when s.status = 'refunded' then s.updated_at else s.period_end end) as lapsed_at, u.email
     from subscriptions s join "user" u on u.id = s.user_id
     where s.channel <> 'appstore_sandbox'
     group by s.user_id
     having lapsed_at < ?
     limit ?`,
  )
    .bind(now - REMIND_AFTER_MS, batch * 5)
    .all<{ user_id: string; lapsed_at: number; email: string }>();

  let reminded = 0;
  let purged = 0;
  for (const row of results) {
    if (reminded + purged >= batch) break;
    if ((await currentPlan(env, row.user_id, now)) !== "free") continue;
    let state = await env.DB.prepare("select lapsed_at, reminded_at, purged_at from lapsed_cleanup where user_id = ?")
      .bind(row.user_id)
      .first<{ lapsed_at: number; reminded_at: number | null; purged_at: number | null }>();
    if (!state || state.lapsed_at !== row.lapsed_at) {
      // A new lapse (or the first one we see): start over.
      await env.DB.prepare(
        "insert into lapsed_cleanup (user_id, lapsed_at) values (?, ?) on conflict (user_id) do update set lapsed_at = excluded.lapsed_at, reminded_at = null, purged_at = null, purged_bytes = 0",
      )
        .bind(row.user_id, row.lapsed_at)
        .run();
      state = { lapsed_at: row.lapsed_at, reminded_at: null, purged_at: null };
    }
    if (state.purged_at) continue;

    const files = await bookFiles(env, row.user_id);
    const excess = filesOverFreeQuota(files);
    if (!excess.length) continue;

    if (!state.reminded_at) {
      const purgeAt = Math.max(row.lapsed_at + PURGE_AFTER_MS, now + MIN_NOTICE_MS);
      const excessMb = Math.max(1, Math.round(excess.reduce((n, f) => n + f.size, 0) / (1024 * 1024)));
      try {
        await sendEmail(env, { to: row.email, ...reminderEmail(env.APP_NAME, excessMb, new Date(purgeAt).toISOString().slice(0, 10)) });
      } catch (err) {
        console.error("lapsed reminder failed", row.user_id, err);
        continue; // try again tomorrow; never purge without a delivered reminder
      }
      await env.DB.prepare("update lapsed_cleanup set reminded_at = ? where user_id = ?").bind(now, row.user_id).run();
      reminded++;
      continue;
    }

    if (now - row.lapsed_at >= PURGE_AFTER_MS && now - state.reminded_at >= MIN_NOTICE_MS) {
      for (let i = 0; i < excess.length; i += 1000) await env.BUCKET.delete(excess.slice(i, i + 1000).map((f) => f.key));
      const bytes = excess.reduce((n, f) => n + f.size, 0);
      await env.DB.prepare("update lapsed_cleanup set purged_at = ?, purged_bytes = ? where user_id = ?").bind(now, bytes, row.user_id).run();
      console.log("lapsed cleanup", row.user_id, excess.length, bytes);
      purged++;
    }
  }
  return { reminded, purged };
}

/** Whether a missing cloud file was removed by the lapsed-membership cleanup. */
export async function filesWerePurged(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("select purged_at from lapsed_cleanup where user_id = ? and purged_at is not null").bind(userId).first();
  return !!row;
}
