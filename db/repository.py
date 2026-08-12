"""数据访问层：CRUD + 多维查询 + 统计聚合。

所有方法返回 dict / list[dict]，避免上层耦合 sqlite3.Row。
"""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import date, datetime, timedelta
from typing import Any, Optional

from . import Database


def _row_to_dict(row) -> dict:
    return dict(row) if row is not None else {}


def _rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]


def _today_iso() -> tuple[str, str]:
    now = datetime.now()
    return now.strftime("%Y-%m-%d"), now.strftime("%H:%M:%S")


def _month_range(year: int, month: int) -> tuple[str, str]:
    start = date(year, month, 1)
    if month == 12:
        end = date(year, 12, 31)
    else:
        end = date(year, month + 1, 1) - timedelta(days=1)
    return start.isoformat(), end.isoformat()


class Repository:
    def __init__(self, db: Database):
        self.db = db

    # ==================== 交易 ====================
    async def add_transaction(
        self,
        type_: str,
        amount: float,
        account_id: int,
        category_id: Optional[int] = None,
        to_account_id: Optional[int] = None,
        note: str = "",
        tx_date: Optional[str] = None,
        tx_time: Optional[str] = None,
        tag_names: Optional[list[str]] = None,
    ) -> dict:
        if type_ not in ("expense", "income", "transfer"):
            raise ValueError(f"type must be expense/income/transfer, got {type_}")
        if amount <= 0:
            raise ValueError("amount must be > 0")
        if type_ == "transfer":
            if not to_account_id:
                raise ValueError("转账必须指定转入账户")
            if to_account_id == account_id:
                raise ValueError("转出与转入账户不能相同")
        if tx_date is None or tx_time is None:
            d, t = _today_iso()
            tx_date = tx_date or d
            tx_time = tx_time or t

        cur = await self.db.execute(
            """INSERT INTO transactions(type, amount, category_id, account_id, to_account_id, note, tx_date, tx_time)
               VALUES(?,?,?,?,?,?,?,?)""",
            (type_, amount, category_id, account_id, to_account_id, note, tx_date, tx_time),
        )
        tx_id = cur.lastrowid

        # 更新账户余额
        await self._apply_transaction_balance(type_, amount, account_id, to_account_id)

        # 关联标签
        if tag_names:
            await self._link_tags(tx_id, tag_names)

        await self.db.execute(
            "UPDATE transactions SET updated_at=datetime('now') WHERE id=?", (tx_id,)
        )
        return await self.get_transaction(tx_id) or {"id": tx_id}

    async def _apply_transaction_balance(
        self, type_: str, amount: float, account_id: int, to_account_id: Optional[int]
    ) -> None:
        if type_ == "expense":
            await self.db.execute(
                "UPDATE accounts SET balance=balance-?, updated_at=datetime('now') WHERE id=?",
                (amount, account_id),
            )
        elif type_ == "income":
            await self.db.execute(
                "UPDATE accounts SET balance=balance+?, updated_at=datetime('now') WHERE id=?",
                (amount, account_id),
            )
        elif type_ == "transfer":
            await self.db.execute(
                "UPDATE accounts SET balance=balance-?, updated_at=datetime('now') WHERE id=?",
                (amount, account_id),
            )
            await self.db.execute(
                "UPDATE accounts SET balance=balance+?, updated_at=datetime('now') WHERE id=?",
                (amount, to_account_id),
            )

    async def _revert_transaction_balance(self, tx: dict) -> None:
        """删除/更新前回滚旧交易对余额的影响。"""
        t = tx["type"]
        amt = float(tx["amount"])
        aid = tx["account_id"]
        to_aid = tx.get("to_account_id")
        if t == "expense":
            await self.db.execute("UPDATE accounts SET balance=balance+? WHERE id=?", (amt, aid))
        elif t == "income":
            await self.db.execute("UPDATE accounts SET balance=balance-? WHERE id=?", (amt, aid))
        elif t == "transfer":
            await self.db.execute("UPDATE accounts SET balance=balance+? WHERE id=?", (amt, aid))
            if to_aid:
                await self.db.execute("UPDATE accounts SET balance=balance-? WHERE id=?", (amt, to_aid))

    async def update_transaction(self, tx_id: int, **fields) -> Optional[dict]:
        tx = await self.get_transaction(tx_id)
        if not tx:
            return None

        # 处理余额回滚与重新应用
        new_type = fields.get("type", tx["type"])
        new_amount = float(fields.get("amount", tx["amount"]))
        new_account_id = fields.get("account_id", tx["account_id"])
        new_to_account = fields.get("to_account_id", tx.get("to_account_id"))

        await self._revert_transaction_balance(tx)

        # 更新字段
        allowed = {"type", "amount", "category_id", "account_id", "to_account_id", "note", "tx_date", "tx_time"}
        sets, vals = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k}=?")
                vals.append(v)
        if sets:
            sets.append("updated_at=datetime('now')")
            vals.append(tx_id)
            await self.db.execute(f"UPDATE transactions SET {', '.join(sets)} WHERE id=?", vals)

        # 标签同步
        if "tag_names" in fields:
            await self.db.execute("DELETE FROM transaction_tags WHERE transaction_id=?", (tx_id,))
            if fields["tag_names"]:
                await self._link_tags(tx_id, fields["tag_names"])

        # 重新应用余额
        await self._apply_transaction_balance(new_type, new_amount, new_account_id, new_to_account)
        return await self.get_transaction(tx_id)

    async def delete_transaction(self, tx_id: int) -> bool:
        tx = await self.get_transaction(tx_id)
        if not tx:
            return False
        await self._revert_transaction_balance(tx)
        await self.db.execute("DELETE FROM transactions WHERE id=?", (tx_id,))
        return True

    async def get_transaction(self, tx_id: int) -> Optional[dict]:
        row = await self.db.fetchone(
            """SELECT t.*, c.name AS category_name, c.type AS category_type,
                      a.name AS account_name, ta.name AS to_account_name
               FROM transactions t
               LEFT JOIN categories c ON c.id=t.category_id
               LEFT JOIN accounts a ON a.id=t.account_id
               LEFT JOIN accounts ta ON ta.id=t.to_account_id
               WHERE t.id=?""",
            (tx_id,),
        )
        if not row:
            return None
        tx = _row_to_dict(row)
        tx["tags"] = await self._get_tx_tags(tx_id)
        return tx

    async def _get_tx_tags(self, tx_id: int) -> list[str]:
        rows = await self.db.fetchall(
            """SELECT t.name FROM tags t
               JOIN transaction_tags tt ON tt.tag_id=t.id
               WHERE tt.transaction_id=? ORDER BY t.name""",
            (tx_id,),
        )
        return [r["name"] for r in rows]

    async def _link_tags(self, tx_id: int, tag_names: list[str]) -> None:
        for name in tag_names:
            name = name.strip().lstrip("#")
            if not name:
                continue
            # upsert tag
            await self.db.execute(
                "INSERT OR IGNORE INTO tags(name) VALUES(?)", (name,)
            )
            row = await self.db.fetchone("SELECT id FROM tags WHERE name=?", (name,))
            if row:
                await self.db.execute(
                    "INSERT OR IGNORE INTO transaction_tags(transaction_id, tag_id) VALUES(?,?)",
                    (tx_id, row["id"]),
                )

    def _build_tx_where(
        self,
        type_: Optional[str] = None,
        category_id: Optional[int] = None,
        account_id: Optional[int] = None,
        tag: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        keyword: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
    ) -> tuple[str, list[Any]]:
        """构建交易筛选 WHERE 片段（配合 JOIN 后的 t. 前缀），供 list/count 共用。"""
        sql = " WHERE 1=1"
        params: list[Any] = []
        if type_:
            sql += " AND t.type=?"; params.append(type_)
        if category_id is not None:
            sql += " AND t.category_id=?"; params.append(category_id)
        if account_id is not None:
            sql += " AND (t.account_id=? OR t.to_account_id=?)"; params.extend([account_id, account_id])
        if tag:
            sql += " AND tg.name=?"; params.append(tag)
        if start_date:
            sql += " AND t.tx_date>=?"; params.append(start_date)
        if end_date:
            sql += " AND t.tx_date<=?"; params.append(end_date)
        if keyword:
            sql += " AND t.note LIKE ?"; params.append(f"%{keyword}%")
        if min_amount is not None:
            sql += " AND t.amount>=?"; params.append(min_amount)
        if max_amount is not None:
            sql += " AND t.amount<=?"; params.append(max_amount)
        return sql, params

    async def _fetch_transactions_batch(self, ids: list[int]) -> list[dict]:
        """一次查询批量取交易详情 + 标签，避免逐条查询（N+1）。"""
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        rows = await self.db.fetchall(
            f"""SELECT t.*, c.name AS category_name, c.type AS category_type,
                       a.name AS account_name, ta.name AS to_account_name
                FROM transactions t
                LEFT JOIN categories c ON c.id=t.category_id
                LEFT JOIN accounts a ON a.id=t.account_id
                LEFT JOIN accounts ta ON ta.id=t.to_account_id
                WHERE t.id IN ({placeholders})""",
            ids,
        )
        by_id = {r["id"]: dict(r) for r in rows}
        tag_rows = await self.db.fetchall(
            f"""SELECT tt.transaction_id, tg.name
                FROM transaction_tags tt
                JOIN tags tg ON tg.id=tt.tag_id
                WHERE tt.transaction_id IN ({placeholders})
                ORDER BY tg.name""",
            ids,
        )
        tags_map: dict[int, list[str]] = {}
        for r in tag_rows:
            tags_map.setdefault(r["transaction_id"], []).append(r["name"])
        result: list[dict] = []
        for tid in ids:
            tx = by_id.get(tid)
            if tx is None:
                continue
            tx["tags"] = tags_map.get(tid, [])
            result.append(tx)
        return result

    async def list_transactions(
        self,
        type_: Optional[str] = None,
        category_id: Optional[int] = None,
        account_id: Optional[int] = None,
        tag: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        keyword: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
        limit: int = 50,
        offset: int = 0,
        order_by: str = "tx_date DESC, tx_time DESC, t.id DESC",
    ) -> list[dict]:
        # 防御：把裸的 id 替换为 t.id，避免与 tags/transaction_tags 的 id 列冲突
        order_by = re.sub(r"(?<!\.)\bid\b", "t.id", order_by)
        where, params = self._build_tx_where(
            type_, category_id, account_id, tag,
            start_date, end_date, keyword, min_amount, max_amount,
        )
        sql = f"""SELECT DISTINCT t.id FROM transactions t
                 LEFT JOIN transaction_tags tt ON tt.transaction_id=t.id
                 LEFT JOIN tags tg ON tg.id=tt.tag_id
                 {where}
                 ORDER BY {order_by} LIMIT ? OFFSET ?"""
        params.extend([limit, offset])

        rows = await self.db.fetchall(sql, params)
        ids = [r["id"] for r in rows]
        if not ids:
            return []
        return await self._fetch_transactions_batch(ids)

    async def count_transactions(
        self,
        type_: Optional[str] = None,
        category_id: Optional[int] = None,
        account_id: Optional[int] = None,
        tag: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        keyword: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
    ) -> int:
        """按与 list_transactions 相同的筛选条件统计总数（用于分页）。"""
        where, params = self._build_tx_where(
            type_, category_id, account_id, tag,
            start_date, end_date, keyword, min_amount, max_amount,
        )
        sql = f"""SELECT COUNT(DISTINCT t.id) AS c FROM transactions t
                 LEFT JOIN transaction_tags tt ON tt.transaction_id=t.id
                 LEFT JOIN tags tg ON tg.id=tt.tag_id
                 {where}"""
        row = await self.db.fetchone(sql, params)
        return row["c"] if row else 0

    # ==================== 账户 ====================
    async def list_accounts(self, include_archived: bool = False) -> list[dict]:
        sql = "SELECT * FROM accounts"
        if not include_archived:
            sql += " WHERE archived=0"
        sql += " ORDER BY id"
        return _rows_to_dicts(await self.db.fetchall(sql))

    async def get_account(self, account_id: int) -> Optional[dict]:
        row = await self.db.fetchone("SELECT * FROM accounts WHERE id=?", (account_id,))
        return _row_to_dict(row) if row else None

    async def add_account(self, name: str, type_: str, balance: float = 0, note: str = "") -> dict:
        cur = await self.db.execute(
            "INSERT INTO accounts(name, type, balance, note) VALUES(?,?,?,?)",
            (name, type_, balance, note),
        )
        return await self.get_account(cur.lastrowid) or {"id": cur.lastrowid, "name": name}

    async def update_account(
        self, account_id: int, name: Optional[str] = None, type_: Optional[str] = None,
        note: Optional[str] = None, archived: Optional[bool] = None,
    ) -> Optional[dict]:
        sets, vals = [], []
        if name is not None: sets.append("name=?"); vals.append(name)
        if type_ is not None: sets.append("type=?"); vals.append(type_)
        if note is not None: sets.append("note=?"); vals.append(note)
        if archived is not None: sets.append("archived=?"); vals.append(1 if archived else 0)
        if not sets:
            return await self.get_account(account_id)
        sets.append("updated_at=datetime('now')")
        vals.append(account_id)
        await self.db.execute(f"UPDATE accounts SET {', '.join(sets)} WHERE id=?", vals)
        return await self.get_account(account_id)

    async def adjust_balance(self, account_id: int, new_balance: float, note: str = "") -> Optional[dict]:
        acc = await self.get_account(account_id)
        if not acc:
            return None
        old_balance = float(acc["balance"])
        await self.db.execute(
            "UPDATE accounts SET balance=?, updated_at=datetime('now') WHERE id=?",
            (new_balance, account_id),
        )
        # 记录对账流水，避免"备注丢失"；历史上已对账过的不补记
        await self.db.execute(
            "INSERT INTO balance_adjustments(account_id, old_balance, new_balance, note) VALUES(?,?,?,?)",
            (account_id, old_balance, float(new_balance), note or ""),
        )
        return await self.get_account(account_id)

    async def delete_account(self, account_id: int) -> bool:
        # 检查是否被交易引用
        cnt = await self.db.fetchone(
            "SELECT COUNT(*) AS c FROM transactions WHERE account_id=? OR to_account_id=?",
            (account_id, account_id),
        )
        if cnt and cnt["c"] > 0:
            raise ValueError("账户存在关联交易，无法删除；可改用归档 (archived=true)")
        await self.db.execute("DELETE FROM accounts WHERE id=?", (account_id,))
        return True

    # ==================== 分类 ====================
    async def list_categories(self, type_: Optional[str] = None) -> list[dict]:
        sql = "SELECT * FROM categories"
        params = []
        if type_:
            sql += " WHERE type=?"; params.append(type_)
        sql += " ORDER BY sort, id"
        return _rows_to_dicts(await self.db.fetchall(sql, params))

    async def get_category(self, category_id: int) -> Optional[dict]:
        row = await self.db.fetchone("SELECT * FROM categories WHERE id=?", (category_id,))
        return _row_to_dict(row) if row else None

    async def find_category_by_name(self, name: str, type_: Optional[str] = None) -> Optional[dict]:
        sql = "SELECT * FROM categories WHERE name=?"
        params: list[Any] = [name]
        if type_:
            sql += " AND type=?"; params.append(type_)
        row = await self.db.fetchone(sql, params)
        return _row_to_dict(row) if row else None

    async def add_category(
        self, name: str, type_: str, icon: str = "", color: str = "", sort: int = 0,
    ) -> dict:
        cur = await self.db.execute(
            "INSERT INTO categories(name, type, icon, color, sort) VALUES(?,?,?,?,?)",
            (name, type_, icon, color, sort),
        )
        return await self.get_category(cur.lastrowid) or {"id": cur.lastrowid, "name": name}

    async def update_category(
        self, category_id: int, name: Optional[str] = None, icon: Optional[str] = None,
        color: Optional[str] = None, sort: Optional[int] = None,
        archived: Optional[bool] = None,
    ) -> Optional[dict]:
        sets, vals = [], []
        if name is not None: sets.append("name=?"); vals.append(name)
        if icon is not None: sets.append("icon=?"); vals.append(icon)
        if color is not None: sets.append("color=?"); vals.append(color)
        if sort is not None: sets.append("sort=?"); vals.append(sort)
        if archived is not None: sets.append("archived=?"); vals.append(1 if archived else 0)
        if not sets:
            return await self.get_category(category_id)
        vals.append(category_id)
        await self.db.execute(f"UPDATE categories SET {', '.join(sets)} WHERE id=?", vals)
        return await self.get_category(category_id)

    async def delete_category(self, category_id: int) -> bool:
        await self.db.execute(
            "UPDATE transactions SET category_id=NULL WHERE category_id=?", (category_id,)
        )
        await self.db.execute("DELETE FROM categories WHERE id=?", (category_id,))
        return True

    # ==================== 标签 ====================
    async def list_tags(self) -> list[dict]:
        rows = await self.db.fetchall(
            """SELECT t.id, t.name, COUNT(tt.transaction_id) AS usage_count
               FROM tags t LEFT JOIN transaction_tags tt ON tt.tag_id=t.id
               GROUP BY t.id ORDER BY usage_count DESC, t.name"""
        )
        return _rows_to_dicts(rows)

    async def add_tag(self, name: str) -> dict:
        name = name.strip().lstrip("#")
        await self.db.execute("INSERT OR IGNORE INTO tags(name) VALUES(?)", (name,))
        row = await self.db.fetchone("SELECT * FROM tags WHERE name=?", (name,))
        return _row_to_dict(row) if row else {"name": name}

    async def delete_tag(self, tag_id: int) -> bool:
        await self.db.execute("DELETE FROM tags WHERE id=?", (tag_id,))
        return True

    # ==================== 统计 ====================
    async def get_summary(
        self, start_date: Optional[str] = None, end_date: Optional[str] = None
    ) -> dict:
        """收支汇总。"""
        where, params = "", []
        if start_date:
            where += " AND tx_date>=?"; params.append(start_date)
        if end_date:
            where += " AND tx_date<=?"; params.append(end_date)

        # 收支总额
        row = await self.db.fetchone(
            f"""SELECT
                COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS total_expense,
                COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS total_income,
                COALESCE(SUM(CASE WHEN type='transfer' THEN amount END),0) AS total_transfer,
                COUNT(*) AS tx_count
                FROM transactions WHERE 1=1 {where}""",
            params,
        )
        expense = float(row["total_expense"]) if row else 0
        income = float(row["total_income"]) if row else 0
        return {
            "total_expense": expense,
            "total_income": income,
            "balance": income - expense,
            "tx_count": row["tx_count"] if row else 0,
            "start_date": start_date,
            "end_date": end_date,
        }

    async def get_category_breakdown(
        self, type_: str = "expense",
        start_date: Optional[str] = None, end_date: Optional[str] = None,
    ) -> list[dict]:
        where, params = ["t.type=?"], [type_]
        if start_date:
            where.append("t.tx_date>=?"); params.append(start_date)
        if end_date:
            where.append("t.tx_date<=?"); params.append(end_date)
        rows = await self.db.fetchall(
            f"""SELECT c.id, c.name, c.icon, c.color,
                       SUM(t.amount) AS amount, COUNT(t.id) AS count
                FROM transactions t
                LEFT JOIN categories c ON c.id=t.category_id
                WHERE {' AND '.join(where)}
                GROUP BY c.id
                ORDER BY amount DESC NULLS LAST""",
            params,
        )
        return _rows_to_dicts(rows)

    async def get_daily_trend(
        self, start_date: str, end_date: str, type_: str = "expense"
    ) -> list[dict]:
        rows = await self.db.fetchall(
            """SELECT tx_date, SUM(amount) AS amount, COUNT(*) AS count
               FROM transactions
               WHERE type=? AND tx_date>=? AND tx_date<=?
               GROUP BY tx_date ORDER BY tx_date""",
            (type_, start_date, end_date),
        )
        return _rows_to_dicts(rows)

    async def get_monthly_trend(self, year: int, type_: str = "expense") -> list[dict]:
        start = f"{year}-01-01"; end = f"{year}-12-31"
        rows = await self.db.fetchall(
            """SELECT substr(tx_date,1,7) AS month, SUM(amount) AS amount, COUNT(*) AS count
               FROM transactions WHERE type=? AND tx_date>=? AND tx_date<=?
               GROUP BY month ORDER BY month""",
            (type_, start, end),
        )
        return _rows_to_dicts(rows)

    async def get_top_transactions(
        self, type_: str = "expense", limit: int = 10,
        start_date: Optional[str] = None, end_date: Optional[str] = None,
    ) -> list[dict]:
        sql = """SELECT t.*, c.name AS category_name, a.name AS account_name
                 FROM transactions t
                 LEFT JOIN categories c ON c.id=t.category_id
                 LEFT JOIN accounts a ON a.id=t.account_id
                 WHERE t.type=?"""
        params: list[Any] = [type_]
        if start_date:
            sql += " AND t.tx_date>=?"; params.append(start_date)
        if end_date:
            sql += " AND t.tx_date<=?"; params.append(end_date)
        sql += " ORDER BY t.amount DESC LIMIT ?"
        params.append(limit)
        return _rows_to_dicts(await self.db.fetchall(sql, params))

    async def get_account_distribution(self) -> list[dict]:
        rows = await self.db.fetchall(
            """SELECT id, name, type, balance FROM accounts WHERE archived=0 ORDER BY balance DESC"""
        )
        return _rows_to_dicts(rows)

    async def get_tag_stats(
        self, start_date: Optional[str] = None, end_date: Optional[str] = None
    ) -> list[dict]:
        where, params = [], []
        if start_date:
            where.append("t.tx_date>=?"); params.append(start_date)
        if end_date:
            where.append("t.tx_date<=?"); params.append(end_date)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        rows = await self.db.fetchall(
            f"""SELECT tg.name, SUM(t.amount) AS amount, COUNT(*) AS count
                FROM transaction_tags tt
                JOIN tags tg ON tg.id=tt.tag_id
                JOIN transactions t ON t.id=tt.transaction_id
                {where_sql}
                GROUP BY tg.id ORDER BY amount DESC""",
            params,
        )
        return _rows_to_dicts(rows)

    # ==================== 导入导出 ====================
    async def export_transactions_csv(self, transactions: list[dict]) -> str:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "type", "amount", "category", "account", "to_account", "note", "date", "time", "tags"])
        for tx in transactions:
            writer.writerow([
                tx.get("id", ""), tx.get("type", ""), tx.get("amount", 0),
                tx.get("category_name", "") or "", tx.get("account_name", "") or "",
                tx.get("to_account_name", "") or "", tx.get("note", "") or "",
                tx.get("tx_date", ""), tx.get("tx_time", ""),
                "|".join(tx.get("tags", [])),
            ])
        return buf.getvalue()

    async def export_all_json(self) -> dict:
        return {
            "accounts": await self.list_accounts(include_archived=True),
            "categories": await self.list_categories(),
            "tags": await self.list_tags(),
            "transactions": await self.list_transactions(limit=100000),
            "exported_at": datetime.now().isoformat(),
        }
