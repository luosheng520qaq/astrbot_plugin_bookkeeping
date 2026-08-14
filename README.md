# 智能记账插件 (astrbot_plugin_bookkeeping)

> All-in-AI 智能记账插件，提供 20+ 个 LLM 工具与美观的 WebUI 仪表盘。
> 版本：v0.3.0 · 要求 AstrBot ≥ 4.27.0

<p align="center">
  <img src="./logo.png" width="120" alt="logo" />
</p>

## ✨ 功能

### 🤖 AI 自然语言记账（LLM 工具，20+）
直接在聊天里用日常语言跟 AstrBot 说话，LLM 会自动调用工具完成操作：

**记账类**
- 记一笔支出 / 收入（金额、分类、账户、标签、备注自动识别）
- 账户间转账（银行卡 ↔ 支付宝 / 微信 ↔ 现金等）
- 修改 / 删除某笔交易
- 查看交易详情、按条件筛选交易列表

**查询 / 统计类**
- 今日 / 本周 / 本月 / 上月 / 今年账单概览（支持自定义区间）
- 分类占比、每日收支趋势、收支对比
- Top 支出排行、标签统计
- 查账户余额、净资产

**账户 / 分类 / 标签管理**
- 多账户：现金、银行卡、支付宝、微信、信用卡、自定义（同一类型可建多个，如多张银行卡，名称唯一）
- 新建账户、手动调余额、归档账户、删除账户（含余额转出确认）
- 新增 / 查看 / 删除分类（带 emoji 图标 + 颜色）
- 标签管理与使用说明

> 大额预警：单笔金额超过配置阈值时，会先向用户二次确认再记账。

### 📊 WebUI 仪表盘（iOS 液体玻璃风格）
在 AstrBot 仪表盘的插件页打开，功能完整：

| 模块 | 内容 |
|------|------|
| 仪表盘 | 卡片 + 图表：今日收支、本月净收支、净资产、每日趋势折线图、分类占比饼图、近期收支对比柱状图 |
| 交易管理 | 分页列表，按类型/分类/账户/标签/日期区间/关键字筛选；新增、编辑、删除；操作按钮横向滚动不遮挡文字 |
| 分类管理 | 支出/收入分类增删，支持 emoji 图标选择与自定义颜色 |
| 账户管理 | 账户增删改、余额调整、归档（同名校验、删除前余额转出提示） |
| 标签管理 | 标签增删、使用统计 |
| 设置 | 关于说明、JSON / CSV 数据导出、当前背景图 API 预览 |

### 🎨 UI 细节
- **iOS "Liquid Glass" 液体玻璃**设计：高饱和背景虚化 + 镜面高光 + 折射描边 + 弹簧动效
- **深色 / 浅色模式**：侧边栏一键切换，带**圆形蔓延遮罩平滑过渡动画**（从按钮位置扩散全屏）
- **随机动漫背景**：
  - 双层交叉淡入 + Ken Burns 缓慢缩放动效
  - 默认 5 个随机二次元图源，可在配置中自定义（列表式）
  - 支持两类 API：① 直接返回图片（重定向也兼容）；② 返回 JSON（自动识别 `url / imgurl / image / pic / img / src / data` 字段）
  - 每 60 秒自动切换一张，顶栏"换背景"按钮可手动切换
  - 侧边栏底部也可随时开关背景图（关了只显示渐变底色）
- **响应式布局**：移动端自适应，对话框自动全屏，表格横向滚动，元素不截断不遮挡

### 💾 数据导出
- JSON 全量导出（所有表、完整字段，方便备份 / 迁移）
- CSV 交易流水导出（可直接导入 Excel）
- 沙箱 iframe 环境下通过 bridge 下载，规避 `window.open` 受限问题

## 📦 安装

将本插件放入 AstrBot 的 `plugins` 目录，重启后自动安装依赖：

```
plugins/astrbot_plugin_bookkeeping/
```

Python 依赖（自动安装）：
```
aiosqlite >= 0.19.0
```

## ⚙️ 配置

在 AstrBot 管理后台 → 插件配置中编辑（修改后刷新 WebUI 生效）：

| 配置项 | 类型 | 说明 | 默认值 |
|--------|------|------|--------|
| `currency` | string | 货币符号，显示在金额前（¥、$、€ 等） | `¥` |
| `timezone` | string | IANA 时区名，影响按日期聚合统计 | `Asia/Shanghai` |
| `warn_large_amount` | float | 单笔大额预警阈值，超过会二次确认；`0` 关闭 | `1000` |
| `page_size` | int | WebUI 列表默认每页条数（建议 10–50） | `20` |
| `enable_image_receipt` | bool | 开启后每月账单概览可生成图片，便于聊天端发送 | `true` |
| `anime_bg_api` | list\<string\> | WebUI 随机背景图 API 列表，留空则禁用背景图，仅显示渐变底色（**不会**回退内置默认源）；支持直接返图或返回 JSON 接口 | 内置 5 个随机二次元图源 |

## 💬 使用示例

在聊天窗口直接对 AstrBot 说：

```
- 餐饮 50 中午和同事吃麻辣烫（用支付宝付的）
- 工资到账 12000，银行卡
- 记一笔 交通 30 打车回家  # 今晚加班
- 从银行卡转 500 到支付宝
- 本月账单 / 这个月花了多少
- 这周吃饭花了多少钱
- 最近 10 笔支出
- 我还有多少钱（各账户余额）
- 新建账户 招商信用卡 类型 信用卡 额度 50000
- 新建账户 余额宝 类型 其他 余额 2500
- 删除账户 旧钱包
- 新建分类 游戏 图标 🎮 颜色 #9B59B6
- 记账帮助（查看工具使用说明）
```

## 🧠 LLM 工具清单

| 工具 | 作用 |
|------|------|
| `add_transaction` | 新增支出 / 收入交易 |
| `transfer_between_accounts` | 两账户间转账（记录两条交易，余额同步） |
| `list_transactions` | 按 类型/分类/账户/标签/日期/关键字 分页查询 |
| `update_transaction` | 修改指定交易 |
| `delete_transaction` | 删除指定交易 |
| `get_transaction_detail` | 查看单笔交易详情 |
| `get_summary` | 账单概览（区间收支、净额、账户余额） |
| `category_breakdown` | 分类占比 |
| `trend` | 每日 / 每周趋势 |
| `top_transactions` | Top N 交易排行 |
| `tag_stats` | 标签统计 |
| `list_accounts` / `add_account` / `adjust_balance` / `archive_account` / `delete_account` | 账户管理 |
| `list_categories` / `add_category` / `delete_category` | 分类管理 |
| `list_tags` | 标签列表 |
| `bookkeeping_help` | 使用帮助 |

## 🏗️ 工程说明

- 数据存储：SQLite（通过 `aiosqlite` 异步访问），库文件在 `StarTools.get_data_dir(PLUGIN_NAME)` 下的 `bookkeeping.db`
- LLM 工具注册：模块级注册（非 `initialize` 内），确保 AstrBot 能扫描到
- Web 端：Vue 3 + Element Plus + Chart.js，通过 `astrbot.api.web` 返回响应；静态资源走 `./assets/` 本地路径（无 CDN）
- 沙箱兼容：`localStorage` 使用 safeStorage 包装降级为内存存储；下载用 `bridge.download`；SQL JOIN 所有列名加表前缀避免歧义

## 📄 许可证

[MIT](./LICENSE)
