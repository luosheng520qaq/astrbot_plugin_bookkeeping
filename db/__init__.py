"""SQLite 数据库连接与初始化。"""
from __future__ import annotations

import aiosqlite
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL,                 -- cash / bank / alipay / wechat / credit / other
    balance     REAL NOT NULL DEFAULT 0,
    note        TEXT DEFAULT '',
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,                 -- expense / income
    icon        TEXT DEFAULT '',
    color       TEXT DEFAULT '',
    sort        INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (name, type)
);

CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,             -- expense / income / transfer
    amount          REAL NOT NULL,
    category_id    INTEGER,
    account_id     INTEGER NOT NULL,
    to_account_id  INTEGER,                    -- 仅 transfer 使用
    note            TEXT DEFAULT '',
    tx_date         TEXT NOT NULL,             -- ISO 日期 YYYY-MM-DD
    tx_time         TEXT NOT NULL,             -- HH:MM:SS
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id)   REFERENCES categories(id) ON DELETE SET NULL,
    FOREIGN KEY (account_id)    REFERENCES accounts(id)    ON DELETE RESTRICT,
    FOREIGN KEY (to_account_id) REFERENCES accounts(id)    ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date     ON transactions(tx_date);
CREATE INDEX IF NOT EXISTS idx_tx_type     ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_account  ON transactions(account_id);

CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id INTEGER NOT NULL,
    tag_id         INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, tag_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id)         REFERENCES tags(id)         ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS balance_adjustments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER NOT NULL,
    old_balance  REAL NOT NULL,
    new_balance  REAL NOT NULL,
    note         TEXT DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

DEFAULT_CATEGORIES = [
    # 支出
    ("餐饮", "expense", "🍚", "#FF6B6B", 1),
    ("交通", "expense", "🚌", "#4ECDC4", 2),
    ("购物", "expense", "🛍️", "#FFD93D", 3),
    ("住房", "expense", "🏠", "#6C5CE7", 4),
    ("娱乐", "expense", "🎮", "#A29BFE", 5),
    ("医疗", "expense", "💊", "#FF7675", 6),
    ("教育", "expense", "📚", "#74B9FF", 7),
    ("通讯", "expense", "📱", "#00CEC9", 8),
    ("日用", "expense", "🧴", "#FDCB6E", 9),
    ("其他支出", "expense", "💸", "#B2BEC3", 99),
    # 收入
    ("工资", "income", "💰", "#00B894", 1),
    ("奖金", "income", "🎁", "#55EFC4", 2),
    ("理财", "income", "📈", "#81ECEC", 3),
    ("兼职", "income", "💼", "#FDCB6E", 4),
    ("红包", "income", "🧧", "#FF7675", 5),
    ("其他收入", "income", "💵", "#B2BEC3", 99),
]

DEFAULT_ACCOUNTS = [
    ("现金", "cash", 0, ""),
    ("支付宝", "alipay", 0, ""),
    ("微信", "wechat", 0, ""),
    ("银行卡", "bank", 0, ""),
]


class Database:
    """异步 SQLite 数据库封装。"""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._conn: Optional[aiosqlite.Connection] = None

    async def init(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row
        # 启用外键约束：schema 里声明的 ON DELETE CASCADE/SET NULL 才会生效，
        # 否则删除交易/标签会在 transaction_tags 里残留孤儿记录，导致标签使用次数虚高。
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.executescript(SCHEMA)
        # 清理历史遗留的孤立关联（早期版本未启用外键时产生的脏数据）
        await self._conn.execute(
            "DELETE FROM transaction_tags WHERE transaction_id NOT IN (SELECT id FROM transactions)"
        )
        await self._seed_defaults()
        await self._conn.commit()

    async def _seed_defaults(self) -> None:
        # 分类
        for name, t, icon, color, sort in DEFAULT_CATEGORIES:
            await self._conn.execute(
                "INSERT OR IGNORE INTO categories(name, type, icon, color, sort) VALUES(?,?,?,?,?)",
                (name, t, icon, color, sort),
            )
        # 账户
        for name, t, bal, note in DEFAULT_ACCOUNTS:
            await self._conn.execute(
                "INSERT OR IGNORE INTO accounts(name, type, balance, note) VALUES(?,?,?,?)",
                (name, t, bal, note),
            )
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database not initialized")
        return self._conn

    # ---- 基础查询封装 ----
    async def execute(self, sql: str, params: Iterable[Any] = ()) -> aiosqlite.Cursor:
        cur = await self.conn.execute(sql, tuple(params))
        await self.conn.commit()
        return cur

    async def executemany(self, sql: str, params_iter: Iterable[Iterable[Any]]) -> None:
        await self.conn.executemany(sql, [tuple(p) for p in params_iter])
        await self.conn.commit()

    async def fetchone(self, sql: str, params: Iterable[Any] = ()) -> Optional[aiosqlite.Row]:
        cur = await self.conn.execute(sql, tuple(params))
        return await cur.fetchone()

    async def fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[aiosqlite.Row]:
        cur = await self.conn.execute(sql, tuple(params))
        return await cur.fetchall()
