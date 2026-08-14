/* Reproduction harness for the bookkeeping dashboard scroll bug.
 * Serves pages/dashboard statically, injects a mock AstrBotPluginPage bridge,
 * drives headless Chrome via CDP, scrolls to bottom / overscrolls, and reports
 * console errors + DOM state sampling.
 */
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, normalize, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = normalize(join(__dirname, "..", "pages", "dashboard"));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 3917;
const DEBUG_PORT = 3922;

/* ---------- static server ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
console.log(`[server] http://127.0.0.1:${PORT}`);
const WATCHDOG = setTimeout(() => { console.error("[watchdog] timeout, exiting"); process.exit(2); }, 150000);
WATCHDOG.unref?.();

/* ---------- mock data ---------- */
function mockTx(i) {
  const types = ["expense", "income", "transfer"];
  const cats = [["餐饮", "🍚"], ["交通", "🚕"], ["购物", "🛒"], ["娱乐", "🎮"], ["工资", "💰"], ["房租", "🏠"]];
  const accs = ["现金", "银行卡", "支付宝", "微信"];
  const type = types[i % 3];
  const cat = cats[i % cats.length];
  return {
    id: i + 1,
    type,
    amount: +(Math.random() * 800 + 5).toFixed(2),
    category_id: i % cats.length + 1,
    category_name: type === "transfer" ? null : cat[0],
    account_id: (i % 4) + 1,
    account_name: accs[i % 4],
    to_account_name: type === "transfer" ? accs[(i + 1) % 4] : null,
    tx_date: `2025-0${(i % 9) + 1}-${String((i % 27) + 1).padStart(2, "0")}`,
    tx_time: `${String(i % 24).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00`,
    note: `备注 ${i}`,
    tags: i % 3 === 0 ? ["测试", "出差"] : [],
  };
}
const ALL_TXS = Array.from({ length: 500 }, (_, i) => mockTx(i));
const mockCats = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: ["餐饮", "交通", "购物", "娱乐", "工资", "房租"][i], type: i < 4 ? "expense" : "income", icon: ["🍚", "🚕", "🛒", "🎮", "💰", "🏠"][i], color: "", sort: 50 }));
const mockAccounts = [1, 2, 3, 4].map(i => ({ id: i, name: ["现金", "银行卡", "支付宝", "微信"][i - 1], type: ["cash", "bank", "alipay", "wechat"][i - 1], balance: 1234.56 * i, note: "", archived: false }));

const MOCK_BRIDGE = `
(() => {
  const ALL_TXS = ${JSON.stringify(ALL_TXS)};
  const CATS = ${JSON.stringify(mockCats)};
  const ACCS = ${JSON.stringify(mockAccounts)};
  const dash = () => {
    const recent = ALL_TXS.slice(0, 10).map(t => ({ ...t, category_name: t.type === 'transfer' ? null : t.category_name }));
    const daily = ALL_TXS.slice(0, 40).reduce((m, t) => { m[t.tx_date] = (m[t.tx_date] || 0) + (t.type === 'expense' ? t.amount : 0); return m; }, {});
    return {
      summary: { total_expense: 12345.67, total_income: 23456.78, balance: 11111.11, tx_count: 500 },
      recent_transactions: recent,
      accounts: ACCS,
      top_expense: recent.slice(0, 5),
      tag_stats: [{ name: '测试', amount: 100, count: 3 }],
      daily_expense: Object.entries(daily).map(([k, v]) => ({ tx_date: k, amount: v })),
      categories_expense: CATS.filter(c => c.type === 'expense').map(c => ({ name: c.name, amount: 100 })),
      categories_income: CATS.filter(c => c.type === 'income').map(c => ({ name: c.name, amount: 200 })),
      daily_income: [{ tx_date: '2025-01-01', amount: 300 }],
    };
  };
  window.AstrBotPluginPage = {
    ready: () => Promise.resolve(),
    getContext: () => ({ pluginName: 'astrbot_plugin_bookkeeping' }),
    apiGet: async (endpoint, params) => {
      if (endpoint === 'healthz') return { data: { config: { currency: '¥', page_size: 20, timezone: 'Asia/Shanghai' } } };
      if (endpoint === 'stats/dashboard') return { data: dash() };
      if (endpoint === 'transactions') {
        const limit = params && params.limit ? params.limit : 20;
        const offset = params && params.offset ? params.offset : 0;
        const items = ALL_TXS.slice(offset, offset + limit).map(t => ({ ...t }));
        return { data: { items, total: ALL_TXS.length, limit, offset } };
      }
      if (endpoint === 'categories') return { data: { items: CATS } };
      if (endpoint === 'accounts') return { data: { items: ACCS } };
      if (endpoint === 'tags') return { data: { items: [] } };
      return { data: {} };
    },
    apiPost: async () => ({}),
    download: async () => {},
  };
  window.__MOCK_BRIDGE__ = true;
})();
`;

/* ---------- CDP client ---------- */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    }
  };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return {
    ready,
    send(method, params = {}) {
      return ready.then(() => new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }));
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close() { ws.close(); },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------- scenario runner ---------- */
async function runScenario(name, setup, scrollSteps) {
  const userDir = await mkdtemp(join(tmpdir(), "bk-repro-"));
  console.log(`[scenario] ${name} | userDir=${userDir}`);
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=" + DEBUG_PORT,
    `--user-data-dir=${userDir}`,
    `--window-size=1440,900`,
    "about:blank",
  ], { stdio: "ignore" });
  chrome.on("exit", code => console.log(`[chrome] exited code=${code}`));

  // wait for devtools endpoint
  let target;
  for (let i = 0; i < 60; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`, { signal: ctl.signal });
      clearTimeout(t);
      const list = await r.json();
      target = list.find(t => t.type === "page");
      if (target) break;
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  if (!target) { console.error("[chrome] devtools not reachable on port " + DEBUG_PORT); throw new Error("chrome devtools not reachable"); }
  console.log("[chrome] target: " + target.url);

  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  console.log("[cdp] connected");

  const consoleErrors = [];
  const exceptions = [];
  client.on("Runtime.consoleAPICalled", p => {
    if (p.type === "error" || p.type === "warning") {
      const text = (p.args || []).map(a => a.value ?? a.description ?? "").join(" ");
      consoleErrors.push(`[console.${p.type}] ${text}`);
    }
  });
  client.on("Runtime.exceptionThrown", p => {
    exceptions.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "exception");
  });

  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK_BRIDGE });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  const loaded = new Promise(res => client.on("Page.loadEventFired", res));
  await client.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(1500);
  console.log("[page] loaded, waiting for app mount");

  // route to view if needed
  if (setup) await setup(client);
  console.log("[scenario] setup done");

  // sample DOM state over time
  const samples = [];
  const sampling = setInterval(async () => {
    try {
      const r = await client.send("Runtime.evaluate", {
        expression: `(() => {
          const c = document.querySelector('.bk-content');
          const tbl = document.querySelector('.el-table__body-wrapper');
          return JSON.stringify({
            scrollTop: c ? c.scrollTop : -1,
            scrollHeight: c ? c.scrollHeight : -1,
            clientHeight: c ? c.clientHeight : -1,
            rows: tbl ? tbl.querySelectorAll('tr').length : -1,
            errToasts: document.querySelectorAll('.el-message--error').length,
            loadingMasks: document.querySelectorAll('.el-loading-mask').length,
            bodyChildren: document.querySelector('#app').children.length,
          });
        })()`,
        returnByValue: true,
      });
      samples.push(JSON.parse(r.result.value));
    } catch {}
  }, 120);

  // execute scroll steps
  for (const step of scrollSteps) {
    const r = await client.send("Runtime.evaluate", { expression: step, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) consoleErrors.push("[step exception] " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    await sleep(300);
  }

  await sleep(1500);
  clearInterval(sampling);
  console.log(`\n===== scenario: ${name} =====`);
  console.log("console errors:", consoleErrors.length ? consoleErrors : "(none)");
  console.log("exceptions:", exceptions.length ? exceptions : "(none)");
  console.log("samples (first 3 / last 6):");
  console.log(samples.slice(0, 3));
  console.log(samples.slice(-6));
  const last = samples[samples.length - 1] || {};
  console.log("final errToasts:", last.errToasts, "loadingMasks:", last.loadingMasks);

  client.close();
  chrome.kill();
  await rm(userDir, { recursive: true, force: true });
}

/* ---------- scenarios ---------- */
const overscrollWheel = `
(async () => {
  const c = document.querySelector('.bk-content');
  c.scrollTop = c.scrollHeight;
  for (let i = 0; i < 200; i++) {
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, clientX: 700, clientY: 500 }));
    window.scrollBy(0, 120);
    await new Promise(r => requestAnimationFrame(r));
  }
  return 'overscroll done';
})()
`;

const wheelDownOnly = `
(async () => {
  const c = document.querySelector('.bk-content');
  c.scrollTop = c.scrollHeight;
  for (let i = 0; i < 300; i++) {
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true, clientX: 700, clientY: 500 }));
    await new Promise(r => requestAnimationFrame(r));
  }
  return 'wheel done';
})()
`;

const resizeLoop = `
(async () => {
  const c = document.querySelector('.bk-content');
  c.scrollTop = c.scrollHeight;
  for (let i = 0; i < 60; i++) {
    window.dispatchEvent(new Event('resize'));
    await new Promise(r => requestAnimationFrame(r));
  }
  return 'resize done';
})()
`;

const gotoTransactions = async (client) => {
  await client.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('.bk-menu-item')[1].click()`, returnByValue: true,
  });
  await sleep(1200);
  // maybe navigate several pages
  for (let p = 0; p < 5; p++) {
    await client.send("Runtime.evaluate", {
      expression: `(() => { const btns = document.querySelectorAll('.el-pagination .btn-next'); if (btns.length && !btns[0].disabled) btns[0].click(); return 'next'; })()`,
      returnByValue: true,
    });
    await sleep(600);
  }
};

try {
  await runScenario("dashboard: scroll to bottom + overscroll wheel", null, [overscrollWheel]);
  await runScenario("transactions: browse pages + overscroll wheel", gotoTransactions, [wheelDownOnly, overscrollWheel]);
  await runScenario("dashboard: scroll to bottom + resize storm", null, [wheelDownOnly, resizeLoop]);
} finally {
  server.close();
  process.exit(0);
}
