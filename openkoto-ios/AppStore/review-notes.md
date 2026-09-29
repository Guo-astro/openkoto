# App Review notes

OpenKoto does not require registration or sign-in.

To review the app without external credentials:

1. On first launch, pick an interface language, then continue through the introduction. The AI setup step can be skipped.
2. Open one of the included public-domain sample articles.
3. Tap a sentence to open the reading and vocabulary interactions.
4. Tap the phonetic-character button in the reader toolbar to show word-level readings (furigana for Japanese, pinyin for Chinese). This runs entirely on device and needs no network or AI configuration.
5. Open the Vocabulary and Statistics tabs to review the local study features.
6. Text, TXT/Markdown/EPUB file, URL, and share-extension imports are available from the Library. Imported books are stored only on the device.
7. Import a video or audio file from the Library, or pick one from Photos. Playback, per-sentence subtitles, single-sentence looping, playback-speed change and the "shadowing" practice mode need no network and no AI configuration.
8. Pull down on the Library list to search. Search covers the full text of every imported article, book chapter and media transcript, and is performed locally with SQLite FTS5.
9. Settings > "Replay Welcome Guide" reopens the introduction at any time.

Word-level readings are produced with the system text tokenizer (CFStringTokenizer) on device. No text leaves the device for this feature.

Media notes:

- The app imports media files the user already has: files chosen through the document picker, videos chosen from the user's own photo library through the system `PhotosPicker` (out-of-process; the app never requests photo library access), and files shared from other apps. **The app cannot download media from any website or streaming service, and contains no such functionality.**
- Subtitles can be imported alongside a video (SRT/VTT), or generated on device. On-device generation uses the system `SpeechAnalyzer` / `SpeechTranscriber` API (iOS 26+); it does not use the microphone and sends no audio off the device. On iOS versions below 26 the generate-subtitles entry is not shown.
- Imported media files are copied into the app's own container and are never uploaded.

iCloud sync (new in 0.4.1):

- Sync is **off by default** and is turned on by the user in Settings > iCloud Sync. Nothing is uploaded until they do.
- It uses CloudKit and the reviewer's **own iCloud private database**. There is no OpenKoto server; we cannot see, store or access any of the synced data.
- Synced: vocabulary, review history, word packs, article text and AI explanations. **Not synced: EPUB and video files** — they stay on each device, because syncing multi-gigabyte media would consume the user's iCloud storage.
- The app can be reviewed entirely without iCloud. With sync off, or with no iCloud account signed in, every feature works exactly as before; the settings screen simply reports that sync is unavailable.
- The Remote notifications background mode is used solely for CloudKit's silent sync pushes. The app sends no user-facing notifications and never asks for notification permission.

Import and export (new in 0.4.1):

- Settings > Data lets the user export their entire library to a single `.okdata` file, and import one back. This is how material prepared in the OpenKoto desktop app is brought onto the device.
- Both are entirely local file operations through the system document picker. Nothing is uploaded.

AI translation and explanation are optional BYOK features. A user may configure their own compatible provider and API key in Settings. The API key is stored in the iOS Keychain. Requests go directly from the device to the provider selected by the user and do not pass through an OpenKoto app server.

AI reliability and diagnostics (new in 0.5.5):

- The app adapts request parameters for supported reasoning models and may retry a request once after a transient rate limit or dropped connection.
- If an AI request fails, the explanation panel and batch-failure banner offer “Copy Diagnostics.” The report contains app/device details, provider/model/endpoint, HTTP or URL error information, and a truncated response excerpt. It explicitly records only whether a key was attached; the API key itself is never included.
- This diagnostic report is copied to the system clipboard only when the user taps the button. OpenKoto does not upload or transmit it.

If App Review needs to test the optional AI flow, provide a temporary, revocable, low-quota provider configuration here before submission:

- Provider:
- Base URL:
- Model:
- Temporary API key:

Privacy policy: https://openkoto.com/privacy
Support: https://github.com/hikariming/OpenKoto/issues
