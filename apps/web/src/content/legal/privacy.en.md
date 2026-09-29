OpenKoto ("OpenKoto", "we", "us") is open-source language-learning software. This policy explains how the OpenKoto apps — **iOS / iPadOS** (App Store), **macOS, Windows and Linux** desktop, the **web app** at openkoto.com and the **`koto` CLI / MCP server** — and the optional **OpenKoto cloud service** (accounts, sync, hosted AI and memberships) handle your information.

## Summary

- **No account is required.** Without signing in, your content stays on your device and we receive nothing.
- **Signing in is optional.** If you create an account, we store the data you choose to sync so it can follow you across devices.
- **Bring your own key:** if you configure your own AI provider, text goes **directly from your device** to that provider, never through our servers.
- We show **no ads**, use **no third-party advertising trackers**, **do not sell your data**, and **do not train models** on your content.

## Using OpenKoto without an account

All local features work without an account. The following is stored only on your device and stays under your control:

- Imported articles, books, lyrics and their translations and explanations
- Vocabulary lists, word packs and spaced-repetition (FSRS) review history
- Reading progress, bookmarks and study statistics
- App settings, AI provider configuration and API keys

Where it lives:

- **iOS:** API keys are stored in the **iOS Keychain**; other data is stored in a local database inside the app's sandbox. If you use the **Share Extension**, shared text is handed to the app through a private App Group container on your device.
- **Desktop:** in the application's local data folder.
- **Web:** in your browser's local storage (IndexedDB) for openkoto.com.

You can delete local data by deleting the app (iOS), clearing the application data (desktop) or clearing site data in your browser (web). On iOS, Keychain items may survive an uninstall — remove your model configurations in Settings first if you also want their API keys deleted.

## What we collect when you sign in

- **Account:** your email address, and the name and avatar supplied by Google, Apple or GitHub if you sign in with them.
- **Synced data:** the vocabulary, packs, review history, articles, books (including the uploaded original files), lyrics, bookmarks and reading progress you sync.
- **Devices:** device name, platform and app version, shown in your list of signed-in devices so you can remove them.
- **Orders:** membership status, credits and the order or transaction IDs from our payment channels.
- **Hosted AI:** when you use OpenKoto's hosted AI, the number of tokens and credits used. We do not keep the text you send or the AI's responses in our logs.
- **Security logs:** limited technical data such as IP address and request times, used to prevent abuse and keep the service running.

## How we use it

Only to provide and secure sync, hosted AI, memberships and support. We do not sell or rent your data, use it for advertising, or use your content to train AI models.

## AI features

**Your own key (BYOK).** When you configure your own provider (for example OpenAI, Google AI Studio, 302.AI, Moonshot / Kimi or any compatible endpoint), the text you choose to translate or explain is sent **directly from your device** to that provider using your key. We do not receive, log or store your prompts, responses or keys. Your use of that provider is governed by its own terms and privacy policy.

**Hosted AI.** If you use OpenKoto's hosted AI (on a paid plan), your request is sent through our servers to the model provider we use (for example DeepSeek) solely to produce the response.

## Payments

- **Web:** purchases are processed by **Creem**, which acts as merchant of record. We receive your order status, not your card details.
- **iOS:** in-app purchases are processed by **Apple**. We receive the transaction information needed to activate your membership. Apple's handling of your data is governed by [Apple's privacy policy](https://www.apple.com/legal/privacy/).

## Storage and service providers

Cloud data is stored on **Cloudflare** (Workers, D1, Durable Objects and R2). We share data with service providers only as needed to run the service: Cloudflare (hosting and sign-in email delivery), Creem and Apple (payments), Google, Apple and GitHub (if you choose them to sign in), and our hosted AI model provider.

## Other on-device processing

- **Importing from the web:** when you import an article by URL, the page is fetched directly from your device (or, on the web app, from your browser) from the website you specified.
- **Text-to-speech:** read-aloud on Apple platforms uses Apple's on-device speech synthesis; the text is not sent to us.

## Retention and your rights

From the **Account** page you can export your synced data, remove signed-in devices or delete your account. Account deletion has a **7-day grace period**; after that your account, synced data and uploaded files are permanently erased. Local data on your devices is not affected — delete it as described above. You can also contact us to access, correct or delete your data.

## Children

OpenKoto is a general-audience learning tool and is not directed at children under 13. We do not knowingly collect personal information from children.

## Changes to this policy

We may update this policy from time to time. Material changes will be posted on this page and in our GitHub repository, and the date above will be updated.

## Contact

- **Email:** lbm21@tsinghua.org.cn
- **GitHub Issues:** [github.com/hikariming/openkoto/issues](https://github.com/hikariming/openkoto/issues)
