"""Web API 路由处理（适配 AstrBot 4.27+ 的 astrbot.api.web 公开 API）。

所有 handler 为 async 函数，通过 `request` 全局代理读取参数，
返回值通过 json_response / error_response / file_response 包装。
"""
from __future__ import annotations

import json
from datetime import datetime as _dt
from typing import Any, Optional

from astrbot.api import logger
from astrbot.api.web import (
    request,
    json_response,
    error_response,
    stream_response,
)

from .db.repository import Repository


def _ok(data: Any = None, msg: str = "ok"):
    return json_response({"code": 0, "msg": msg, "data": data})


def _err(msg: str, status: int = 400, code: int = 1):
    return error_response(msg, status_code=status, data={"code": code})


async def _json_body() -> dict:
    """读取 POST body，兼容空 body 与 form。"""
    try:
        body = await request.json(default=None)
        if isinstance(body, dict):
            return body
    except Exception:
        pass
    try:
        form = await request.form()
        if form:
            return {k: v for k, v in form.items()}
    except Exception:
        pass
    return {}


def _arg(name: str, default: Any = None, cast: Optional[type] = None, source: dict | None = None):
    """从 query 或 body 中读取参数。"""
    src = source if source is not None else _request_args()
    if name not in src or src[name] in (None, ""):
        return default
    val = src[name]
    if cast is bool:
        if isinstance(val, str):
            return val.lower() in ("1", "true", "yes", "on")
        return bool(val)
    if cast is int:
        try:
            return int(val)
        except (TypeError, ValueError):
            return default
    if cast is float:
        try:
            return float(val)
        except (TypeError, ValueError):
            return default
    return val


def _request_args() -> dict:
    """读取 query 参数。"""
    args: dict[str, Any] = {}
    try:
        for k, v in request.query.items():
            args[k] = v
    except Exception:
        pass
    return args


async def _read_all_args() -> dict:
    """合并 query + body，方便 GET/POST 通用。"""
    merged: dict[str, Any] = {}
    try:
        for k, v in request.query.items():
            merged[k] = v
    except Exception:
        pass
    body = await _json_body()
    merged.update(body)
    return merged


class WebAPI:
    """Web API 路由集合。

    使用方式：
        web_api = WebAPI(repo, plugin_name)
        context.register_web_api(f"/{plugin_name}/transactions",
                                  web_api.list_transactions, ["GET"], "list transactions")
    """

    def __init__(self, repo: Repository, plugin_name: str, config: dict | None = None):
        self.repo = repo
        self.plugin_name = plugin_name
        self.config: dict = config or {}

    # ==================== 交易 ====================
    async def list_transactions(self):
        try:
            args = await _read_all_args()
            filters = dict(
                type_=_arg("type", None, str, args) or None,
                category_id=_arg("category_id", None, int, args),
                account_id=_arg("account_id", None, int, args),
                tag=_arg("tag", None, str, args) or None,
                start_date=_arg("start_date", None, str, args) or None,
                end_date=_arg("end_date", None, str, args) or None,
                keyword=_arg("keyword", None, str, args) or None,
                min_amount=_arg("min_amount", None, float, args),
                max_amount=_arg("max_amount", None, float, args),
            )
            limit = _arg("limit", 50, int, args)
            offset = _arg("offset", 0, int, args)
            txs = await self.repo.list_transactions(limit=limit, offset=offset, **filters)
            total = await self.repo.count_transactions(**filters)
            return _ok({"items": txs, "total": total, "limit": limit, "offset": offset})
        except Exception as e:
            logger.error(f"web list_transactions: {e}")
            return _err(str(e), 500)

    async def get_transaction(self):
        try:
            args = await _read_all_args()
            tx_id = _arg("id", None, int, args)
            if not tx_id:
                return _err("id required")
            tx = await self.repo.get_transaction(tx_id)
            if not tx:
                return _err("transaction not found", 404)
            return _ok(tx)
        except Exception as e:
            return _err(str(e), 500)

    async def create_transaction(self):
        try:
            body = await _json_body()
            type_ = (body.get("type") or "").strip().lower()
            amount = float(body.get("amount", 0))
            account_id = int(body.get("account_id", 0))
            if not type_ or amount <= 0 or not account_id:
                return _err("type/amount/account_id required")

            category_id = int(body["category_id"]) if body.get("category_id") else None
            to_account_id = int(body["to_account_id"]) if body.get("to_account_id") else None
            if type_ == "transfer":
                if not to_account_id:
                    return _err("转账必须指定转入账户 to_account_id")
                if to_account_id == account_id:
                    return _err("转出与转入账户不能相同")

            tag_names = body.get("tags")
            if isinstance(tag_names, str):
                tag_names = [t.strip() for t in tag_names.split(",") if t.strip()]
            elif tag_names is None:
                tag_names = []

            tx = await self.repo.add_transaction(
                type_=type_, amount=amount, account_id=account_id,
                category_id=category_id,
                to_account_id=to_account_id,
                note=body.get("note", "") or "",
                tx_date=body.get("tx_date") or None,
                tx_time=body.get("tx_time") or None,
                tag_names=tag_names,
            )
            return _ok(tx, "created")
        except ValueError as ve:
            return _err(str(ve))
        except Exception as e:
            logger.error(f"web create_transaction: {e}")
            return _err(str(e), 500)

    async def update_transaction(self):
        try:
            body = await _json_body()
            tx_id = int(body.get("id", 0))
            if not tx_id:
                return _err("id required")
            fields: dict[str, Any] = {}
            for k in ("type", "amount", "account_id", "to_account_id", "note", "tx_date", "tx_time"):
                if k in body:
                    val = body[k]
                    if k in ("amount", "account_id", "to_account_id") and val not in (None, ""):
                        val = float(val) if k == "amount" else int(val)
                    fields[k] = val
            if "category_id" in body:
                fields["category_id"] = int(body["category_id"]) if body["category_id"] else None
            if "tags" in body:
                tn = body["tags"]
                if isinstance(tn, str):
                    tn = [t.strip() for t in tn.split(",") if t.strip()]
                fields["tag_names"] = tn or []

            updated = await self.repo.update_transaction(tx_id, **fields)
            if not updated:
                return _err("transaction not found", 404)
            return _ok(updated, "updated")
        except Exception as e:
            logger.error(f"web update_transaction: {e}")
            return _err(str(e), 500)

    async def delete_transaction(self):
        try:
            args = await _read_all_args()
            tx_id = _arg("id", None, int, args)
            if not tx_id:
                return _err("id required")
            ok = await self.repo.delete_transaction(tx_id)
            return _ok({"id": tx_id, "deleted": ok})
        except Exception as e:
            return _err(str(e), 500)

    # ==================== 账户 ====================
    async def list_accounts(self):
        try:
            args = await _read_all_args()
            include_archived = _arg("include_archived", False, bool, args)
            accounts = await self.repo.list_accounts(include_archived=include_archived)
            total_balance = sum(float(a["balance"]) for a in accounts)
            return _ok({"items": accounts, "total_balance": total_balance})
        except Exception as e:
            return _err(str(e), 500)

    async def create_account(self):
        try:
            body = await _json_body()
            name = (body.get("name") or "").strip()
            if not name:
                return _err("name required")
            acc = await self.repo.add_account(
                name, (body.get("type") or "cash").strip().lower(),
                float(body.get("balance", 0) or 0), body.get("note", "") or "",
            )
            return _ok(acc, "created")
        except Exception as e:
            return _err(str(e), 500)

    async def update_account(self):
        try:
            body = await _json_body()
            acc_id = int(body.get("id", 0))
            if not acc_id:
                return _err("id required")
            updated = await self.repo.update_account(
                acc_id,
                name=body.get("name"),
                type_=body.get("type"),
                note=body.get("note"),
                archived=body.get("archived"),
            )
            if not updated:
                return _err("account not found", 404)
            return _ok(updated, "updated")
        except Exception as e:
            return _err(str(e), 500)

    async def adjust_balance(self):
        try:
            body = await _json_body()
            acc_id = int(body.get("id", 0))
            new_balance = float(body.get("balance", 0))
            note = body.get("note", "")
            if not acc_id:
                return _err("id required")
            updated = await self.repo.adjust_balance(acc_id, new_balance, note)
            if not updated:
                return _err("account not found", 404)
            return _ok(updated, "adjusted")
        except Exception as e:
            return _err(str(e), 500)

    async def delete_account(self):
        try:
            args = await _read_all_args()
            acc_id = _arg("id", None, int, args)
            if not acc_id:
                return _err("id required")
            try:
                ok = await self.repo.delete_account(acc_id)
            except ValueError as ve:
                return _err(str(ve), 400)
            return _ok({"id": acc_id, "deleted": ok})
        except Exception as e:
            return _err(str(e), 500)

    # ==================== 分类 ====================
    async def list_categories(self):
        try:
            args = await _read_all_args()
            type_ = _arg("type", None, str, args)
            cats = await self.repo.list_categories(type_)
            return _ok({"items": cats})
        except Exception as e:
            return _err(str(e), 500)

    async def create_category(self):
        try:
            body = await _json_body()
            name = (body.get("name") or "").strip()
            type_ = (body.get("type") or "").strip().lower()
            if not name or type_ not in ("expense", "income"):
                return _err("name and type(expense/income) required")
            cat = await self.repo.add_category(
                name, type_, body.get("icon", "") or "", body.get("color", "") or "",
                int(body.get("sort", 0) or 0),
            )
            return _ok(cat, "created")
        except Exception as e:
            return _err(str(e), 500)

    async def update_category(self):
        try:
            body = await _json_body()
            cat_id = int(body.get("id", 0))
            if not cat_id:
                return _err("id required")
            updated = await self.repo.update_category(
                cat_id,
                name=body.get("name"),
                icon=body.get("icon"),
                color=body.get("color"),
                sort=int(body["sort"]) if body.get("sort") is not None else None,
                archived=body.get("archived"),
            )
            if not updated:
                return _err("category not found", 404)
            return _ok(updated, "updated")
        except Exception as e:
            return _err(str(e), 500)

    async def delete_category(self):
        try:
            args = await _read_all_args()
            cat_id = _arg("id", None, int, args)
            if not cat_id:
                return _err("id required")
            await self.repo.delete_category(cat_id)
            return _ok({"id": cat_id, "deleted": True})
        except Exception as e:
            return _err(str(e), 500)

    # ==================== 标签 ====================
    async def list_tags(self):
        try:
            tags = await self.repo.list_tags()
            return _ok({"items": tags})
        except Exception as e:
            return _err(str(e), 500)

    async def create_tag(self):
        try:
            body = await _json_body()
            name = (body.get("name") or "").strip().lstrip("#")
            if not name:
                return _err("name required")
            tag = await self.repo.add_tag(name)
            return _ok(tag, "created")
        except Exception as e:
            return _err(str(e), 500)

    async def delete_tag(self):
        try:
            args = await _read_all_args()
            tag_id = _arg("id", None, int, args)
            if not tag_id:
                return _err("id required")
            await self.repo.delete_tag(tag_id)
            return _ok({"id": tag_id, "deleted": True})
        except Exception as e:
            return _err(str(e), 500)

    # ==================== 统计 ====================
    async def get_summary(self):
        try:
            args = await _read_all_args()
            s = await self.repo.get_summary(
                _arg("start_date", None, str, args), _arg("end_date", None, str, args)
            )
            return _ok(s)
        except Exception as e:
            return _err(str(e), 500)

    async def category_breakdown(self):
        try:
            args = await _read_all_args()
            type_ = _arg("type", "expense", str, args)
            rows = await self.repo.get_category_breakdown(
                type_, _arg("start_date", None, str, args), _arg("end_date", None, str, args)
            )
            return _ok({"items": rows, "type": type_})
        except Exception as e:
            return _err(str(e), 500)

    async def daily_trend(self):
        try:
            args = await _read_all_args()
            rows = await self.repo.get_daily_trend(
                _arg("start_date", None, str, args), _arg("end_date", None, str, args),
                _arg("type", "expense", str, args),
            )
            return _ok({"items": rows})
        except Exception as e:
            return _err(str(e), 500)

    async def monthly_trend(self):
        try:
            args = await _read_all_args()
            year = _arg("year", _dt.now().year, int, args)
            rows = await self.repo.get_monthly_trend(year, _arg("type", "expense", str, args))
            return _ok({"items": rows, "year": year})
        except Exception as e:
            return _err(str(e), 500)

    async def top_transactions(self):
        try:
            args = await _read_all_args()
            rows = await self.repo.get_top_transactions(
                _arg("type", "expense", str, args),
                _arg("limit", 10, int, args),
                _arg("start_date", None, str, args),
                _arg("end_date", None, str, args),
            )
            return _ok({"items": rows})
        except Exception as e:
            return _err(str(e), 500)

    async def account_distribution(self):
        try:
            rows = await self.repo.get_account_distribution()
            return _ok({"items": rows})
        except Exception as e:
            return _err(str(e), 500)

    async def tag_stats(self):
        try:
            args = await _read_all_args()
            rows = await self.repo.get_tag_stats(
                _arg("start_date", None, str, args), _arg("end_date", None, str, args)
            )
            return _ok({"items": rows})
        except Exception as e:
            return _err(str(e), 500)

    async def dashboard(self):
        """仪表盘聚合接口：支持 start_date/end_date 区间筛选，缺省为当月。"""
        try:
            args = await _read_all_args()
            from datetime import date
            from calendar import monthrange
            today = date.today()
            start = _arg("start_date", None, str, args)
            end = _arg("end_date", None, str, args)
            if not start:
                start = today.replace(day=1).isoformat()
            if not end:
                last = monthrange(today.year, today.month)[1]
                end = today.replace(day=last).isoformat()

            summary = await self.repo.get_summary(start, end)
            cat_expense = await self.repo.get_category_breakdown("expense", start, end)
            cat_income = await self.repo.get_category_breakdown("income", start, end)
            daily_expense = await self.repo.get_daily_trend(start, end, "expense")
            daily_income = await self.repo.get_daily_trend(start, end, "income")
            top = await self.repo.get_top_transactions("expense", 5, start, end)
            tag_stats = await self.repo.get_tag_stats(start, end)
            accounts = await self.repo.list_accounts()
            recent_txs = await self.repo.list_transactions(limit=10, offset=0)
            return _ok({
                "summary": summary,
                "categories_expense": cat_expense,
                "categories_income": cat_income,
                "daily_expense": daily_expense,
                "daily_income": daily_income,
                "top_expense": top,
                "tag_stats": tag_stats,
                "accounts": accounts,
                "recent_transactions": recent_txs,
                "range": {"start": start, "end": end},
            })
        except Exception as e:
            logger.error(f"web dashboard: {e}")
            return _err(str(e), 500)

    # ==================== 导入导出 ====================
    async def export_json(self):
        """导出全部数据为 JSON 文件（沙箱内通过 bridge.download 下载）。"""
        try:
            data = await self.repo.export_all_json()
            payload = json.dumps(data, ensure_ascii=False, indent=2)

            async def gen():
                yield payload

            return stream_response(
                gen(),
                content_type="application/json; charset=utf-8",
                headers={"Content-Disposition": "attachment; filename=bookkeeping_data.json"},
            )
        except Exception as e:
            return _err(str(e), 500)

    async def export_csv(self):
        """导出交易为 CSV（支持与列表页一致的筛选参数）。用流式响应便于大文件下载。"""
        try:
            args = await _read_all_args()
            txs = await self.repo.list_transactions(
                type_=_arg("type", None, str, args) or None,
                category_id=_arg("category_id", None, int, args),
                account_id=_arg("account_id", None, int, args),
                tag=_arg("tag", None, str, args) or None,
                start_date=_arg("start_date", None, str, args) or None,
                end_date=_arg("end_date", None, str, args) or None,
                keyword=_arg("keyword", None, str, args) or None,
                limit=100000,
            )
            csv_text = await self.repo.export_transactions_csv(txs)
            # 加 BOM 让 Excel 正确识别 UTF-8
            payload = "\ufeff" + csv_text

            async def gen():
                yield payload

            return stream_response(
                gen(),
                content_type="text/csv; charset=utf-8",
                headers={"Content-Disposition": "attachment; filename=transactions.csv"},
            )
        except Exception as e:
            return _err(str(e), 500)

    async def healthz(self):
        # 向 WebUI 暴露配置：前端用它初始化动漫背景 API 等
        cfg = self.config or {}
        anime_bg = cfg.get("anime_bg_api", [])
        # list 类型配置返回数组；兼容老版本字符串写法
        if isinstance(anime_bg, str):
            anime_bg = [u.strip() for u in anime_bg.replace("，", ",").split(",") if u.strip()]
        elif not isinstance(anime_bg, list):
            anime_bg = []
        return _ok({
            "status": "ok",
            "plugin": self.plugin_name,
            "config": {
                "currency": cfg.get("currency", "¥"),
                "timezone": cfg.get("timezone", "Asia/Shanghai"),
                "warn_large_amount": cfg.get("warn_large_amount", 0),
                "page_size": cfg.get("page_size", 20),
                "enable_image_receipt": cfg.get("enable_image_receipt", True),
                "anime_bg_api": anime_bg,
            },
        })
