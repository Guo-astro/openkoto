# Workflow: novel reading

Goal: help the user read a book from their OpenKoto library by summarising or explaining chapters, keeping a character list, and saving new words.

Books are imported in the OpenKoto apps (EPUB/TXT). The CLI reads them but does not import or translate whole books yet. Hosted book translation arrives in a later release.

1. **Find the book.** Run `koto book list --json`, or `koto search "<title>" --types book --json`.
2. **List the chapters.** Run `koto book chapters <bookId> --json`. It returns `items[].index` (0-based), `title` and `articleId`.
3. **Read a chapter.** Run `koto article show <articleId> --json`. `segments[]` are the chapter's sentences in order, with `translation` where the user has already translated them in the app.
4. **Help the user**, depending on what they ask for:
   - **Summary / recap:** summarise in the user's native language, and quote key sentences in the original.
   - **Character list:** keep a running list (name, reading, role, first appearance chapter) as you go through chapters. Keep it in the conversation. Nothing is written to OpenKoto.
   - **Difficult sentences:** explain the grammar and vocabulary of the sentences the user points at.
5. **Save vocabulary.** Only do this when the user wants it. Confirm the list first, then:
   ```bash
   koto vocab add <word> -r <reading> -m "<meaning>" -e "<sentence from the chapter>" --pack "<Book title>" --from <chapterArticleId> --json
   ```
6. For long books, work chapter by chapter. Don't load more than 2–3 chapters at a time.
