import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { LanguageSwitcher } from "../components/Layout";

// Plain-language policies for the OpenKoto cloud service. The iOS/desktop apps link here too.
const UPDATED = "2026-09-28";

function Doc({ children }: { children: React.ReactNode }) {
  return <article className="prose-sm space-y-4 leading-relaxed [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-6 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1">{children}</article>;
}

function PrivacyZh() {
  return (
    <Doc>
      <p>OpenKoto（“我们”）是一款开源的语言学习软件。本政策说明 OpenKoto 各客户端（iOS、macOS、Windows、Linux、网页、命令行）以及 OpenKoto 云服务如何处理你的信息。</p>
      <h2>不登录时</h2>
      <p>你可以不注册账号使用 OpenKoto 的全部本地功能。此时你的文章、书籍、生词和复习记录只保存在你的设备上。如果你配置了自己的 AI 服务（BYOK），文本会由你的设备直接发送给你选择的 AI 供应商，不经过我们的服务器。</p>
      <h2>登录后我们收集的信息</h2>
      <ul>
        <li>账号信息：邮箱地址；如果使用 Google / Apple / GitHub 登录，还包括该服务提供的名称与头像。</li>
        <li>同步数据：你选择同步的生词、词包、复习记录、文章、书籍（含上传的原文件）、歌词、书签与阅读进度。</li>
        <li>设备信息：设备名称、平台与应用版本，用于“已登录设备”列表。</li>
        <li>订单信息：订阅状态与支付渠道的订单号。支付由 Creem 或 Apple 处理，我们不接触你的银行卡信息。</li>
        <li>使用 OpenKoto 托管 AI 时：请求的 token 数量与消耗的积分。我们不在日志中保存你发送的原文或 AI 的回复。</li>
      </ul>
      <h2>我们如何使用信息</h2>
      <p>仅用于提供同步、托管 AI、会员与客服服务。我们不出售你的数据，不用于广告，也不用你的内容训练模型。</p>
      <h2>存储与第三方</h2>
      <p>数据存储在 Cloudflare（Workers、D1、Durable Objects、R2）。托管 AI 请求会发送给我们选择的模型供应商（如 DeepSeek）以完成你的请求。登录邮件通过邮件服务商发送。</p>
      <h2>你的权利</h2>
      <p>你可以随时在“账户”页面导出数据、移除设备或删除账号。删除账号后有 7 天冷静期，之后你的账号、同步数据和上传文件将被永久删除。</p>
      <h2>联系我们</h2>
      <p>如有问题，请在 GitHub 提交 issue：github.com/hikariming/OpenKoto。</p>
    </Doc>
  );
}

function PrivacyEn() {
  return (
    <Doc>
      <p>OpenKoto (“we”) is open-source language-learning software. This policy explains how the OpenKoto apps (iOS, macOS, Windows, Linux, web, CLI) and the OpenKoto cloud service handle your information.</p>
      <h2>Without an account</h2>
      <p>All local features work without an account. Your articles, books, vocabulary and reviews stay on your device. If you configure your own AI provider (BYOK), text is sent directly from your device to that provider and never passes through our servers.</p>
      <h2>What we collect when you sign in</h2>
      <ul>
        <li>Account: your email address, plus the name and avatar supplied by Google / Apple / GitHub if you use them.</li>
        <li>Synced data: the vocabulary, packs, reviews, articles, books (including uploaded files), lyrics, bookmarks and reading progress you choose to sync.</li>
        <li>Devices: device name, platform and app version, shown in your signed-in devices list.</li>
        <li>Orders: subscription status and order ids. Payments are processed by Creem or Apple; we never see your card details.</li>
        <li>Hosted AI: token counts and credits used. We do not log the text you send or the AI's responses.</li>
      </ul>
      <h2>How we use it</h2>
      <p>Only to provide sync, hosted AI, memberships and support. We do not sell your data, use it for ads, or train models on your content.</p>
      <h2>Storage and processors</h2>
      <p>Data is stored on Cloudflare (Workers, D1, Durable Objects, R2). Hosted AI requests are sent to the model provider we use (e.g. DeepSeek) to fulfil them. Sign-in emails are sent through an email delivery provider.</p>
      <h2>Your rights</h2>
      <p>From the Account page you can export your data, remove devices or delete your account. Deletion has a 7-day grace period, after which your account, synced data and uploaded files are permanently erased.</p>
      <h2>Contact</h2>
      <p>Open an issue at github.com/hikariming/OpenKoto.</p>
    </Doc>
  );
}

function TermsZh() {
  return (
    <Doc>
      <p>使用 OpenKoto 云服务即表示你同意以下条款。OpenKoto 客户端源代码按 Apache 2.0 许可证开源。</p>
      <h2>账号</h2>
      <p>你需要对账号下的活动负责。请勿与他人共享账号或 API Key。</p>
      <h2>你的内容</h2>
      <p>你上传的书籍、歌词和文章归你或原权利人所有，仅用于你个人学习。OpenKoto 不提供公开分享功能，请勿上传你无权使用的内容。</p>
      <h2>会员与积分</h2>
      <ul>
        <li>会员按所选周期计费；网页购买可在账户页随时取消续订，已付周期内权益保留到期末。App Store 订阅请在系统设置中管理。</li>
        <li>积分只能用于 OpenKoto 内的 AI 功能，不可提现或转让。购买的积分自购买起 12 个月内有效。</li>
        <li>激活码一经兑换不可撤销。</li>
      </ul>
      <h2>合理使用</h2>
      <p>禁止利用服务进行滥用、攻击、批量抓取或违反法律的行为。我们可能对异常用量进行限流。</p>
      <h2>免责声明</h2>
      <p>服务按“现状”提供。AI 生成内容可能存在错误，请自行判断。</p>
    </Doc>
  );
}

function TermsEn() {
  return (
    <Doc>
      <p>By using the OpenKoto cloud service you agree to these terms. The OpenKoto client source code is open source under the Apache 2.0 license.</p>
      <h2>Accounts</h2>
      <p>You are responsible for activity under your account. Don't share your account or API keys.</p>
      <h2>Your content</h2>
      <p>Books, lyrics and articles you upload belong to you or their rights holders and are for your personal study only. OpenKoto has no public sharing; don't upload content you have no right to use.</p>
      <h2>Memberships and credits</h2>
      <ul>
        <li>Memberships renew each billing period. Web purchases can be cancelled from the Account page and stay active until the period ends. Manage App Store subscriptions in your device settings.</li>
        <li>Credits can only be spent on AI features inside OpenKoto and are not refundable or transferable. Purchased credits are valid for 12 months.</li>
        <li>Redeemed activation codes cannot be reversed.</li>
      </ul>
      <h2>Fair use</h2>
      <p>No abuse, attacks, bulk scraping or unlawful use. We may rate-limit unusual usage.</p>
      <h2>Disclaimer</h2>
      <p>The service is provided “as is”. AI output may contain mistakes; use your judgement.</p>
    </Doc>
  );
}

export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const body = kind === "privacy" ? (zh ? <PrivacyZh /> : <PrivacyEn />) : zh ? <TermsZh /> : <TermsEn />;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="flex items-center justify-between mb-8">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/logo.png" alt="" className="h-7 w-7 rounded-md" /> OpenKoto
          </Link>
          <LanguageSwitcher />
        </div>
        <h1 className="text-2xl font-semibold mb-1">{kind === "privacy" ? t("footer.privacy") : t("footer.terms")}</h1>
        <p className="text-sm text-muted-foreground mb-6">{t("legal.updated", { date: UPDATED })}</p>
        {body}
      </div>
    </div>
  );
}
