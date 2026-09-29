# Workflow: daily review

Goal: run today's vocabulary review as a conversation, then report how it went.

1. **Get today's queue.** Run `koto vocab due --limit 30 --json`. If the user names a pack, add `--pack <name>`.
   - If `total` is 0, congratulate the user and stop. Optionally offer "review ahead" by listing cards with `koto vocab list --json` and choosing those with the earliest `dueDate`.
2. **Report first.** Say how many cards are due (`total`), how many are new (`srsState == "new"`), and which packs they come from.
3. **Quiz one card at a time.** Show only `word`, and never the meaning. Ask the user for the meaning or reading. Then reveal `reading`, `meaning` and `example`.
4. **Grade.** Grade honestly from the user's answer, or ask them to self-grade:
   - `1` again: wrong or blank
   - `2` hard: right but slow or partial
   - `3` good: right
   - `4` easy: instant and effortless

   Record the grade with `koto vocab grade <id> <grade> --json`. The returned `vocab.dueDate` is the next review date. Cards graded 1 or 2 stay due today, so revisit them at the end.
5. **Handle mistakes.** For each card graded 1, write one new short example sentence using the word at the user's level. Offer to save it with `koto vocab add <word> -e "<sentence>" --json`: the word already exists, so this only fills an empty example.
6. **Summarise.** Report how many cards were reviewed, the counts per grade, the words graded 1 (with the new examples), and when the next cards are due.

Never grade a card the user didn't actually answer. Every grade is a permanent review event, and there is no undo from the CLI.
