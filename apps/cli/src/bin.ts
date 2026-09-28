import { emitKeypressEvents } from "node:readline";
import { runCli } from "./cli";

/** Single keypress reader for `koto vocab review` (raw mode TTY). */
function ttyKeyReader(): (() => Promise<string>) | null {
  const stdin = process.stdin;
  if (!stdin.isTTY) return null;
  let started = false;
  return () =>
    new Promise((resolve) => {
      if (!started) {
        emitKeypressEvents(stdin);
        started = true;
      }
      stdin.setRawMode(true);
      stdin.resume();
      stdin.once("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
        stdin.setRawMode(false);
        stdin.pause();
        if (key?.ctrl && key.name === "c") return resolve("\u0003");
        resolve(key?.name === "space" ? " " : key?.name === "escape" ? "escape" : (str ?? key?.name ?? ""));
      });
    });
}

const code = await runCli(process.argv.slice(2), { readKey: ttyKeyReader() });
process.exitCode = code;
