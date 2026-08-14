import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const userDir = mkdtempSync(join(tmpdir(), "bk-min-"));
console.log("spawning chrome...");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  "--remote-debugging-port=3925", `--user-data-dir=${userDir}`, "about:blank",
], { stdio: "ignore" });
chrome.on("exit", c => console.log("[chrome exit]", c));
chrome.on("error", e => console.log("[chrome error]", e.message));

const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 30; i++) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch("http://127.0.0.1:3925/json", { signal: ctl.signal });
    clearTimeout(t);
    const list = await r.json();
    console.log("attempt", i, "OK targets:", list.filter(x => x.type === "page").map(x => x.url));
    break;
  } catch (e) {
    console.log("attempt", i, "fail:", e.name, e.message.slice(0, 80));
    await sleep(300);
  }
}
try { chrome.kill(); } catch {}
process.exit(0);
