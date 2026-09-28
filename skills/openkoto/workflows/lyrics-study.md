# Workflow: lyrics study

Goal: translate a song, save it to the library, and turn its useful words into a word pack.

1. **Check access.** Run `koto whoami --json`. Exit 3 means ask the user to `koto login`. If `entitlements.cli` is false, the user needs Plus.
2. **Translate.**
   - If the user has a BYOK provider (`koto config get byok.model --json` returns a non-null value):
     `koto lyrics translate song.lrc --to <lang> --byok --save --json`
   - Otherwise try hosted AI: `koto lyrics translate song.lrc --to <lang> --save --json`.
     If it exits 4 or 1 with `HOSTED_AI_*`, save the lyrics untranslated with `koto lyrics add song.lrc --json`. Then translate the lines yourself and write them back with the MCP tool `save_lyrics_translation` (`[{order, translation}]`, where `order` is the 0-based line index).
   - Note the `saved.id` (or `id`) in the result. This is the lyrics id.
3. **Check alignment.** If `aligned` is false, find the lines with an empty `translation` and fill them in yourself.
4. **Pick vocabulary.** From `lines[].text`, choose 5–15 words or expressions worth learning. Match the user's level if they told you it. Skip particles, names and words the user already has. Check with `koto vocab list -q <word> --json`.
5. **Confirm with the user.** Show the list with readings and meanings and let them remove items.
6. **Save the words to a pack named after the song:**
   ```bash
   koto vocab add 懐かしい -r なつかしい -m "nostalgic" -e "<the lyric line>" --pack "<Song title>" --from <lyricsId> --json
   ```
   Words the user already has come back with `created: false`. That is expected: they get merged into the pack.
7. **Report.** Give the song title, how many lines were translated, and the words added (`created` vs merged). Suggest `koto lyrics export <id> --format md` for a printable sheet.
