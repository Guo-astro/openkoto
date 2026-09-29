# OpenKoto iOS — App Store metadata (English)

## App information

- Name: OpenKoto
- Subtitle: Learn from content you love
- Primary category: Education
- Secondary category: Utilities
- Price: Free
- Privacy policy: https://openkoto.com/privacy
- Support URL: https://github.com/hikariming/OpenKoto/issues
- Marketing URL: https://openkoto.com/

## Keywords

language learning,reader,translation,vocabulary,SRS,Japanese,furigana,ebook,subtitles,video

## Description

OpenKoto is an open-source, privacy-first language-learning app. Turn the articles, books, and videos you genuinely care about into study material, understand sentences in context, collect vocabulary, and review it on a schedule.

Key features:

• Paste text or import TXT, Markdown, and web content
• Import TXT and EPUB books with automatic chapter splitting, in either a sentence-by-sentence view or the book's original layout
• Import video and audio with SRT / VTT subtitles — or generate subtitles on device when you have none (requires iOS 26)
• Subtitles follow playback sentence by sentence; tap a line to jump to it, loop a single sentence, change speed without changing pitch, and hide the text to shadow by ear
• Read sentence by sentence, resume where you left off, and add bookmarks and highlights
• Show word-level readings above Japanese and Chinese text (furigana / pinyin), generated entirely on device
• Search the full text of everything you have imported — articles, book chapters, and media transcripts — and jump straight to the sentence
• Save vocabulary, organize word packs, and use spaced-repetition review; jump from any card back to the sentence it came from
• View reading and review statistics
• Use the app in English, Simplified Chinese, or Japanese
• Choose light, dark, and multiple visual themes
• Send web pages or selected text to OpenKoto from the iOS share sheet

Optional AI features use a bring-your-own-key model. Configure a compatible provider of your choice for translations and sentence explanations. API keys are stored in the iOS Keychain, while learning content and progress stay on your device. AI requests go directly from your device to your selected provider and do not pass through an OpenKoto app server.

No account is required. Sample articles are included, so reading, vocabulary, and review features work without configuring an AI provider.

OpenKoto is free and open source.

## What's new in 0.5.5

• Improved compatibility with reasoning models including GPT‑5, the o-series, and Gemini 2.5 by adapting output-limit and temperature parameters automatically
• Automatically retries once after temporary rate limits or dropped network connections, making batch explanations and translations more reliable
• Batch jobs now retain the failure count and specific cause, retry only recoverable items, and no longer hide errors such as insufficient balance or authorization failures
• Copy a redacted diagnostic report after an AI request fails to help identify provider, model, network, or configuration issues; API keys are never included

## What's new in 0.4.1

• iCloud sync: words, review progress, word packs, articles and AI explanations now sync between your iPhone, iPad and Mac through your own iCloud account — we never see or store any of it. Off by default; turn it on in Settings → iCloud Sync. Book and video files stay on each device (a few GB would fill your iCloud), but their text, subtitles and explanations sync, so you can keep reading on another device
• If two devices review the same card while offline, both reviews are kept — neither one overwrites the other
• Mac app: same purchase as iPhone and iPad, with a sidebar, right-click actions, menu bar shortcuts and scroll-wheel support
• iPad landscape and large screens now use a split layout: text on the left, explanation permanently on the right. Tapping a sentence swaps the right pane instead of covering the text with a sheet. Line length is capped, so a 13-inch landscape page no longer runs 70+ characters wide
• Import and export your data: bring in material prepared in the desktop app, or export everything as a backup. Importing the same file twice creates no duplicates and never overwrites edits you made on your phone
• Fixed the date labels on the three statistics charts, which showed as ellipses

## What's new in 0.3.3

• Cards you get wrong come back the same day: tapping "Unsure" or "Don't know" no longer pushes the card to tomorrow — it returns a few cards later, and keeps returning until you tap "Know it". Quitting after revealing the answer counts as "Don't know" and keeps the card in today's queue; closing without revealing it changes nothing
• Today's progress now counts only the cards you actually got right. Previously every grade advanced it. Cards still to be cleared are shown under the progress bars
• "Study 20 more" after you finish today's cards: reviews the cards due soonest, ahead of schedule, so tomorrow's queue gets shorter. The vocabulary button also turns into a review-ahead entry when nothing is due
• "Source" on a vocabulary card now works for words saved before the feature shipped: opening it finds the sentence the word came from and remembers it. Sources broken by re-importing a book repair themselves the same way

## What's new in 0.3.2

• "Source" on a vocabulary card now opens a panel instead of jumping away: flip a review card, tap the source, and you get the original sentence, its translation, the explanation, grammar points and context — then carry on reviewing. If you do want the full text, the panel has an "Open in text" button. Previously a single tap dropped you into an article of several hundred paragraphs with no sense of where you had landed
• Swiping a row in the vocabulary list opens the same panel, so both entry points behave alike
• Sentences that have not been explained yet still open, showing the sentence alone; if the source has been re-split since (for example after re-importing the same book), the source name and the jump are kept instead of the whole block disappearing

## What's new in 0.3.1

• Video and audio study: import a video or audio file (or pick one from Photos), pair it with SRT / VTT subtitles, or generate subtitles on device (requires iOS 26). Subtitles follow playback sentence by sentence, and the transcript can also be read as a plain article
• Shadowing mode: loop one sentence at 0.75× with pitch preserved and the text hidden — listen first, reveal only when you need to
• Full-library search: search the full text of articles, book chapters, and media transcripts at once, then jump straight to the matching sentence. The index is built locally on device
• Word lookup: look up a single word with its sentence as context instead of paying for a full sentence explanation
• Explanations are now reused automatically — re-import a book you have already studied and its explanations come back without another AI call
• Batch explanation now lets you pick a sentence range and shows how many sentences will be processed
• Vocabulary cards gain "Go to sentence": flip a review card and it shows which article or book chapter the word came from, along with the sentence you saved it from — tap to jump back to it (media jumps to the timestamp too). The same action is available by swiping a row in the vocabulary list
• The introduction is now a four-page tour covering the main features, with no extra steps
• Fixed: AI requests did not actually carry an output-length limit, so "Test connection" produced a full generation
• Fixed: cancelling a batch left in-flight requests running and billable, and restarting immediately could run two batches at once
• Fixed: an insufficient balance was reported as rate limiting, so users kept retrying an error that would never clear

## What's new in 0.2.5

• Books: import TXT and EPUB files with automatic chapter splitting, resume position, bookmarks, and highlights, plus an original-layout reading mode
• Word-level readings: show furigana above Japanese kanji and pinyin above Chinese words, generated entirely on device with no network or AI usage, toggled from the reader toolbar
• Flashcards now hide the reading on the front by default, with a toggle in the card menu
• First launch now starts with a language picker before the introduction
• Settings gains a "Replay Welcome Guide" entry
• Fixed non-UTF-8 text files (such as GB18030 Chinese TXT) being imported as garbled text

## First release notes

The first iOS release of OpenKoto includes text and web import, immersive reading, vocabulary management, spaced-repetition review, learning statistics, BYOK AI explanations, and an iOS share extension.
