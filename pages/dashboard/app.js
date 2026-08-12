/* ============================================================
 * 记账插件 WebUI - Vue3 + Element Plus + Chart.js
 * 设计风格：Apple iOS 26 "Liquid Glass" 液体玻璃
 * 特色：随机二次元壁纸背景 + 玻璃拟态 + 弹性动效
 * ============================================================ */

const { createApp, ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } = Vue;
const ElMessage = ElementPlus.ElMessage;
const ElMessageBox = ElementPlus.ElMessageBox;

/* -------------------- 安全存储 --------------------
 * AstrBot Dashboard 插件页运行在 sandbox iframe 中（无 allow-same-origin），
 * 直接访问 window.localStorage 会抛 SecurityError 导致组件 setup 中断。
 * 这里做一次能力探测：可用则用 localStorage，否则降级为内存存储。
 */
const safeStorage = (() => {
  try {
    const probe = "__bk_storage_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch (e) {
    const mem = Object.create(null);
    return {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; },
      clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
    };
  }
})();

/* -------------------- Bridge API 封装 -------------------- */
const bridge = window.AstrBotPluginPage;
let _pluginName = "";
let _currency = "¥";

/* 把参数转成可结构化克隆的普通对象。
 * AstrBot 插件页 bridge 底层用 window.postMessage 通信，消息必须可结构化克隆；
 * 直接把 Vue reactive 代理（如 dialog.form）传进去会抛
 * "could not be cloned"，这里统一先序列化一次再发送。
 */
function toPlain(value) {
  if (value === undefined || value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return value;
  }
}

async function apiGet(endpoint, params) {
  try {
    return await bridge.apiGet(endpoint, toPlain(params));
  } catch (e) {
    console.error("apiGet", endpoint, e);
    throw e;
  }
}
async function apiPost(endpoint, body) {
  try {
    return await bridge.apiPost(endpoint, toPlain(body));
  } catch (e) {
    console.error("apiPost", endpoint, e);
    throw e;
  }
}

/* -------------------- 工具函数 -------------------- */
function fmtMoney(v, withUnit = true) {
  const n = Number(v || 0);
  const s = n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withUnit ? `${_currency}${s}` : s;
}
const TYPE_LABEL = { expense: "支出", income: "收入", transfer: "转账" };
const ACC_TYPE_LABEL = {
  cash: "现金", bank: "银行卡", alipay: "支付宝", wechat: "微信",
  credit: "信用卡", other: "其他"
};

/* 分类图标预设：点击选择，再点可取消；也可自定义或留空 */
const EMOJI_PRESET = [
  "🍚","🍜","🍔","🍕","🍣","🍰","🍺","☕","🍎","🥗",
  "🚕","🚌","🚇","✈️","🚗","⛽","🛒","🛍️","👗","💄",
  "🏠","🛏️","💡","🎮","🎬","🎵","⚽","🎲","💊","🏥",
  "📚","✏️","🎓","📱","💻","⌚","💰","📈","🎁","💼",
  "🧧","🐱","🌸","⭐","❤️","🔥","💳","🧸"
];

/* 交易类型颜色：适配深浅主题 */
function typeColor(type) {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const light = { expense: "#E0352B", income: "#1FA55A", transfer: "#D97E00" };
  const dk = { expense: "#FF453A", income: "#32D74B", transfer: "#FF9F0A" };
  return (dark ? dk : light)[type] || "#8E8E93";
}

/* 是否为移动端（用于图表布局等响应式判断） */
function isMobile() {
  return (window.innerWidth || document.documentElement.clientWidth) <= 640;
}

/* ============================================================
 * 随机二次元背景管理器
 * 背景图 API 可在插件配置 anime_bg_api 中自由指定（逗号分隔）：
 *   - 直接返回图片的接口（如 https://.../random.jpg）
 *   - 返回 JSON 的接口（自动提取 url / imgurl / image / data.url）
 * 留空时使用内置默认源。
 * ============================================================ */
const DEFAULT_BG_SOURCES = [
  "https://api.btstu.cn/sjbz/api.php?lx=dongman",
  "https://t.alcy.cc/pc/",
  "https://www.dmoe.cc/random.php",
  "https://api.anosu.top/img",
  "https://api.vvhan.com/api/acgimg",
];

let BG_SOURCES = [...DEFAULT_BG_SOURCES];

/* 解析配置里的 API 列表：
 * - list 类型配置：直接是字符串数组
 * - 兼容逗号/分号/换行分隔的字符串写法
 * 返回空数组表示未配置。
 */
function parseBgSources(cfgVal) {
  if (!cfgVal) return [];
  let list = [];
  if (Array.isArray(cfgVal)) {
    list = cfgVal;
  } else if (typeof cfgVal === "string") {
    list = String(cfgVal).split(/[,，;\n]/);
  } else {
    return [];
  }
  return list.map(s => String(s).trim()).filter(s => /^https?:\/\//i.test(s));
}

/* 从配置更新背景源；配置为空则回退内置默认 */
function applyBgConfig(cfg) {
  const custom = parseBgSources(cfg?.anime_bg_api);
  BG_SOURCES = custom.length ? custom : [...DEFAULT_BG_SOURCES];
}

/* 解析一张二次元图。先尝试 JSON 接口，再尝试直接图片。 */
async function fetchRandomAnimeBg() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const src = BG_SOURCES[Math.floor(Math.random() * BG_SOURCES.length)];
    const url = await tryResolveBg(src);
    if (url) return url;
  }
  return null;
}

/* 尝试把单个 API 解析为可用的图片 URL */
async function tryResolveBg(src) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(src, { signal: ctrl.signal, headers: { Accept: "image/*,*/*" } });
    clearTimeout(timer);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("json") || ct.includes("text") || res.redirected === false) {
      // 可能是 JSON 接口：尝试解析出图片地址
      const data = await res.json().catch(() => null);
      const url = pickImageUrl(data);
      if (url && (await verifyImage(url))) return url;
    }
    // 直接返回图片（重定向到图床）
    const finalUrl = res.url || src;
    if (await verifyImage(finalUrl)) return finalUrl;
  } catch (e) {
    // fetch 失败（CORS/网络）：退回直接图片方式
    if (await verifyImage(src)) return src;
  }
  return null;
}

/* 从 JSON 结构里提取图片 URL（支持常见字段） */
function pickImageUrl(data) {
  if (!data) return null;
  const hit = (v) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    return null;
  };
  if (Array.isArray(data)) return hit(data[0]);
  if (typeof data === "object") {
    const keys = ["url", "imgurl", "image", "pic", "img", "src", "data"];
    for (const k of keys) {
      const v = data[k];
      if (v) {
        const u = hit(v);
        if (u) return u;
        if (Array.isArray(v)) return hit(v[0]);
        if (typeof v === "object") {
          const u2 = pickImageUrl(v);
          if (u2) return u2;
        }
      }
    }
  }
  return null;
}

/* 预加载验证图片可访问 */
function verifyImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ""; resolve(false); }, 15000);
    img.onload = () => { clearTimeout(timer); resolve(true); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = url;
  });
}

/* ============================================================
 * 组件：仪表盘（含报表：今日/本周/本月/上月/今年/自定义区间）
 * ============================================================ */
const DashboardView = {
  template: `
    <div v-loading="loading">
      <div class="bk-toolbar">
        <el-radio-group v-model="period" @change="onPeriodChange">
          <el-radio-button label="today">今日</el-radio-button>
          <el-radio-button label="this_week">本周</el-radio-button>
          <el-radio-button label="this_month">本月</el-radio-button>
          <el-radio-button label="last_month">上月</el-radio-button>
          <el-radio-button label="this_year">今年</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="customRange" type="daterange" range-separator="-"
          start-placeholder="开始日期" end-placeholder="结束日期" value-format="YYYY-MM-DD"
          style="width:236px" @change="onCustomRange" />
        <div style="flex:1"></div>
        <button class="pill-btn" @click="load"><el-icon><Refresh /></el-icon>刷新</button>
      </div>

      <div class="bk-stat-grid">
        <div class="bk-card bk-stat-card expense">
          <div class="bk-stat-head">
            <div class="bk-stat-icon expense"><el-icon class="ico"><Wallet /></el-icon></div>
            <span class="bk-stat-trend">{{ rangeLabel }}</span>
          </div>
          <div class="bk-card-title">支出</div>
          <div class="bk-card-value">{{ fmtMoney(summary.total_expense) }}</div>
          <div class="bk-stat-sub">共 {{ summary.tx_count || 0 }} 笔</div>
        </div>
        <div class="bk-card bk-stat-card income">
          <div class="bk-stat-head">
            <div class="bk-stat-icon income"><el-icon class="ico"><Coin /></el-icon></div>
            <span class="bk-stat-trend">{{ rangeLabel }}</span>
          </div>
          <div class="bk-card-title">收入</div>
          <div class="bk-card-value">{{ fmtMoney(summary.total_income) }}</div>
          <div class="bk-stat-sub">全部入账资金</div>
        </div>
        <div class="bk-card bk-stat-card balance">
          <div class="bk-stat-head">
            <div class="bk-stat-icon balance"><el-icon class="ico"><PieChart /></el-icon></div>
            <span class="bk-stat-trend">结余</span>
          </div>
          <div class="bk-card-title">结余</div>
          <div class="bk-card-value">{{ fmtMoney(summary.balance) }}</div>
          <div class="bk-stat-sub">收入 - 支出</div>
        </div>
        <div class="bk-card bk-stat-card assets">
          <div class="bk-stat-head">
            <div class="bk-stat-icon assets"><el-icon class="ico"><CreditCard /></el-icon></div>
            <span class="bk-stat-trend">净资产</span>
          </div>
          <div class="bk-card-title">资产总额</div>
          <div class="bk-card-value">{{ fmtMoney(totalAssets) }}</div>
          <div class="bk-stat-sub">{{ accounts.length }} 个账户</div>
        </div>
      </div>

      <div class="bk-chart-grid">
        <div class="bk-card bk-chart-card">
          <div class="header"><span class="name"><span class="ico"><el-icon><TrendCharts /></el-icon></span>每日支出趋势</span></div>
          <div class="chart-wrap"><canvas ref="dailyCanvas"></canvas></div>
        </div>
        <div class="bk-card bk-chart-card">
          <div class="header"><span class="name"><span class="ico"><el-icon><PieChart /></el-icon></span>支出分类占比</span></div>
          <div class="chart-wrap"><canvas ref="pieCanvas"></canvas></div>
        </div>
      </div>
      <div class="bk-chart-grid">
        <div class="bk-card bk-chart-card">
          <div class="header"><span class="name"><span class="ico"><el-icon><PieChart /></el-icon></span>收入分类占比</span></div>
          <div class="chart-wrap"><canvas ref="incPie"></canvas></div>
        </div>
        <div class="bk-card bk-chart-card">
          <div class="header"><span class="name"><span class="ico"><el-icon><DataLine /></el-icon></span>每日收支对比</span></div>
          <div class="chart-wrap"><canvas ref="dailyBoth"></canvas></div>
        </div>
      </div>

      <div class="bk-chart-grid">
        <div class="bk-card bk-table-card">
          <div class="header"><span class="title"><span class="title-ico"><el-icon><Trophy /></el-icon></span>Top 5 支出</span></div>
          <el-table :data="top" size="small">
            <el-table-column type="index" width="50" />
            <el-table-column label="金额" min-width="130"><template #default="{row}"><b :style="{color: typeColor('expense'), fontVariantNumeric:'tabular-nums'}">{{ fmtMoney(row.amount) }}</b></template></el-table-column>
            <el-table-column prop="category_name" label="分类" min-width="110" show-overflow-tooltip />
            <el-table-column prop="tx_date" label="日期" min-width="110" />
            <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
          </el-table>
        </div>
        <div class="bk-card bk-table-card">
          <div class="header"><span class="title"><span class="title-ico"><el-icon><CollectionTag /></el-icon></span>标签统计</span></div>
          <el-table :data="tags" size="small">
            <el-table-column label="标签" min-width="130"><template #default="{row}"><b>#{{ row.name }}</b></template></el-table-column>
            <el-table-column label="金额" min-width="130"><template #default="{row}"><span style="font-variant-numeric:tabular-nums">{{ fmtMoney(row.amount) }}</span></template></el-table-column>
            <el-table-column prop="count" label="笔数" min-width="70" />
          </el-table>
        </div>
      </div>

      <div class="bk-card bk-table-card">
        <div class="header">
          <span class="title"><span class="title-ico"><el-icon><List /></el-icon></span>最近交易</span>
          <button class="pill-btn ghost" @click="$emit('navigate','transactions')">查看全部 →</button>
        </div>
        <el-table :data="recent" stripe :show-header="true" size="default">
          <el-table-column label="类型" min-width="96">
            <template #default="{row}">
              <span class="type-tag" :class="row.type">{{ TYPE_LABEL[row.type] }}</span>
            </template>
          </el-table-column>
          <el-table-column label="金额" min-width="140">
            <template #default="{row}">
              <span :style="{color: typeColor(row.type), fontWeight:700, fontVariantNumeric:'tabular-nums'}">{{ fmtMoney(row.amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="category_name" label="分类" min-width="120" show-overflow-tooltip />
          <el-table-column prop="account_name" label="账户" min-width="120" show-overflow-tooltip />
          <el-table-column prop="note" label="备注" min-width="180" show-overflow-tooltip />
          <el-table-column label="日期" min-width="150">
            <template #default="{row}"><span style="font-variant-numeric:tabular-nums; white-space:nowrap">{{ row.tx_date }} {{ (row.tx_time||'').slice(0,5) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  `,
  emits: ["navigate"],
  setup() {
    const loading = ref(false);
    const period = ref("this_month");
    const customRange = ref([]);
    const summary = reactive({ total_expense: 0, total_income: 0, balance: 0, tx_count: 0 });
    const recent = ref([]);
    const accounts = ref([]);
    const top = ref([]);
    const tags = ref([]);
    const dailyCanvas = ref(null), pieCanvas = ref(null), incPie = ref(null), dailyBoth = ref(null);
    let charts = [];

    const totalAssets = computed(() =>
      accounts.value.reduce((s, a) => s + Number(a.balance || 0), 0)
    );
    const rangeLabel = computed(() => {
      if (customRange.value?.length === 2) return "自定义";
      return { today: "今日", this_week: "本周", this_month: "本月", last_month: "上月", this_year: "今年" }[period.value] || "本月";
    });

    function resolveRange() {
      if (customRange.value?.length === 2) return [customRange.value[0], customRange.value[1]];
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      switch (period.value) {
        case "today": { const t = fmt(now); return [t, t]; }
        case "this_week": { const s = new Date(now); s.setDate(now.getDate() - now.getDay()); return [fmt(s), fmt(now)]; }
        case "this_month": { const s = new Date(now.getFullYear(), now.getMonth(), 1); const e = new Date(now.getFullYear(), now.getMonth() + 1, 0); return [fmt(s), fmt(e)]; }
        case "last_month": { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 0); return [fmt(s), fmt(e)]; }
        case "this_year": return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
        default: return [null, null];
      }
    }
    function onCustomRange() {
      if (customRange.value?.length === 2) load();
    }
    function onPeriodChange() {
      // 切换预设周期时清空自定义区间，避免优先命中旧的自定义日期
      customRange.value = [];
    }

    function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }

    function destroyChart(canvas) {
      const i = charts.findIndex(c => c.canvas === canvas);
      if (i >= 0) { charts[i].destroy(); charts.splice(i, 1); }
    }

    function renderLine(canvas, rows) {
      if (!canvas) return;
      destroyChart(canvas);
      const labels = rows.map(r => r.tx_date ? r.tx_date.slice(5) : "");
      const data = rows.map(r => Number(r.amount || 0));
      const ctx = canvas.getContext("2d");
      const dark = isDark();
      const grad = ctx.createLinearGradient(0, 0, 0, 260);
      grad.addColorStop(0, dark ? "rgba(255,69,58,0.35)" : "rgba(255,59,48,0.28)");
      grad.addColorStop(1, dark ? "rgba(255,69,58,0.02)" : "rgba(255,59,48,0.01)");
      const axisColor = dark ? "#8A8A94" : "#9A9AA2";
      const chart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets: [{
          label: "支出", data, borderColor: dark ? "#FF453A" : "#FF3B30",
          backgroundColor: grad, tension: 0.4, fill: true,
          pointRadius: 3, pointBackgroundColor: dark ? "#FF453A" : "#FF3B30",
          pointBorderColor: "rgba(255,255,255,0.9)", pointBorderWidth: 2, pointHoverRadius: 6
        }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: {
            backgroundColor: dark ? "rgba(44,46,60,0.92)" : "rgba(255,255,255,0.92)",
            titleColor: dark ? "#F2F3F7" : "#1D1D1F", bodyColor: dark ? "#C8C9D2" : "#5A5A62",
            borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.6)",
            borderWidth: 1, cornerRadius: 12, padding: 12
          } },
          scales: {
            y: { beginAtZero: true, ticks: { color: axisColor, font: { size: 11 } }, grid: { color: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)" } },
            x: { ticks: { color: axisColor, font: { size: 11 } }, grid: { display: false } }
          }
        }
      });
      chart.canvas = canvas;
      charts.push(chart);
    }

    function renderPie(canvas, rows, palette) {
      if (!canvas) return;
      destroyChart(canvas);
      const labels = rows.map(r => r.name || "未分类");
      const data = rows.map(r => Number(r.amount || 0));
      const dark = isDark();
      const chart = new Chart(canvas.getContext("2d"), {
        type: "doughnut",
        data: { labels, datasets: [{ data, backgroundColor: palette, borderWidth: 3, borderColor: dark ? "rgba(28,30,40,0.9)" : "rgba(255,255,255,0.9)", hoverOffset: 8 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: "62%",
          plugins: { legend: {
            position: isMobile() ? "bottom" : "right",
            labels: { color: dark ? "#C8C9D2" : "#5A5A62", font: { size: 12 }, padding: 12, usePointStyle: true, pointStyleWidth: 8, boxWidth: 8, boxHeight: 8 }
          } }
        }
      });
      chart.canvas = canvas;
      charts.push(chart);
    }

    function renderDailyBoth(canvas, expRows, incRows) {
      if (!canvas) return;
      destroyChart(canvas);
      const dateSet = new Set([
        ...(expRows || []).map(r => r.tx_date),
        ...(incRows || []).map(r => r.tx_date)
      ]);
      const labels = [...dateSet].sort();
      const expMap = Object.fromEntries((expRows || []).map(r => [r.tx_date, Number(r.amount || 0)]));
      const incMap = Object.fromEntries((incRows || []).map(r => [r.tx_date, Number(r.amount || 0)]));
      const dark = isDark();
      const axisColor = dark ? "#8A8A94" : "#9A9AA2";
      const chart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: { labels: labels.map(d => d ? d.slice(5) : ""), datasets: [
          { label: "支出", data: labels.map(d => expMap[d] || 0), backgroundColor: dark ? "#FF453A" : "#FF3B30", borderRadius: 6, borderSkipped: false },
          { label: "收入", data: labels.map(d => incMap[d] || 0), backgroundColor: dark ? "#32D74B" : "#28C76F", borderRadius: 6, borderSkipped: false }
        ] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: dark ? "#C8C9D2" : "#5A5A62", font: { size: 11 }, usePointStyle: true, pointStyleWidth: 8, boxWidth: 8, boxHeight: 8 } }, tooltip: {
            backgroundColor: dark ? "rgba(44,46,60,0.92)" : "rgba(255,255,255,0.92)",
            titleColor: dark ? "#F2F3F7" : "#1D1D1F", bodyColor: dark ? "#C8C9D2" : "#5A5A62",
            borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.6)",
            borderWidth: 1, cornerRadius: 12, padding: 12
          } },
          scales: {
            y: { beginAtZero: true, ticks: { color: axisColor, font: { size: 11 } }, grid: { color: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)" } },
            x: { ticks: { color: axisColor, font: { size: 11 } }, grid: { display: false } }
          }
        }
      });
      chart.canvas = canvas;
      charts.push(chart);
    }

    async function load() {
      loading.value = true;
      try {
        const [sd, ed] = resolveRange();
        const res = await apiGet("stats/dashboard", { start_date: sd || undefined, end_date: ed || undefined });
        const d = res.data || res;
        Object.assign(summary, d.summary || {});
        recent.value = d.recent_transactions || [];
        accounts.value = d.accounts || [];
        top.value = d.top_expense || [];
        tags.value = d.tag_stats || [];
        await nextTick();
        const expPalette = isDark()
          ? ["#FF453A","#FF9F0A","#32D74B","#0A84FF","#BF5AF2","#FF375F","#64D2FF","#30D158","#98989D","#AC8E68"]
          : ["#FF3B30","#FF9F0A","#28C76F","#0A84FF","#AF52DE","#FF2D55","#5AC8FA","#34C759","#8E8E93","#A2845E"];
        const incPalette = isDark()
          ? ["#32D74B","#64D2FF","#FF9F0A","#0A84FF","#FF375F","#30D158","#BF5AF2"]
          : ["#28C76F","#5AC8FA","#FF9F0A","#0A84FF","#FF2D55","#34C759","#AF52DE"];
        renderLine(dailyCanvas.value, d.daily_expense || []);
        renderPie(pieCanvas.value, d.categories_expense || [], expPalette);
        renderPie(incPie.value, d.categories_income || [], incPalette);
        renderDailyBoth(dailyBoth.value, d.daily_expense || [], d.daily_income || []);
      } catch (e) {
        ElMessage.error("加载仪表盘失败：" + e.message);
      } finally {
        loading.value = false;
      }
    }

    watch(period, load);
    onMounted(load);
    return {
      loading, period, customRange, rangeLabel, summary, recent, accounts,
      top, tags, totalAssets,
      dailyCanvas, pieCanvas, incPie, dailyBoth,
      fmtMoney, typeColor, TYPE_LABEL,
      onCustomRange, onPeriodChange, load,
    };
  }
};

/* ============================================================
 * 组件：交易管理
 * ============================================================ */
const TransactionsView = {
  template: `
    <div v-loading="loading">
      <div class="bk-card bk-table-card">
        <div class="header">
          <span class="title"><span class="title-ico"><el-icon><Tickets /></el-icon></span>交易管理</span>
          <button class="pill-btn primary" @click="openCreate"><el-icon><Plus /></el-icon>新增交易</button>
        </div>
        <div class="bk-filter-bar">
          <el-select v-model="filter.type" placeholder="类型" clearable style="width:110px">
            <el-option label="支出" value="expense" /><el-option label="收入" value="income" /><el-option label="转账" value="transfer" />
          </el-select>
          <el-select v-model="filter.category_id" placeholder="分类" clearable filterable style="width:130px">
            <el-option v-for="c in categories" :key="c.id" :label="(c.icon||'')+' '+c.name" :value="c.id" />
          </el-select>
          <el-select v-model="filter.account_id" placeholder="账户" clearable style="width:130px">
            <el-option v-for="a in accounts" :key="a.id" :label="a.name" :value="a.id" />
          </el-select>
          <el-date-picker v-model="dateRange" type="daterange" range-separator="-"
            start-placeholder="开始" end-placeholder="结束" value-format="YYYY-MM-DD" style="width:240px" />
          <el-input v-model="filter.keyword" placeholder="备注关键字" clearable style="width:160px" />
          <button class="pill-btn" @click="search"><el-icon><Search /></el-icon>筛选</button>
          <button class="pill-btn ghost" @click="resetFilter"><el-icon><RefreshLeft /></el-icon>重置</button>
          <div style="flex:1"></div>
          <button class="pill-btn ghost" @click="exportCsv"><el-icon><Download /></el-icon>导出 CSV</button>
        </div>
        <el-table :data="items" stripe @row-dblclick="openEdit">
          <el-table-column label="类型" min-width="96">
            <template #default="{row}"><span class="type-tag" :class="row.type">{{ TYPE_LABEL[row.type] }}</span></template>
          </el-table-column>
          <el-table-column label="金额" min-width="140">
            <template #default="{row}"><span :style="{color: typeColor(row.type), fontWeight:700, fontVariantNumeric:'tabular-nums'}">{{ fmtMoney(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column label="分类" min-width="130" show-overflow-tooltip>
            <template #default="{row}">{{ row.category_name ? (row.category_name) : '-' }}</template>
          </el-table-column>
          <el-table-column label="账户" min-width="160" show-overflow-tooltip>
            <template #default="{row}">
              {{ row.account_name }}
              <span v-if="row.type==='transfer' && row.to_account_name" class="bk-list-sub"> → {{ row.to_account_name }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="note" label="备注" min-width="200" show-overflow-tooltip />
          <el-table-column label="日期" min-width="160">
            <template #default="{row}"><span style="font-variant-numeric:tabular-nums; white-space:nowrap">{{ row.tx_date }} {{ (row.tx_time||'').slice(0,5) }}</span></template>
          </el-table-column>
          <el-table-column label="标签" min-width="130">
            <template #default="{row}">
              <el-tag v-for="t in row.tags" :key="t" size="small" effect="plain" style="margin-right:4px">#{{ t }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130">
            <template #default="{row}">
              <el-button text type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button text type="danger" @click="del(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div style="padding:14px 22px; display:flex; justify-content:flex-end">
          <el-pagination background layout="prev, pager, next" :total="total" :page-size="pageSize" v-model:current-page="page" @current-change="load" />
        </div>
      </div>

      <el-dialog v-model="dialog.visible" :title="dialog.id ? '编辑交易' : '新增交易'" width="520px">
        <el-form :model="dialog.form" label-width="80px" size="default">
          <el-form-item label="类型">
            <el-radio-group v-model="dialog.form.type">
              <el-radio-button label="expense">支出</el-radio-button>
              <el-radio-button label="income">收入</el-radio-button>
              <el-radio-button label="transfer">转账</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="金额">
            <el-input-number v-model="dialog.form.amount" :min="0.01" :precision="2" :step="10" style="width:200px" />
          </el-form-item>
          <el-form-item label="分类" v-if="dialog.form.type!=='transfer'">
            <el-select v-model="dialog.form.category_id" clearable filterable allow-create style="width:100%">
              <el-option v-for="c in filteredCats" :key="c.id" :label="(c.icon||'')+' '+c.name" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="账户">
            <el-select v-model="dialog.form.account_id" filterable style="width:100%">
              <el-option v-for="a in accounts" :key="a.id" :label="a.name+' ('+(accTypeLabel[a.type]||a.type)+')'" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="转入账户" v-if="dialog.form.type==='transfer'">
            <el-select v-model="dialog.form.to_account_id" filterable style="width:100%">
              <el-option v-for="a in accounts" :key="a.id" :label="a.name" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="日期">
            <el-date-picker v-model="dialog.form.tx_date" type="date" value-format="YYYY-MM-DD" style="width:100%" />
          </el-form-item>
          <el-form-item label="时间">
            <el-time-picker v-model="dialog.form.tx_time" value-format="HH:mm:ss" format="HH:mm:ss" style="width:100%" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="dialog.form.note" type="textarea" :rows="2" />
          </el-form-item>
          <el-form-item label="标签">
            <el-input v-model="dialog.tagsInput" placeholder="逗号分隔，如 出差,聚餐" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="dialog.saving" @click="save">保存</el-button>
        </template>
      </el-dialog>
    </div>
  `,
  setup() {
    const loading = ref(false);
    const items = ref([]);
    const total = ref(0);
    const page = ref(1);
    const pageSize = 20;
    const categories = ref([]);
    const accounts = ref([]);
    const dateRange = ref([]);
    const filter = reactive({ type: "", category_id: null, account_id: null, keyword: "" });
    const dialog = reactive({
      visible: false, id: null, saving: false,
      form: { type: "expense", amount: 0, category_id: null, account_id: null, to_account_id: null, tx_date: "", tx_time: "", note: "" },
      tagsInput: ""
    });

    const filteredCats = computed(() =>
      categories.value.filter(c => c.type === dialog.form.type)
    );
    const accTypeLabel = ACC_TYPE_LABEL;

    async function load() {
      loading.value = true;
      try {
        const params = {
          limit: pageSize, offset: (page.value - 1) * pageSize,
          type: filter.type || undefined,
          category_id: filter.category_id || undefined,
          account_id: filter.account_id || undefined,
          keyword: filter.keyword || undefined,
          start_date: dateRange.value?.[0] || undefined,
          end_date: dateRange.value?.[1] || undefined,
        };
        const res = await apiGet("transactions", params);
        const data = res.data || res;
        items.value = data.items || [];
        total.value = data.total || 0;
      } catch (e) {
        ElMessage.error("加载失败：" + e.message);
      } finally { loading.value = false; }
    }

    async function loadMeta() {
      const [cats, accs] = await Promise.all([apiGet("categories"), apiGet("accounts")]);
      categories.value = (cats.data || cats).items || [];
      accounts.value = (accs.data || accs).items || [];
    }

    function search() { page.value = 1; load(); }
    function resetFilter() {
      Object.assign(filter, { type: "", category_id: null, account_id: null, keyword: "" });
      dateRange.value = [];
      search();
    }

    function openCreate() {
      dialog.id = null;
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      Object.assign(dialog.form, {
        type: "expense", amount: 0, category_id: null,
        account_id: accounts.value[0]?.id || null, to_account_id: null,
        // 用本地时间而非 toISOString()（UTC），避免东八区晚间日期少一天
        tx_date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        tx_time: now.toTimeString().slice(0, 8),
        note: ""
      });
      dialog.tagsInput = "";
      dialog.visible = true;
    }
    function openEdit(row) {
      dialog.id = row.id;
      Object.assign(dialog.form, {
        type: row.type, amount: row.amount,
        category_id: row.category_id, account_id: row.account_id,
        to_account_id: row.to_account_id, tx_date: row.tx_date,
        tx_time: row.tx_time, note: row.note || ""
      });
      dialog.tagsInput = (row.tags || []).join(",");
      dialog.visible = true;
    }

    async function save() {
      if (!dialog.form.amount || dialog.form.amount <= 0) {
        ElMessage.warning("金额必须大于 0"); return;
      }
      if (!dialog.form.account_id) { ElMessage.warning("请选择账户"); return; }
      if (dialog.form.type === "transfer" && !dialog.form.to_account_id) {
        ElMessage.warning("请选择转入账户"); return;
      }
      dialog.saving = true;
      try {
        const tags = dialog.tagsInput.split(",").map(s => s.trim()).filter(Boolean);
        const body = { ...dialog.form, tags };
        if (dialog.id) {
          body.id = dialog.id;
          await apiPost("transactions/update", body);
          ElMessage.success("已更新");
        } else {
          await apiPost("transactions/create", body);
          ElMessage.success("已新增");
        }
        dialog.visible = false;
        load();
      } catch (e) {
        ElMessage.error("保存失败：" + e.message);
      } finally { dialog.saving = false; }
    }

    async function del(row) {
      try {
        await ElMessageBox.confirm(`确认删除该笔 ${TYPE_LABEL[row.type]} ${fmtMoney(row.amount)} 交易？`, "提示", { type: "warning" });
        await apiPost("transactions/delete", { id: row.id });
        ElMessage.success("已删除");
        load();
      } catch (e) { /* cancelled */ }
    }

    async function exportCsv() {
      const params = new URLSearchParams();
      if (filter.type) params.append("type", filter.type);
      if (dateRange.value?.[0]) params.append("start_date", dateRange.value[0]);
      if (dateRange.value?.[1]) params.append("end_date", dateRange.value[1]);
      const q = params.toString();
      const endpoint = "export/csv" + (q ? "?" + q : "");
      // 沙箱 iframe 可能禁用 window.open，改用 bridge.download 触发浏览器下载
      try {
        await bridge.download(endpoint, {}, "transactions.csv");
      } catch (e) {
        ElMessage.error("导出失败：" + (e.message || e));
      }
    }

    onMounted(async () => { await loadMeta(); await load(); });
    return {
      loading, items, total, page, pageSize, categories, accounts,
      filter, dateRange, dialog, filteredCats, accTypeLabel,
      load, search, resetFilter, openCreate, openEdit, save, del, exportCsv,
      fmtMoney, typeColor, TYPE_LABEL
    };
  }
};

/* ============================================================
 * 组件：分类管理
 * ============================================================ */
const CategoriesView = {
  template: `
    <div v-loading="loading">
      <div class="bk-toolbar">
        <el-radio-group v-model="typeFilter">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button label="expense">支出</el-radio-button>
          <el-radio-button label="income">收入</el-radio-button>
        </el-radio-group>
        <div style="flex:1"></div>
        <button class="pill-btn primary" @click="openCreate"><el-icon><Plus /></el-icon>新增分类</button>
      </div>
      <div class="bk-list-grid">
        <div v-for="c in filtered" :key="c.id" class="bk-card bk-list-card">
          <div class="bk-cat-icon" :style="{background: c.color ? c.color+'22' : 'rgba(10,132,255,0.14)'}">
            {{ c.icon || '📁' }}
          </div>
          <div class="bk-list-info">
            <div class="bk-list-name">{{ c.name }}</div>
            <div class="bk-list-sub"><span class="type-tag" :class="c.type">{{ c.type==='expense'?'支出':'收入' }}</span></div>
          </div>
          <div class="bk-list-actions">
            <el-button text type="primary" @click="openEdit(c)">编辑</el-button>
            <el-button text type="danger" @click="del(c)">删除</el-button>
          </div>
        </div>
      </div>
      <div v-if="!filtered.length" class="bk-empty"><span class="emoji">📭</span>暂无分类</div>

      <el-dialog v-model="dialog.visible" :title="dialog.id ? '编辑分类' : '新增分类'" width="420px">
        <el-form :model="dialog.form" label-width="70px">
          <el-form-item label="名称"><el-input v-model="dialog.form.name" /></el-form-item>
          <el-form-item label="类型">
            <el-radio-group v-model="dialog.form.type" :disabled="!!dialog.id">
              <el-radio label="expense">支出</el-radio><el-radio label="income">收入</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="图标">
            <div class="bk-emoji-grid">
              <button v-for="e in EMOJI_PRESET" :key="e" type="button" class="bk-emoji-item"
                      :class="{ active: dialog.form.icon === e }" :title="e" @click="toggleIcon(e)">
                {{ e }}
              </button>
            </div>
            <div class="bk-emoji-actions">
              <el-input v-model="dialog.form.icon" placeholder="自定义 emoji（可留空）" clearable style="width:200px" />
              <el-button size="small" @click="dialog.form.icon = ''">不设置</el-button>
            </div>
          </el-form-item>
          <el-form-item label="颜色">
            <el-color-picker v-model="dialog.form.color" />
          </el-form-item>
          <el-form-item label="排序"><el-input-number v-model="dialog.form.sort" :min="0" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="dialog.saving" @click="save">保存</el-button>
        </template>
      </el-dialog>
    </div>
  `,
  setup() {
    const loading = ref(false);
    const items = ref([]);
    const typeFilter = ref("");
    const filtered = computed(() => typeFilter.value ? items.value.filter(c => c.type === typeFilter.value) : items.value);
    const dialog = reactive({
      visible: false, id: null, saving: false,
      form: { name: "", type: "expense", icon: "", color: "", sort: 0 }
    });

    async function load() {
      loading.value = true;
      try {
        const res = await apiGet("categories");
        items.value = (res.data || res).items || [];
      } catch (e) { ElMessage.error("加载失败"); }
      finally { loading.value = false; }
    }
    function openCreate() {
      dialog.id = null;
      Object.assign(dialog.form, { name: "", type: "expense", icon: "", color: "#0A84FF", sort: 50 });
      dialog.visible = true;
    }
    function toggleIcon(e) {
      // 点击选中的图标再次点击则取消（留空）
      dialog.form.icon = dialog.form.icon === e ? "" : e;
    }
    function openEdit(c) {
      dialog.id = c.id;
      Object.assign(dialog.form, { name: c.name, type: c.type, icon: c.icon || "", color: c.color || "", sort: c.sort });
      dialog.visible = true;
    }
    async function save() {
      if (!dialog.form.name.trim()) { ElMessage.warning("请输入名称"); return; }
      dialog.saving = true;
      try {
        if (dialog.id) {
          await apiPost("categories/update", { ...dialog.form, id: dialog.id });
        } else {
          await apiPost("categories/create", dialog.form);
        }
        ElMessage.success("已保存");
        dialog.visible = false;
        load();
      } catch (e) { ElMessage.error("保存失败：" + e.message); }
      finally { dialog.saving = false; }
    }
    async function del(c) {
      try {
        await ElMessageBox.confirm(`确认删除分类「${c.name}」？相关交易的分类将被清空`, "提示", { type: "warning" });
        await apiPost("categories/delete", { id: c.id });
        ElMessage.success("已删除");
        load();
      } catch (e) {}
    }
    onMounted(load);
    return { loading, items, filtered, typeFilter, dialog, EMOJI_PRESET, toggleIcon, openCreate, openEdit, save, del };
  }
};

/* ============================================================
 * 组件：账户管理
 * ============================================================ */
const AccountsView = {
  template: `
    <div v-loading="loading">
      <div class="bk-toolbar">
        <div class="bk-total-hint">
          资产合计<b>{{ fmtMoney(totalAssets) }}</b>
        </div>
        <div style="flex:1"></div>
        <button class="pill-btn primary" @click="openCreate"><el-icon><Plus /></el-icon>新增账户</button>
      </div>
      <div class="bk-list-grid">
        <div v-for="a in items" :key="a.id" class="bk-card bk-list-card">
          <div class="bk-cat-icon" :style="{background: colorOf(a).bg}">{{ iconOf(a) }}</div>
          <div class="bk-list-info">
            <div class="bk-list-name">{{ a.name }} <el-tag v-if="a.archived" size="small" type="info">已归档</el-tag></div>
            <div class="bk-list-sub">
              <span class="acc-type-chip">{{ accTypeLabel[a.type] || a.type }}</span>
              <span class="acc-balance">{{ fmtMoney(a.balance) }}</span>
            </div>
          </div>
          <div class="bk-list-actions">
            <el-button text type="primary" @click="openAdjust(a)">对账</el-button>
            <el-button text type="warning" v-if="!a.archived" @click="archive(a, true)">归档</el-button>
            <el-button text type="success" v-else @click="archive(a, false)">恢复</el-button>
            <el-button text type="danger" @click="del(a)">删除</el-button>
          </div>
        </div>
      </div>
      <div v-if="!items.length" class="bk-empty"><span class="emoji">🏦</span>暂无账户</div>

      <el-dialog v-model="dialog.visible" :title="dialog.id ? '编辑账户' : '新增账户'" width="420px">
        <el-form :model="dialog.form" label-width="80px">
          <el-form-item label="名称"><el-input v-model="dialog.form.name" /></el-form-item>
          <el-form-item label="类型">
            <el-select v-model="dialog.form.type" style="width:100%">
              <el-option v-for="(label,key) in accTypeLabel" :key="key" :label="label" :value="key" />
            </el-select>
          </el-form-item>
          <el-form-item label="初始余额" v-if="!dialog.id">
            <el-input-number v-model="dialog.form.balance" :precision="2" :step="100" />
          </el-form-item>
          <el-form-item label="备注"><el-input v-model="dialog.form.note" type="textarea" :rows="2" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="dialog.saving" @click="save">保存</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="adjustDialog.visible" title="账户对账" width="420px">
        <el-form label-width="100px">
          <el-form-item label="账户">{{ adjustDialog.account?.name }}</el-form-item>
          <el-form-item label="当前余额">{{ fmtMoney(adjustDialog.account?.balance) }}</el-form-item>
          <el-form-item label="实际余额">
            <el-input-number v-model="adjustDialog.newBalance" :precision="2" :step="100" style="width:200px" />
          </el-form-item>
          <el-form-item label="差额">
            <span :style="{color: typeColor(diff >= 0 ? 'income' : 'expense'), fontWeight:700, fontVariantNumeric:'tabular-nums'}">
              {{ diff >= 0 ? '+' : '' }}{{ fmtMoney(diff) }}
            </span>
          </el-form-item>
          <el-form-item label="说明"><el-input v-model="adjustDialog.note" placeholder="对账原因（可选）" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="adjustDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="adjustDialog.saving" @click="saveAdjust">确认对账</el-button>
        </template>
      </el-dialog>
    </div>
  `,
  setup() {
    const loading = ref(false);
    const items = ref([]);
    const dialog = reactive({
      visible: false, id: null, saving: false,
      form: { name: "", type: "cash", balance: 0, note: "" }
    });
    const adjustDialog = reactive({
      visible: false, account: null, newBalance: 0, note: "", saving: false
    });
    const accTypeLabel = ACC_TYPE_LABEL;

    const totalAssets = computed(() => items.value.filter(a => !a.archived).reduce((s, a) => s + Number(a.balance || 0), 0));
    const diff = computed(() => Number(adjustDialog.newBalance || 0) - Number(adjustDialog.account?.balance || 0));

    const ACC_STYLE = {
      cash: { icon: "💵", bg: "rgba(40,199,111,0.16)" },
      bank: { icon: "🏦", bg: "rgba(10,132,255,0.16)" },
      alipay: { icon: "💙", bg: "rgba(10,132,255,0.16)" },
      wechat: { icon: "💚", bg: "rgba(40,199,111,0.16)" },
      credit: { icon: "💳", bg: "rgba(255,59,48,0.16)" },
      other: { icon: "🏦", bg: "rgba(10,132,255,0.14)" },
    };
    const iconOf = a => (ACC_STYLE[a.type] || ACC_STYLE.other).icon;
    const colorOf = a => (ACC_STYLE[a.type] || ACC_STYLE.other);

    async function load() {
      loading.value = true;
      try {
        const res = await apiGet("accounts", { include_archived: true });
        items.value = (res.data || res).items || [];
      } catch (e) { ElMessage.error("加载失败"); }
      finally { loading.value = false; }
    }
    function openCreate() {
      dialog.id = null;
      Object.assign(dialog.form, { name: "", type: "cash", balance: 0, note: "" });
      dialog.visible = true;
    }
    async function save() {
      if (!dialog.form.name.trim()) { ElMessage.warning("请输入名称"); return; }
      dialog.saving = true;
      try {
        if (dialog.id) {
          await apiPost("accounts/update", { ...dialog.form, id: dialog.id });
        } else {
          await apiPost("accounts/create", dialog.form);
        }
        ElMessage.success("已保存");
        dialog.visible = false;
        load();
      } catch (e) { ElMessage.error("保存失败：" + e.message); }
      finally { dialog.saving = false; }
    }
    function openAdjust(a) {
      adjustDialog.account = { ...a };
      adjustDialog.newBalance = Number(a.balance);
      adjustDialog.note = "";
      adjustDialog.visible = true;
    }
    async function saveAdjust() {
      adjustDialog.saving = true;
      try {
        await apiPost("accounts/adjust", { id: adjustDialog.account.id, balance: adjustDialog.newBalance, note: adjustDialog.note });
        ElMessage.success("已对账");
        adjustDialog.visible = false;
        load();
      } catch (e) { ElMessage.error("对账失败：" + e.message); }
      finally { adjustDialog.saving = false; }
    }
    async function archive(a, archived) {
      await apiPost("accounts/update", { id: a.id, archived });
      ElMessage.success(archived ? "已归档" : "已恢复");
      load();
    }
    async function del(a) {
      try {
        await ElMessageBox.confirm(`确认删除账户「${a.name}」？仅当无关联交易时可删除。`, "提示", { type: "warning" });
        await apiPost("accounts/delete", { id: a.id });
        ElMessage.success("已删除");
        load();
      } catch (e) {
        if (e?.message) ElMessage.error(e.message);
      }
    }
    onMounted(load);
    return {
      loading, items, dialog, adjustDialog, accTypeLabel,
      totalAssets, diff, iconOf, colorOf,
      openCreate, save, openAdjust, saveAdjust, archive, del,
      fmtMoney, typeColor
    };
  }
};

/* ============================================================
 * 组件：标签管理
 * ============================================================ */
const TagsView = {
  template: `
    <div v-loading="loading">
      <div class="bk-toolbar">
        <el-input v-model="newName" placeholder="新标签名" style="width:220px" @keyup.enter="add" />
        <button class="pill-btn primary" @click="add"><el-icon><Plus /></el-icon>新增</button>
      </div>
      <div class="bk-list-grid">
        <div v-for="t in items" :key="t.id" class="bk-card bk-list-card">
          <div class="bk-cat-icon" style="background: rgba(255,159,10,0.16)"><el-icon class="tag-ico"><CollectionTag /></el-icon></div>
          <div class="bk-list-info">
            <div class="bk-list-name">#{{ t.name }}</div>
            <div class="bk-list-sub">使用 {{ t.usage_count }} 次</div>
          </div>
          <div class="bk-list-actions">
            <el-button text type="danger" @click="del(t)">删除</el-button>
          </div>
        </div>
      </div>
      <div v-if="!items.length" class="bk-empty"><span class="emoji">🏷️</span>暂无标签</div>
    </div>
  `,
  setup() {
    const loading = ref(false);
    const items = ref([]);
    const newName = ref("");

    async function load() {
      loading.value = true;
      try {
        const res = await apiGet("tags");
        items.value = (res.data || res).items || [];
      } catch (e) { ElMessage.error("加载失败"); }
      finally { loading.value = false; }
    }
    async function add() {
      if (!newName.value.trim()) return;
      try {
        await apiPost("tags/create", { name: newName.value });
        newName.value = "";
        ElMessage.success("已新增");
        load();
      } catch (e) { ElMessage.error("新增失败"); }
    }
    async function del(t) {
      try {
        await ElMessageBox.confirm(`确认删除标签 #${t.name}？`, "提示", { type: "warning" });
        await apiPost("tags/delete", { id: t.id });
        ElMessage.success("已删除");
        load();
      } catch (e) {}
    }
    onMounted(load);
    return { loading, items, newName, add, del };
  }
};

/* ============================================================
 * 组件：设置
 * ============================================================ */
const SettingsView = {
  template: `
    <div>
      <div class="bk-card bk-settings-card">
        <div class="settings-title"><el-icon class="title-ico"><Setting /></el-icon>插件设置</div>
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:18px">
          插件配置（货币符号、时区、预警阈值等）在 AstrBot 管理后台 → 插件配置 中编辑，保存后自动生效。
        </el-alert>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="货币符号">{{ config.currency || '¥' }}</el-descriptions-item>
          <el-descriptions-item label="时区">{{ config.timezone || 'Asia/Shanghai' }}</el-descriptions-item>
          <el-descriptions-item label="大额预警阈值">{{ config.warn_large_amount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="列表分页">{{ config.page_size || 20 }}</el-descriptions-item>
          <el-descriptions-item label="图片账单">{{ config.enable_image_receipt ? '已启用' : '未启用' }}</el-descriptions-item>
          <el-descriptions-item label="背景图 API">
            <div v-if="bgApiList.length" style="white-space:normal; word-break:break-all">
              <div v-for="(u, i) in bgApiList" :key="i" style="line-height:1.6">
                <span class="type-tag transfer" style="margin-right:6px">{{ i + 1 }}</span>{{ u }}
              </div>
            </div>
            <span v-else>使用内置默认源</span>
          </el-descriptions-item>
        </el-descriptions>
        <div class="bk-export-btns">
          <button class="pill-btn danger" @click="exportJson"><el-icon><Download /></el-icon>导出全部数据 (JSON)</button>
          <button class="pill-btn" @click="exportCsv"><el-icon><Download /></el-icon>导出交易 (CSV)</button>
        </div>
      </div>

      <div class="bk-card bk-settings-card">
        <div class="settings-title"><el-icon class="title-ico"><MagicStick /></el-icon>使用提示</div>
        <p class="bk-settings-tip">
          本插件以 <b>All-in-AI</b> 为设计理念，提供 20+ 个 LLM 工具。在聊天窗口直接用自然语言描述需求即可：
        </p>
        <ul class="bk-settings-tip">
          <li>"记一笔 餐饮 50 午餐" / "工资到账 8000"</li>
          <li>"本月账单" / "钱花在哪了" / "最近 10 笔"</li>
          <li>"从银行卡转 500 到支付宝"</li>
          <li>"我还有多少钱" / "新建账户 基金 余额 1000"</li>
        </ul>
        <p class="bk-settings-tip" style="margin-top:14px">
          🖼️ <b>自定义背景</b>：在 AstrBot 管理后台 → 插件配置 → 「背景图 API」中添加你的随机二次元图接口（一个列表项一个 API），支持直接返图或返回 JSON（自动识别 url/imgurl/image 字段），保存后刷新页面生效。
        </p>
      </div>
    </div>
  `,
  setup() {
    const config = ref({});
    // 背景 API 配置兼容两种存储格式：
    //  - list 类型（新）：字符串数组
    //  - string 类型（旧）：逗号分隔
    // 统一规范化为数组，避免 v-for 遍历字符串导致逐字符显示。
    const bgApiList = computed(() => {
      const raw = config.value.anime_bg_api;
      if (!raw) return [];
      let list = [];
      if (Array.isArray(raw)) {
        list = raw;
      } else if (typeof raw === "string") {
        list = raw.split(/[,，;\n]/);
      }
      return list.map(s => String(s).trim()).filter(Boolean);
    });
    onMounted(async () => {
      try {
        const res = await apiGet("healthz");
        const d = res.data || res;
        config.value = d.config || {};
      } catch (e) {}
    });
    // 沙箱 iframe 禁用 window.open / a.click 下载，统一走 bridge.download
    async function exportJson() {
      try {
        await bridge.download("export/json", {}, "bookkeeping_data.json");
      } catch (e) {
        ElMessage.error("导出失败：" + (e.message || e));
      }
    }
    async function exportCsv() {
      try {
        await bridge.download("export/csv", {}, "transactions.csv");
      } catch (e) {
        ElMessage.error("导出失败：" + (e.message || e));
      }
    }
    return { config, bgApiList, exportJson, exportCsv };
  }
};

/* ============================================================
 * 主 App - 液体玻璃布局 + 随机动漫背景
 * ============================================================ */
const App = {
  components: {
    DashboardView, TransactionsView, CategoriesView,
    AccountsView, TagsView, SettingsView
  },
  template: `
    <div class="bk-layout">
      <!-- 随机二次元背景 -->
      <div class="bg-stage" aria-hidden="true">
        <div class="bg-layer" :class="{ on: bgLayerIdx === 0, kenburns: bgLayerIdx === 0 }" :style="bgStyle(0)"></div>
        <div class="bg-layer" :class="{ on: bgLayerIdx === 1, kenburns: bgLayerIdx === 1 }" :style="bgStyle(1)"></div>
        <div class="bg-vignette"></div>
        <div class="bg-aura"></div>
      </div>

      <aside class="bk-sidebar">
        <div class="bk-logo">
          <div class="logo-icon"><el-icon :size="24"><Notebook /></el-icon></div>
          <div class="logo-text">
            <b>智能记账</b>
            <span>All-in-AI · Liquid Glass</span>
          </div>
        </div>
        <nav class="bk-menu">
          <div v-for="m in menus" :key="m.key" class="bk-menu-item"
               :class="{active: active===m.key}" @click="active=m.key">
            <el-icon :size="19"><component :is="m.icon" /></el-icon>
            <span>{{ m.label }}</span>
          </div>
        </nav>
        <div class="bk-sidebar-footer">
          <button class="bk-theme-btn" @click="toggleTheme">
            <el-icon :size="18"><component :is="theme==='dark' ? 'Sunny' : 'Moon'" /></el-icon>
            <span>{{ theme==='dark' ? '浅色模式' : '深色模式' }}</span>
          </button>
        </div>
      </aside>

      <main class="bk-main">
        <header class="bk-topbar">
          <div class="title">
            <span class="title-ico"><el-icon :size="16"><component :is="currentMenu.icon" /></el-icon></span>
            <span>{{ currentMenu.label }}</span>
          </div>
          <div class="actions">
            <button class="pill-btn" @click="nextBg" title="切换二次元背景">
              <el-icon :size="15"><Picture /></el-icon><span class="pill-text">换背景</span>
            </button>
            <button class="pill-btn" @click="refresh" title="刷新当前页面">
              <el-icon :size="15"><Refresh /></el-icon><span class="pill-text">刷新</span>
            </button>
          </div>
        </header>
        <section class="bk-content">
          <component :is="currentView" :key="active" ref="viewRef" @navigate="onNavigate" />
        </section>
      </main>
    </div>
  `,
  setup() {
    const I = ElementPlusIconsVue;
    const menus = [
      { key: "dashboard",    icon: I.Odometer,      label: "仪表盘" },
      { key: "transactions", icon: I.Tickets,       label: "交易管理" },
      { key: "categories",   icon: I.Folder,        label: "分类管理" },
      { key: "accounts",     icon: I.Wallet,        label: "账户管理" },
      { key: "tags",         icon: I.CollectionTag, label: "标签管理" },
      { key: "settings",     icon: I.Setting,       label: "设置" },
    ];
    const active = ref("dashboard");
    const theme = ref(safeStorage.getItem("bk-theme") || "light");
    const viewRef = ref(null);

    /* ---- 动漫背景状态 ---- */
    const bgUrls = ref(["", ""]);
    const bgLayerIdx = ref(0);
    let bgTimer = null;
    let bgLoading = false;

    const currentMenu = computed(() => menus.find(m => m.key === active.value) || menus[0]);
    const currentView = computed(() => {
      switch (active.value) {
        case "dashboard": return "DashboardView";
        case "transactions": return "TransactionsView";
        case "categories": return "CategoriesView";
        case "accounts": return "AccountsView";
        case "tags": return "TagsView";
        case "settings": return "SettingsView";
        default: return "DashboardView";
      }
    });

    function bgStyle(i) {
      const v = bgUrls.value[i];
      return v ? { backgroundImage: `url("${v}")` } : {};
    }

    /* 拉取并淡入一张新二次元壁纸 */
    async function nextBg() {
      if (bgLoading) return;
      bgLoading = true;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const url = await fetchRandomAnimeBg();
          if (url) {
            const target = 1 - bgLayerIdx.value;
            bgUrls.value[target] = url;
            bgLayerIdx.value = target;
            return;
          }
        }
      } finally {
        bgLoading = false;
      }
    }

    function toggleTheme() {
      theme.value = theme.value === "dark" ? "light" : "dark";
      safeStorage.setItem("bk-theme", theme.value);
      document.documentElement.setAttribute("data-theme", theme.value);
    }
    function onNavigate(key) { active.value = key; }
    function refresh() {
      if (viewRef.value && viewRef.value.load) viewRef.value.load();
      else { active.value = active.value; /* 重新挂载 */ }
    }

    onMounted(() => {
      document.documentElement.setAttribute("data-theme", theme.value);
      nextBg();
      // 每 60s 自动切换一次二次元背景
      bgTimer = setInterval(() => { nextBg(); }, 60000);
    });
    onUnmounted(() => { if (bgTimer) clearInterval(bgTimer); });

    return {
      menus, active, theme, viewRef, currentMenu, currentView,
      bgUrls, bgLayerIdx, bgStyle, nextBg,
      toggleTheme, onNavigate, refresh
    };
  }
};

/* ============================================================
 * 启动
 * ============================================================ */
(async function bootstrap() {
  // 等待 bridge 就绪
  await bridge.ready();
  const ctx = bridge.getContext();
  _pluginName = ctx.pluginName;

  // 从后端读取配置（货币符号、动漫背景 API 等）
  try {
    const res = await apiGet("healthz");
    const d = res.data || res;
    window.__bookkeeping_config__ = d.config || {};
    if (d.config?.currency) _currency = d.config.currency;
    applyBgConfig(d.config);
  } catch (e) {
    window.__bookkeeping_config__ = {};
  }

  const app = createApp(App);
  app.config.errorHandler = (err, _instance, info) => {
    console.error("[Bookkeeping WebUI]", err, info);
    ElMessage.error("页面渲染异常：" + (err && err.message ? err.message : err));
  };
  app.use(ElementPlus);
  for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, comp);
  }
  app.mount("#app");

  // 隐藏启动加载屏
  const splash = document.getElementById("splash");
  if (splash) {
    splash.classList.add("hide");
    setTimeout(() => splash && splash.remove(), 700);
  }
})();
