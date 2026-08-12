"""All-in-AI 记账插件主类。"""
from __future__ import annotations

import json
import re as _re

from astrbot.api import logger
from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, StarTools

from .db import Database
from .db.repository import Repository
from .llm_tools import register_llm_tools
from .web_api import WebAPI

PLUGIN_NAME = "astrbot_plugin_bookkeeping"

# 模块级 holder：让 LLM 工具在模块导入时就能注册装饰器，
# 但实际调用时再从 holder 取出插件实例访问 repo / config。
_instance_holder: dict = {"instance": None}


def _repo_holder():
    inst = _instance_holder.get("instance")
    return inst._repo if inst else None


def _config_holder():
    inst = _instance_holder.get("instance")
    return inst._get_config() if inst else {}


def _coerce_bg_list(value):
    """把 anime_bg_api 历史配置统一成真正的 list。

    - list：已合法，仅去掉空项（无变化时返回 None，避免无谓写盘）
    - string（旧版 schema 曾用 string 类型）：按逗号/分号/换行拆分，
      并兼容 JSON 数组字符串（如 "[\\"a\\",\\"b\\"]"）
    - 其他类型：返回 None 交由 AstrBot 默认值处理

    返回新 list 表示需要写回，返回 None 表示无需改动。
    """
    if value is None:
        return None
    if isinstance(value, list):
        cleaned = [str(v).strip() for v in value if str(v).strip()]
        return cleaned if cleaned != value else None
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    cleaned = [str(v).strip() for v in parsed if str(v).strip()]
                    return cleaned
            except (ValueError, TypeError):
                pass
        return [p.strip() for p in _re.split(r"[,，;\n]", s) if p.strip()]
    return None


class BookkeepingPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context, config)
        self._config: dict = config or {}
        self._db: Database | None = None
        self._repo: Repository | None = None
        self._web_api: WebAPI | None = None

    # ---------- 生命周期 ----------
    async def initialize(self):
        data_dir = StarTools.get_data_dir(PLUGIN_NAME)
        db_path = data_dir / "data.db"
        self._db = Database(db_path)
        await self._db.init()
        self._repo = Repository(self._db)
        self._web_api = WebAPI(self._repo, PLUGIN_NAME, config=self._config)
        # 注册到模块级 holder，让 LLM 工具能访问到本实例
        _instance_holder["instance"] = self
        # 迁移历史字符串型列表配置，避免 AstrBot 配置面板把字符串逐字符渲染
        self._migrate_list_configs()
        logger.info(f"[Bookkeeping] 数据库就绪：{db_path}")

        # 注册 Web API 路由
        self._register_web_routes(self.context)
        logger.info("[Bookkeeping] Web API 已注册")

    def _migrate_list_configs(self) -> None:
        """把 anime_bg_api 从字符串迁移为 list 并写回配置文件。

        AstrBot 配置面板对 list 类型会直接遍历值；若历史配置存的是字符串，
        就会逐字符渲染成"一个字母一行"。这里在插件启动时一次性迁移。
        """
        cfg = self._config
        if not isinstance(cfg, dict):
            return
        bg = _coerce_bg_list(cfg.get("anime_bg_api"))
        if bg is None:
            return
        cfg["anime_bg_api"] = bg
        save = getattr(cfg, "save_config", None)
        if callable(save):
            try:
                save()
                logger.info("[Bookkeeping] anime_bg_api 已迁移为列表格式")
            except Exception as e:
                logger.warning(f"[Bookkeeping] 迁移配置写回失败（下次保存配置时会生效）：{e}")

    async def terminate(self):
        if self._db:
            await self._db.close()
            logger.info("[Bookkeeping] 数据库已关闭")
        if _instance_holder.get("instance") is self:
            _instance_holder["instance"] = None

    # ---------- 配置读取 ----------
    def _get_config(self) -> dict:
        """读取 _conf_schema.json 配置。"""
        return self._config or {}

    # ---------- Web API 注册 ----------
    def _register_web_routes(self, context: Context) -> None:
        api = self._web_api
        prefix = f"/{PLUGIN_NAME}"
        routes = [
            # 交易
            (f"{prefix}/transactions",                 api.list_transactions,    ["GET"],  "列出交易"),
            (f"{prefix}/transactions/get",              api.get_transaction,      ["GET"],  "查询交易详情"),
            (f"{prefix}/transactions/create",           api.create_transaction,   ["POST"], "新增交易"),
            (f"{prefix}/transactions/update",           api.update_transaction,    ["POST"], "更新交易"),
            (f"{prefix}/transactions/delete",            api.delete_transaction,   ["GET", "POST"], "删除交易"),
            # 账户
            (f"{prefix}/accounts",                     api.list_accounts,        ["GET"],  "列出账户"),
            (f"{prefix}/accounts/create",               api.create_account,       ["POST"], "新增账户"),
            (f"{prefix}/accounts/update",               api.update_account,       ["POST"], "更新账户"),
            (f"{prefix}/accounts/adjust",              api.adjust_balance,       ["POST"], "调整余额"),
            (f"{prefix}/accounts/delete",               api.delete_account,       ["GET", "POST"], "删除账户"),
            # 分类
            (f"{prefix}/categories",                   api.list_categories,      ["GET"],  "列分类"),
            (f"{prefix}/categories/create",             api.create_category,      ["POST"], "新增分类"),
            (f"{prefix}/categories/update",             api.update_category,      ["POST"], "更新分类"),
            (f"{prefix}/categories/delete",             api.delete_category,      ["GET", "POST"], "删除分类"),
            # 标签
            (f"{prefix}/tags",                         api.list_tags,             ["GET"],  "列标签"),
            (f"{prefix}/tags/create",                   api.create_tag,            ["POST"], "新增标签"),
            (f"{prefix}/tags/delete",                   api.delete_tag,            ["GET", "POST"], "删除标签"),
            # 统计
            (f"{prefix}/stats/summary",                api.get_summary,           ["GET"],  "收支汇总"),
            (f"{prefix}/stats/category",               api.category_breakdown,    ["GET"],  "分类占比"),
            (f"{prefix}/stats/daily",                  api.daily_trend,           ["GET"],  "日趋势"),
            (f"{prefix}/stats/monthly",                api.monthly_trend,         ["GET"],  "月趋势"),
            (f"{prefix}/stats/top",                    api.top_transactions,      ["GET"],  "Top 交易"),
            (f"{prefix}/stats/accounts",               api.account_distribution, ["GET"],  "账户资金分布"),
            (f"{prefix}/stats/tags",                  api.tag_stats,             ["GET"],  "标签统计"),
            (f"{prefix}/stats/dashboard",              api.dashboard,             ["GET"],  "仪表盘聚合"),
            # 导入导出
            (f"{prefix}/export/json",                 api.export_json,           ["GET"],  "导出 JSON"),
            (f"{prefix}/export/csv",                  api.export_csv,            ["GET"],  "导出 CSV"),
            # 健康检查
            (f"{prefix}/healthz",                     api.healthz,               ["GET"],  "健康检查"),
        ]
        for path, handler, methods, desc in routes:
            context.register_web_api(path, handler, methods, desc)

    # ---------- 极简指令（仅作引导，不与 LLM 工具冲突） ----------
    @filter.command("记账", alias={"bookkeeping"})
    async def cmd_bookkeeping(self, event: AstrMessageEvent):
        """记账插件入口，显示能力说明。"""
        yield event.plain_result(
            "📒 记账插件已就绪。直接用自然语言告诉我即可，例如：\n"
            "• 记一笔 餐饮 50 午餐\n"
            "• 本月账单\n"
            "• 钱花在哪了\n"
            "• 我还有多少钱\n"
            "• 从银行卡转 500 到支付宝\n\n"
            "完整能力请说『记账帮助』。"
        )


# 模块级注册 LLM 工具：必须在 import 时执行，
# 让 @filter.llm_tool 装饰器把 handler 注册到 star_handlers_registry。
# AstrBot 加载流程：import 模块 → 扫描 registry → 实例化插件 → 调用 initialize。
# 因此不能在 initialize 中调用 register_llm_tools。
register_llm_tools(
    BookkeepingPlugin,
    repo_holder=_repo_holder,
    config_holder=_config_holder,
)
