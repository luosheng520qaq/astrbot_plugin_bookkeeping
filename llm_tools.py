"""LLM 工具集合。

通过 @filter.llm_tool 装饰器注册，让大模型能够完成记账、查询、统计等全部操作。
工具 docstring 决定 LLM 的理解能力，必须详尽且规范。
工具函数必须 return 结构化结果给 LLM，而非直接发送消息。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Optional

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api import logger


def _tx_to_brief(tx: dict, currency: str = "¥") -> str:
    """将交易对象格式化为人类可读的简短描述。"""
    type_map = {"expense": "支出", "income": "收入", "transfer": "转账"}
    type_label = type_map.get(tx.get("type", ""), tx.get("type", ""))
    amt = f"{currency}{float(tx.get('amount', 0)):.2f}"
    parts = [f"#{tx.get('id')} [{type_label}] {amt}"]
    if tx.get("category_name"):
        parts.append(f"分类:{tx['category_name']}")
    if tx.get("account_name"):
        if tx.get("type") == "transfer" and tx.get("to_account_name"):
            parts.append(f"{tx['account_name']}→{tx['to_account_name']}")
        else:
            parts.append(f"账户:{tx['account_name']}")
    if tx.get("note"):
        parts.append(f"备注:{tx['note']}")
    if tx.get("tx_date"):
        time_str = f" {tx.get('tx_time', '')}" if tx.get("tx_time") else ""
        parts.append(f"时间:{tx['tx_date']}{time_str}")
    if tx.get("tags"):
        parts.append("标签:" + " ".join(f"#{t}" for t in tx["tags"]))
    return " | ".join(parts)


def _summary_text(s: dict, currency: str = "¥") -> str:
    return (
        f"收入 {currency}{s['total_income']:.2f} | "
        f"支出 {currency}{s['total_expense']:.2f} | "
        f"结余 {currency}{s['balance']:.2f} | 共 {s['tx_count']} 笔"
    )


def _resolve_account(
    accounts: list[dict],
    name: Optional[str] = None,
    account_id: Optional[int] = None,
) -> Optional[dict]:
    """按账户 ID（优先）或名称解析账户。

    - account_id 有效时优先按 ID 匹配（兼容模型把 ID 传成字符串）。
    - 否则按名称精确匹配；名称是纯数字时也尝试当作 ID 匹配（兼容旧行为）。
    """
    if account_id not in (None, "", 0):
        try:
            aid = int(account_id)
        except (TypeError, ValueError):
            aid = None
        if aid is not None:
            for a in accounts:
                if a["id"] == aid:
                    return a
            return None
    if name:
        name_s = str(name).strip()
        for a in accounts:
            if a["name"] == name_s:
                return a
        if name_s.isdigit():
            for a in accounts:
                if str(a["id"]) == name_s:
                    return a
    return None


def _accounts_hint(accounts: list[dict]) -> str:
    """账户列表提示（含 ID），用于报错时引导模型使用 ID。"""
    return "、".join(f"{a['name']}(id={a['id']})" for a in accounts)


def register_llm_tools(plugin_cls, repo_holder, config_holder):
    """在插件类上注册全部 LLM 工具。

    repo_holder(): 返回 Repository 实例
    config_holder(): 返回当前配置 dict
    """

    def _repo():
        return repo_holder()

    def _cfg(key, default=None):
        return config_holder().get(key, default)

    # ============== 交易管理 ==============

    @filter.llm_tool(name="bookkeeping_add_transaction")
    async def add_transaction(
        self,
        event: AstrMessageEvent,
        type: str,
        amount: float,
        category: str,
        account: str = "",
        account_id: int = 0,
        note: str = "",
        date: str = "",
        time: str = "",
        tags: str = "",
    ):
        """记录一笔账目（支出/收入/转账）。优先调用此工具完成记账。

        适用场景：用户说"记账/记一笔/花了/收入/进账/转账"等。
        金额必须为正数；转账 type=transfer 时 account/account_id 表示转出账户，可额外用 to_account/to_account_id 指定转入账户（或省略，将询问用户）。
        账户优先使用数字 ID（account_id，通过 bookkeeping_list_accounts 获取）；也可用名称（account），两者填一个即可。

        Args:
            type(string): 交易类型，取值：expense=支出 / income=收入 / transfer=转账
            amount(number): 金额（正数）
            category(string): 分类名称。如：餐饮/交通/购物/工资/奖金 等；不存在时会自动创建
            account(string): 账户名称（如：现金/支付宝/微信/银行卡）；与 account_id 二选一，建议优先用 ID
            account_id(int): 账户数字 ID；优先于 account，通过 bookkeeping_list_accounts 可查到
            note(string): 备注说明，可空
            date(string): 交易日期 YYYY-MM-DD；为空则用今天
            time(string): 交易时间 HH:MM:SS；为空则用当前时刻
            tags(string): 标签，多个用英文逗号分隔，例如：出差,聚餐
        """
        try:
            repo = _repo()
            type_ = (type or "").strip().lower()
            if type_ not in ("expense", "income", "transfer"):
                return {"ok": False, "error": "type 必须是 expense/income/transfer"}

            accounts = await repo.list_accounts()
            acc = _resolve_account(accounts, account, account_id)
            if not acc:
                return {
                    "ok": False,
                    "error": f"找不到账户（名称「{account or ''}」/ID {account_id or ''}）",
                    "available_accounts": [a["name"] for a in accounts],
                    "available_accounts_with_id": [{"id": a["id"], "name": a["name"]} for a in accounts],
                    "hint": f"可用账户：{_accounts_hint(accounts)}",
                }

            cat_type = "expense" if type_ == "expense" else "income"
            cat = await repo.find_category_by_name(category, cat_type) if type_ != "transfer" else None
            if not cat and type_ != "transfer":
                cat = await repo.add_category(category, cat_type, sort=50)

            tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()] if tags else None
            tx = await repo.add_transaction(
                type_=type_,
                amount=float(amount),
                account_id=acc["id"],
                category_id=cat["id"] if cat else None,
                note=note or "",
                tx_date=date or None,
                tx_time=time or None,
                tag_names=tag_list,
            )
            currency = _cfg("currency", "¥")
            warn = float(_cfg("warn_large_amount", 0) or 0)
            warning = ""
            if warn > 0 and float(amount) >= warn:
                warning = (
                    f"⚠️ 单笔金额 {currency}{float(amount):.2f} 达到预警阈值 "
                    f"{currency}{warn:.2f}，请确认录入无误"
                )
            return {
                "ok": True,
                "message": f"已记账\n{_tx_to_brief(tx, currency)}" + (f"\n{warning}" if warning else ""),
                "transaction": tx,
                "warning": warning,
            }
        except Exception as e:
            logger.error(f"add_transaction error: {e}")
            return {"ok": False, "error": f"记账失败：{e}"}

    @filter.llm_tool(name="bookkeeping_transfer")
    async def transfer_between_accounts(
        self,
        event: AstrMessageEvent,
        from_account: str = "",
        from_account_id: int = 0,
        to_account: str = "",
        to_account_id: int = 0,
        amount: float = 0,
        note: str = "",
        date: str = "",
    ):
        """在两个账户之间转账（不影响收支统计）。例如：银行卡→支付宝 还款 500 元。
        账户优先使用数字 ID（from_account_id/to_account_id，通过 bookkeeping_list_accounts 获取）；也可用名称。

        Args:
            from_account(string): 转出账户名称（与 from_account_id 二选一，建议优先用 ID）
            from_account_id(int): 转出账户数字 ID，优先于 from_account
            to_account(string): 转入账户名称（与 to_account_id 二选一，建议优先用 ID）
            to_account_id(int): 转入账户数字 ID，优先于 to_account
            amount(number): 转账金额
            note(string): 备注，可空
            date(string): 日期 YYYY-MM-DD；空则今天
        """
        try:
            repo = _repo()
            accounts = await repo.list_accounts()
            src = _resolve_account(accounts, from_account, from_account_id)
            dst = _resolve_account(accounts, to_account, to_account_id)
            if not src:
                return {"ok": False, "error": f"找不到转出账户（名称「{from_account or ''}」/ID {from_account_id or ''}）", "hint": f"可用账户：{_accounts_hint(accounts)}"}
            if not dst:
                return {"ok": False, "error": f"找不到转入账户（名称「{to_account or ''}」/ID {to_account_id or ''}）", "hint": f"可用账户：{_accounts_hint(accounts)}"}
            if src["id"] == dst["id"]:
                return {"ok": False, "error": "转出与转入账户相同"}
            tx = await repo.add_transaction(
                type_="transfer", amount=float(amount), account_id=src["id"],
                to_account_id=dst["id"], note=note, tx_date=date or None,
            )
            currency = _cfg("currency", "¥")
            return {
                "ok": True,
                "message": f"转账成功\n{_tx_to_brief(tx, currency)}",
                "transaction": tx,
            }
        except Exception as e:
            logger.error(f"transfer error: {e}")
            return {"ok": False, "error": f"转账失败：{e}"}

    @filter.llm_tool(name="bookkeeping_list_transactions")
    async def list_transactions(
        self,
        event: AstrMessageEvent,
        type: str = "",
        category: str = "",
        account: str = "",
        account_id: int = 0,
        tag: str = "",
        start_date: str = "",
        end_date: str = "",
        keyword: str = "",
        limit: int = 20,
    ):
        """查询/筛选交易记录列表。支持按类型、分类、账户、标签、日期范围、备注关键字等多维度筛选。

        适用场景：用户问"最近花了什么/这个月账单/餐饮花了多少/列出 X 月所有支出"等。
        返回字段：id/类型/金额/分类/账户/备注/日期/标签，便于后续操作（更新/删除请用 id）。
        账户筛选可用数字 ID（account_id，优先）或名称（account）。

        Args:
            type(string): 类型筛选：expense/income/transfer；空则全部
            category(string): 分类名称；空则全部
            account(string): 账户名称；空则全部
            account_id(int): 账户数字 ID，优先于 account；空则全部
            tag(string): 标签名；空则全部
            start_date(string): 起始日期 YYYY-MM-DD；空则不限
            end_date(string): 结束日期 YYYY-MM-DD；空则不限
            keyword(string): 备注包含的关键字；空则不限
            limit(int): 最多返回几条，默认 20，最大 100
        """
        try:
            repo = _repo()
            type_ = (type or "").strip().lower() or None
            cat = None
            if category:
                cat = await repo.find_category_by_name(category)
                if not cat:
                    return {"ok": False, "error": f"未找到分类「{category}」"}
            acc_id = None
            if account or account_id:
                accounts = await repo.list_accounts()
                acc = _resolve_account(accounts, account, account_id)
                if not acc:
                    return {"ok": False, "error": f"未找到账户（名称「{account or ''}」/ID {account_id or ''}）", "hint": f"可用账户：{_accounts_hint(accounts)}"}
                acc_id = acc["id"]

            limit = max(1, min(int(limit or 20), 100))
            txs = await repo.list_transactions(
                type_=type_, category_id=cat["id"] if cat else None,
                account_id=acc_id, tag=tag or None,
                start_date=start_date or None, end_date=end_date or None,
                keyword=keyword or None, limit=limit,
            )
            if not txs:
                return {"ok": True, "message": "未找到匹配的交易记录", "transactions": []}
            currency = _cfg("currency", "¥")
            lines = [f"找到 {len(txs)} 笔（最多显示 {limit} 笔）："]
            for tx in txs:
                lines.append(_tx_to_brief(tx, currency))
            lines.append("\n提示：使用 id 可更新(bookkeeping_update_transaction)或删除(bookkeeping_delete_transaction)。")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "transactions": txs,
                "count": len(txs),
            }
        except Exception as e:
            logger.error(f"list_transactions error: {e}")
            return {"ok": False, "error": f"查询失败：{e}"}

    @filter.llm_tool(name="bookkeeping_update_transaction")
    async def update_transaction(
        self,
        event: AstrMessageEvent,
        transaction_id: int,
        type: str = "",
        amount: float = 0,
        category: str = "",
        account: str = "",
        account_id: int = 0,
        note: str = "",
        date: str = "",
        time: str = "",
        tags: str = "",
    ):
        """修改一笔已存在的交易。只需传入要修改的字段，未提供的字段保留原值。
        金额、类型、账户的变更会自动重算账户余额。
        账户可用数字 ID（account_id，优先）或名称（account）。

        Args:
            transaction_id(int): 交易 ID（通过 list_transactions 获取）
            type(string): 新类型 expense/income/transfer；空表示不变
            amount(number): 新金额（>0）；0 表示不变
            category(string): 新分类名；空表示不变
            account(string): 新账户名；空表示不变
            account_id(int): 新账户数字 ID，优先于 account；0 表示不变
            note(string): 新备注
            date(string): 新日期 YYYY-MM-DD
            time(string): 新时间 HH:MM:SS
            tags(string): 新标签（逗号分隔），传入则会完全替换原标签
        """
        try:
            repo = _repo()
            tx = await repo.get_transaction(int(transaction_id))
            if not tx:
                return {"ok": False, "error": f"找不到交易 ID={transaction_id}"}
            fields: dict[str, Any] = {}
            if type:
                fields["type"] = type.strip().lower()
            if amount:
                fields["amount"] = float(amount)
            if category:
                cat_type = fields.get("type", tx["type"])
                if cat_type == "transfer":
                    pass
                else:
                    cat = await repo.find_category_by_name(category, cat_type) or \
                          await repo.add_category(category, cat_type, sort=50)
                    fields["category_id"] = cat["id"]
            if account or account_id:
                accounts = await repo.list_accounts()
                acc = _resolve_account(accounts, account, account_id)
                if not acc:
                    return {"ok": False, "error": f"找不到账户（名称「{account or ''}」/ID {account_id or ''}）", "hint": f"可用账户：{_accounts_hint(accounts)}"}
                fields["account_id"] = acc["id"]
            if note:
                fields["note"] = note
            if date:
                fields["tx_date"] = date
            if time:
                fields["tx_time"] = time
            if tags:
                fields["tag_names"] = [t.strip() for t in tags.split(",") if t.strip()]

            updated = await repo.update_transaction(int(transaction_id), **fields)
            currency = _cfg("currency", "¥")
            return {
                "ok": True,
                "message": f"已更新\n{_tx_to_brief(updated or {}, currency)}",
                "transaction": updated,
            }
        except Exception as e:
            logger.error(f"update_transaction error: {e}")
            return {"ok": False, "error": f"更新失败：{e}"}

    @filter.llm_tool(name="bookkeeping_delete_transaction")
    async def delete_transaction(self, event: AstrMessageEvent, transaction_id: int):
        """删除一笔交易。删除后账户余额会自动回滚。此操作不可恢复。

        Args:
            transaction_id(int): 交易 ID
        """
        try:
            repo = _repo()
            tx = await repo.get_transaction(int(transaction_id))
            if not tx:
                return {"ok": False, "error": f"找不到交易 ID={transaction_id}"}
            ok = await repo.delete_transaction(int(transaction_id))
            currency = _cfg("currency", "¥")
            if ok:
                return {
                    "ok": True,
                    "message": f"已删除交易\n{_tx_to_brief(tx, currency)}",
                    "deleted_transaction": tx,
                }
            return {"ok": False, "error": "删除失败"}
        except Exception as e:
            logger.error(f"delete_transaction error: {e}")
            return {"ok": False, "error": f"删除失败：{e}"}

    @filter.llm_tool(name="bookkeeping_get_transaction_detail")
    async def get_transaction_detail(self, event: AstrMessageEvent, transaction_id: int):
        """查看单笔交易的完整详情。

        Args:
            transaction_id(int): 交易 ID
        """
        try:
            repo = _repo()
            tx = await repo.get_transaction(int(transaction_id))
            if not tx:
                return {"ok": False, "error": f"找不到交易 ID={transaction_id}"}
            currency = _cfg("currency", "¥")
            brief = _tx_to_brief(tx, currency)
            detail_json = json.dumps(tx, ensure_ascii=False, indent=2, default=str)
            return {
                "ok": True,
                "message": f"交易详情\n{brief}\n\n完整字段：\n{detail_json}",
                "transaction": tx,
            }
        except Exception as e:
            return {"ok": False, "error": f"查询失败：{e}"}

    # ============== 统计分析 ==============

    @filter.llm_tool(name="bookkeeping_get_summary")
    async def get_summary(
        self,
        event: AstrMessageEvent,
        period: str = "this_month",
        start_date: str = "",
        end_date: str = "",
    ):
        """获取收支汇总（总收入/总支出/结余/笔数）。常用于回答"这个月/今年花了多少"。

        Args:
            period(string): 周期快捷选项：today/this_week/this_month/this_year/last_month/last_year/all；优先于 start_date/end_date
            start_date(string): 自定义起始日期 YYYY-MM-DD（period 为空时生效）
            end_date(string): 自定义结束日期 YYYY-MM-DD（period 为空时生效）
        """
        try:
            repo = _repo()
            sd, ed = _resolve_period(period, start_date, end_date)
            s = await repo.get_summary(sd, ed)
            currency = _cfg("currency", "¥")
            return {
                "ok": True,
                "message": f"收支汇总（{sd or '不限'} ~ {ed or '至今'}）\n{_summary_text(s, currency)}",
                "summary": s,
                "start_date": sd,
                "end_date": ed,
            }
        except Exception as e:
            return {"ok": False, "error": f"统计失败：{e}"}

    @filter.llm_tool(name="bookkeeping_category_breakdown")
    async def category_breakdown(
        self,
        event: AstrMessageEvent,
        type: str = "expense",
        period: str = "this_month",
        start_date: str = "",
        end_date: str = "",
    ):
        """按分类查看支出/收入金额与占比，常用于回答"钱花在哪了/各分类花了多少"。

        Args:
            type(string): 类型 expense=支出 / income=收入
            period(string): 周期快捷选项：today/this_week/this_month/this_year/last_month/last_year/all
            start_date(string): 自定义起始日期 YYYY-MM-DD
            end_date(string): 自定义结束日期 YYYY-MM-DD
        """
        try:
            repo = _repo()
            sd, ed = _resolve_period(period, start_date, end_date)
            type_ = (type or "expense").strip().lower()
            rows = await repo.get_category_breakdown(type_, sd, ed)
            if not rows:
                return {"ok": True, "message": "该区间无数据", "breakdown": []}
            total = sum(float(r["amount"]) for r in rows)
            currency = _cfg("currency", "¥")
            lines = [f"分类占比（{sd or '不限'} ~ {ed or '至今'}，共 {currency}{total:.2f}）"]
            for r in rows:
                amt = float(r["amount"])
                pct = (amt / total * 100) if total else 0
                name = r.get("name") or "未分类"
                icon = r.get("icon") or ""
                lines.append(f"  {icon} {name}: {currency}{amt:.2f} ({pct:.1f}%, {r['count']} 笔)")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "breakdown": rows,
                "total": total,
            }
        except Exception as e:
            return {"ok": False, "error": f"统计失败：{e}"}

    @filter.llm_tool(name="bookkeeping_trend")
    async def trend(
        self,
        event: AstrMessageEvent,
        granularity: str = "daily",
        period: str = "this_month",
        type: str = "expense",
        start_date: str = "",
        end_date: str = "",
    ):
        """查看消费/收入趋势，按日或按月聚合。常用于回答"最近支出趋势/今年每月花多少"。

        Args:
            granularity(string): 粒度：daily=按日 / monthly=按月
            period(string): 周期快捷选项 today/this_week/this_month/this_year/last_month/last_year/all
            type(string): 类型 expense/income
            start_date(string): 自定义起始日期
            end_date(string): 自定义结束日期
        """
        try:
            repo = _repo()
            sd, ed = _resolve_period(period, start_date, end_date)
            rows = []
            if granularity == "monthly":
                year = int((sd or datetime.now().strftime("%Y-%m-%d"))[:4])
                rows = await repo.get_monthly_trend(year, (type or "expense").strip().lower())
            else:
                if not sd or not ed:
                    return {"ok": False, "error": "按日趋势需要明确的起止日期"}
                rows = await repo.get_daily_trend(sd, ed, (type or "expense").strip().lower())
            if not rows:
                return {"ok": True, "message": "无趋势数据", "trend": []}
            currency = _cfg("currency", "¥")
            label = "日期" if granularity == "daily" else "月份"
            lines = [f"趋势（{label} | 金额 | 笔数）"]
            for r in rows:
                key = r.get("tx_date") or r.get("month", "")
                lines.append(f"  {key}: {currency}{float(r['amount']):.2f} ({r['count']} 笔)")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "trend": rows,
                "granularity": granularity,
            }
        except Exception as e:
            return {"ok": False, "error": f"统计失败：{e}"}

    @filter.llm_tool(name="bookkeeping_top_transactions")
    async def top_transactions(
        self,
        event: AstrMessageEvent,
        type: str = "expense",
        limit: int = 10,
        period: str = "this_month",
        start_date: str = "",
        end_date: str = "",
    ):
        """查看金额最大的 Top N 笔交易，常用于"这个月花得最多的几笔是什么"。

        Args:
            type(string): 类型 expense/income
            limit(int): 返回条数，默认 10，最大 50
            period(string): 周期快捷选项
            start_date(string): 起始日期
            end_date(string): 结束日期
        """
        try:
            repo = _repo()
            sd, ed = _resolve_period(period, start_date, end_date)
            limit = max(1, min(int(limit or 10), 50))
            rows = await repo.get_top_transactions(
                (type or "expense").strip().lower(), limit, sd, ed
            )
            if not rows:
                return {"ok": True, "message": "无数据", "top_transactions": []}
            currency = _cfg("currency", "¥")
            lines = [f"Top {limit}（{type}）"]
            for i, tx in enumerate(rows, 1):
                lines.append(f"{i}. {currency}{float(tx['amount']):.2f} | {tx.get('category_name') or '未分类'} | {tx.get('account_name','')} | {tx.get('tx_date','')} | {tx.get('note','')}")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "top_transactions": rows,
            }
        except Exception as e:
            return {"ok": False, "error": f"统计失败：{e}"}

    @filter.llm_tool(name="bookkeeping_tag_stats")
    async def tag_stats(
        self,
        event: AstrMessageEvent,
        period: str = "this_month",
        start_date: str = "",
        end_date: str = "",
    ):
        """按标签统计金额（如 #出差 共花了多少）。

        Args:
            period(string): 周期快捷选项
            start_date(string): 起始日期
            end_date(string): 结束日期
        """
        try:
            repo = _repo()
            sd, ed = _resolve_period(period, start_date, end_date)
            rows = await repo.get_tag_stats(sd, ed)
            if not rows:
                return {"ok": True, "message": "无标签数据", "tag_stats": []}
            currency = _cfg("currency", "¥")
            lines = [f"标签统计（{sd or '不限'} ~ {ed or '至今'}）"]
            for r in rows:
                lines.append(f"  #{r['name']}: {currency}{float(r['amount']):.2f} ({r['count']} 笔)")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "tag_stats": rows,
            }
        except Exception as e:
            return {"ok": False, "error": f"统计失败：{e}"}

    # ============== 账户管理 ==============

    @filter.llm_tool(name="bookkeeping_list_accounts")
    async def list_accounts(self, event: AstrMessageEvent):
        """列出所有账户（含数字 ID）及当前余额。常用于"我还有多少钱/各账户余额"。
        记账、转账、对账等操作优先使用本工具返回的账户 ID（account_id）。"""
        try:
            repo = _repo()
            accounts = await repo.list_accounts()
            if not accounts:
                return {"ok": True, "message": "暂无账户", "accounts": []}
            currency = _cfg("currency", "¥")
            total = sum(float(a["balance"]) for a in accounts)
            lines = [f"账户列表（合计 {currency}{total:.2f}），记账请用账户 ID："]
            for a in accounts:
                lines.append(f"  • id={a['id']} {a['name']}（{a['type']}）: {currency}{float(a['balance']):.2f}")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "accounts": accounts,
                "total_balance": total,
            }
        except Exception as e:
            return {"ok": False, "error": f"查询失败：{e}"}

    @filter.llm_tool(name="bookkeeping_add_account")
    async def add_account(
        self,
        event: AstrMessageEvent,
        name: str,
        type: str = "cash",
        initial_balance: float = 0,
        note: str = "",
    ):
        """新建一个账户。可以创建任意多个同类型账户（如多张银行卡），只要 name 不重复。
        新账户会自动分配一个固定数字 id，返回结果中可查看，后续记账/转账/对账可直接用该 id 引用。

        type 字段是开放文本，预设建议取值：
          cash=现金 / bank=银行卡 / alipay=支付宝 / wechat=微信 / credit=信用卡 / other
        也可自定义任意字符串（如 "招商" "基金" "公积金" 等），不影响余额计算。

        例如：用户说"新建招商卡、工行卡两张银行卡"时，应该调用本工具两次：
          1) name=招商卡, type=bank
          2) name=工行卡, type=bank

        Args:
            name(string): 账户名（唯一，同类型可多张）
            type(string): 账户类型，建议取 cash/bank/alipay/wechat/credit/other，也支持自定义字符串
            initial_balance(number): 初始余额，默认 0
            note(string): 备注
        """
        try:
            repo = _repo()
            acc = await repo.add_account(name, (type or "cash").strip().lower(), float(initial_balance or 0), note or "")
            currency = _cfg("currency", "¥")
            return {
                "ok": True,
                "message": f"已创建账户「{acc['name']}」(id={acc['id']})，余额 {currency}{float(acc['balance']):.2f}",
                "account": acc,
            }
        except Exception as e:
            return {"ok": False, "error": f"创建失败（可能重名）：{e}"}

    @filter.llm_tool(name="bookkeeping_adjust_balance")
    async def adjust_balance(
        self,
        event: AstrMessageEvent,
        account: str = "",
        account_id: int = 0,
        new_balance: float = 0,
        note: str = "",
    ):
        """调整账户余额为指定值（用于对账）。会打印调整前后差额。
        账户可用数字 ID（account_id，优先）或名称（account）。

        Args:
            account(string): 账户名（与 account_id 二选一，建议优先用 ID）
            account_id(int): 账户数字 ID，优先于 account
            new_balance(number): 调整后的真实余额
            note(string): 调整原因
        """
        try:
            repo = _repo()
            accounts = await repo.list_accounts()
            acc = _resolve_account(accounts, account, account_id)
            if not acc:
                return {"ok": False, "error": f"找不到账户（名称「{account or ''}」/ID {account_id or ''}）", "hint": f"可用账户：{_accounts_hint(accounts)}"}
            old = float(acc["balance"])
            updated = await repo.adjust_balance(acc["id"], float(new_balance), note)
            currency = _cfg("currency", "¥")
            diff = float(new_balance) - old
            sign = "+" if diff >= 0 else ""
            return {
                "ok": True,
                "message": (
                    f"已调整「{account}」余额\n"
                    f"  旧：{currency}{old:.2f}\n"
                    f"  新：{currency}{float(new_balance):.2f}\n"
                    f"  差额：{sign}{currency}{diff:.2f}"
                ),
                "account": updated,
                "old_balance": old,
                "new_balance": float(new_balance),
                "difference": diff,
            }
        except Exception as e:
            return {"ok": False, "error": f"调整失败：{e}"}

    @filter.llm_tool(name="bookkeeping_archive_account")
    async def archive_account(
        self, event: AstrMessageEvent, account: str = "", account_id: int = 0, archived: bool = True
    ):
        """归档/恢复账户（不删除历史交易）。归档后账户不再出现在默认列表与统计中，但历史交易保留。

        适用于：账户停用但想保留历史记录的场景。
        账户可用数字 ID（account_id，优先）或名称（account）。

        Args:
            account(string): 账户名（与 account_id 二选一，建议优先用 ID）
            account_id(int): 账户数字 ID，优先于 account
            archived(bool): true=归档 false=恢复
        """
        try:
            repo = _repo()
            accounts = await repo.list_accounts(include_archived=True)
            acc = _resolve_account(accounts, account, account_id)
            if not acc:
                return {"ok": False, "error": f"找不到账户（名称「{account or ''}」/ID {account_id or ''}）", "hint": f"可用账户：{_accounts_hint(accounts)}"}
            await repo.update_account(acc["id"], archived=archived)
            action = "归档" if archived else "恢复"
            return {"ok": True, "message": f"已{action}账户「{acc['name']}」(id={acc['id']})"}
        except Exception as e:
            return {"ok": False, "error": f"失败：{e}"}

    @filter.llm_tool(name="bookkeeping_delete_account")
    async def delete_account(self, event: AstrMessageEvent, account: str = "", account_id: int = 0):
        """彻底删除一个账户。仅当该账户没有任何关联交易时才能删除。

        如果账户已被交易引用，删除会失败 —— 此时请改用 bookkeeping_archive_account 归档，
        或者先删除/迁移该账户的所有交易。删除操作不可恢复。
        账户可用数字 ID（account_id，优先）或名称（account）。

        常见场景：
        • 用户误建的账户（如重复创建、写错名字）且尚未记账 → 可直接删除
        • 已经有交易历史的账户 → 建议归档而不是删除

        Args:
            account(string): 要删除的账户名（与 account_id 二选一，建议优先用 ID）
            account_id(int): 要删除的账户数字 ID，优先于 account
        """
        try:
            repo = _repo()
            accounts = await repo.list_accounts(include_archived=True)
            acc = _resolve_account(accounts, account, account_id)
            if not acc:
                return {"ok": False, "error": f"找不到账户（名称「{account or ''}」/ID {account_id or ''}）", "hint": f"可用账户：{_accounts_hint(accounts)}"}
            try:
                ok = await repo.delete_account(acc["id"])
            except ValueError as ve:
                return {
                    "ok": False,
                    "error": str(ve),
                    "suggestion": (
                        f"若只是不再使用，请归档账户 {acc['name']}(id={acc['id']})；"
                        "若确实要删除，请先删除该账户下的所有交易"
                    ),
                }
            if ok:
                return {"ok": True, "message": f"已删除账户「{acc['name']}」(id={acc['id']})"}
            return {"ok": False, "error": "删除失败"}
        except Exception as e:
            logger.error(f"delete_account error: {e}")
            return {"ok": False, "error": f"删除失败：{e}"}

    # ============== 分类管理 ==============

    @filter.llm_tool(name="bookkeeping_list_categories")
    async def list_categories(self, event: AstrMessageEvent, type: str = ""):
        """列出所有分类。type 可选 expense/income，空则全部。

        Args:
            type(string): expense=支出分类 / income=收入分类 / 空=全部
        """
        try:
            repo = _repo()
            cats = await repo.list_categories((type or "").strip().lower() or None)
            if not cats:
                return {"ok": True, "message": "暂无分类", "categories": []}
            lines = ["分类列表"]
            cur_type = None
            for c in cats:
                if c["type"] != cur_type:
                    cur_type = c["type"]
                    lines.append(f"【{'支出' if cur_type == 'expense' else '收入'}】")
                lines.append(f"  {c.get('icon','')} {c['name']} (id={c['id']})")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "categories": cats,
            }
        except Exception as e:
            return {"ok": False, "error": f"查询失败：{e}"}

    @filter.llm_tool(name="bookkeeping_add_category")
    async def add_category(
        self,
        event: AstrMessageEvent,
        name: str,
        type: str,
        icon: str = "",
        color: str = "",
    ):
        """新增一个分类。

        Args:
            name(string): 分类名
            type(string): expense=支出 / income=收入
            icon(string): Emoji 图标，可空
            color(string): 颜色值，可空
        """
        try:
            repo = _repo()
            type_ = (type or "").strip().lower()
            if type_ not in ("expense", "income"):
                return {"ok": False, "error": "type 必须是 expense/income"}
            cat = await repo.add_category(name, type_, icon or "", color or "", sort=50)
            return {
                "ok": True,
                "message": f"已新增分类「{cat['name']}」(id={cat['id']})",
                "category": cat,
            }
        except Exception as e:
            return {"ok": False, "error": f"创建失败：{e}"}

    @filter.llm_tool(name="bookkeeping_delete_category")
    async def delete_category(self, event: AstrMessageEvent, name: str):
        """删除分类。已关联的交易会自动清空分类字段。

        Args:
            name(string): 分类名
        """
        try:
            repo = _repo()
            cat = await repo.find_category_by_name(name)
            if not cat:
                return {"ok": False, "error": f"找不到分类「{name}」"}
            await repo.delete_category(cat["id"])
            return {"ok": True, "message": f"已删除分类「{name}」"}
        except Exception as e:
            return {"ok": False, "error": f"删除失败：{e}"}

    # ============== 标签管理 ==============

    @filter.llm_tool(name="bookkeeping_list_tags")
    async def list_tags(self, event: AstrMessageEvent):
        """列出所有标签及使用次数。"""
        try:
            repo = _repo()
            tags = await repo.list_tags()
            if not tags:
                return {"ok": True, "message": "暂无标签", "tags": []}
            lines = ["标签列表"]
            for t in tags:
                lines.append(f"  #{t['name']}（{t['usage_count']} 笔）")
            return {
                "ok": True,
                "message": "\n".join(lines),
                "tags": tags,
            }
        except Exception as e:
            return {"ok": False, "error": f"查询失败：{e}"}

    @filter.llm_tool(name="bookkeeping_help")
    async def bookkeeping_help(self, event: AstrMessageEvent):
        """记账插件能力说明，列出所有可用功能与示例，引导用户使用。"""
        help_text = """📒 记账插件能力说明（自然语言对话即可使用）

【记账】
 • "记一笔 餐饮 50 午餐" / "今天打车 23 元"
 • "工资到账 8000" / "微信红包 200"

【转账】
 • "从银行卡转 500 到支付宝"

【查询】
 • "本月账单" / "上月支出"
 • "餐饮花了多少" / "最近 10 笔"
 • "搜索关键字：出差"

【统计】
 • "这个月花了多少"
 • "钱花在哪了"（分类占比）
 • "今年每月支出趋势"
 • "本月最大 5 笔消费"
 • "#出差 共花了多少"（标签统计）

【账户】
 • "我还有多少钱" / "账户余额"
 • "新建账户 储蓄卡 余额 5000"
 • "调整支付宝余额到 1234.5"
 • 每个账户都有固定数字 ID，记账/转账/对账时可直接用 ID（如"用账户 2 记餐饮 50"）

【管理】
 • "列出分类" / "新增分类 健身 🏋️"
 • "列出标签" / "删除交易 #5"

💡 直接用自然语言描述需求即可，无需记指令。"""
        return {"ok": True, "message": help_text}

    # 注册到插件类
    from astrbot.core.star.star_handler import star_handlers_registry

    _target_module = plugin_cls.__module__
    _tool_funcs = [
        add_transaction, transfer_between_accounts, list_transactions,
        update_transaction, delete_transaction, get_transaction_detail,
        get_summary, category_breakdown, trend, top_transactions,
        tag_stats, list_accounts, add_account, adjust_balance,
        archive_account, delete_account, list_categories, add_category,
        delete_category, list_tags, bookkeeping_help,
    ]
    for _f in _tool_funcs:
        _f.__module__ = _target_module
        _new_full_name = f"{_target_module}_{_f.__name__}"
        _hmap = star_handlers_registry.star_handlers_map
        for _md in star_handlers_registry:
            if _md.handler is _f:
                _old_full_name = _md.handler_full_name
                _md.handler_module_path = _target_module
                _md.handler_full_name = _new_full_name
                if _old_full_name != _new_full_name and _old_full_name in _hmap:
                    del _hmap[_old_full_name]
                _hmap[_new_full_name] = _md
                break
        setattr(plugin_cls, _f.__name__, _f)


# ============== 工具函数 ==============

def _resolve_period(period: str, start_date: str, end_date: str) -> tuple[Optional[str], Optional[str]]:
    """把周期快捷词解析为 (start_date, end_date) ISO 字符串。"""
    today = datetime.now().date()
    if start_date and end_date:
        return start_date, end_date
    if not period or period == "all":
        return None, None
    p = period.strip().lower()
    if p == "today":
        return today.isoformat(), today.isoformat()
    if p == "this_week":
        start = today - timedelta(days=today.weekday())
        return start.isoformat(), today.isoformat()
    if p == "this_month":
        start = today.replace(day=1)
        from calendar import monthrange
        last = monthrange(today.year, today.month)[1]
        end = today.replace(day=last)
        return start.isoformat(), end.isoformat()
    if p == "last_month":
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        first_prev = last_prev.replace(day=1)
        return first_prev.isoformat(), last_prev.isoformat()
    if p == "this_year":
        return f"{today.year}-01-01", f"{today.year}-12-31"
    if p == "last_year":
        return f"{today.year-1}-01-01", f"{today.year-1}-12-31"
    if start_date:
        return start_date, None
    if end_date:
        return None, end_date
    return None, None
