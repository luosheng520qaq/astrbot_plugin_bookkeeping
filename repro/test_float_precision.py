"""验证浮点精度优化：
1. 100 - 9.02 不再出现 90.97999999999999
2. 多次小数运算不累积误差
3. 老库中已有的脏数据在 init 时被清洗
运行：python repro/test_float_precision.py
"""
import asyncio
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import Database
from db.repository import Repository


async def test_normal_ops():
    db = Database(Path(tempfile.mkdtemp()) / "t.db")
    await db.init()
    repo = Repository(db)
    acc = await repo.add_account("测试", "cash", 100.00)

    # 1) 100 - 9.02
    tx = await repo.add_transaction("expense", 9.02, acc["id"], note="x")
    after = await repo.get_account(acc["id"])
    print("[1] 100-9.02 =>", repr(after["balance"]))
    assert after["balance"] == 90.98, f"应为 90.98，实际 {after['balance']!r}"

    # 2) 多次 0.01 累加 3 次，不得累积误差
    for i in range(3):
        await repo.add_transaction("expense", 0.01, acc["id"], note=f"y{i}")
    after2 = await repo.get_account(acc["id"])
    print("[2] 三次扣 0.01 =>", repr(after2["balance"]))
    assert after2["balance"] == 90.95, f"应为 90.95，实际 {after2['balance']!r}"

    # 3) 收入 19.99
    await repo.add_transaction("income", 19.99, acc["id"], note="z")
    after3 = await repo.get_account(acc["id"])
    print("[3] 加 19.99 =>", repr(after3["balance"]))
    assert after3["balance"] == 110.94, f"应为 110.94，实际 {after3['balance']!r}"

    await db.close()


async def test_legacy_cleanup():
    # 手工造一个带脏数据的"老库"
    tmp = Path(tempfile.mkdtemp()) / "legacy.db"
    conn = sqlite3.connect(tmp)
    conn.executescript("""
        CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0, note TEXT DEFAULT '',
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
            amount REAL NOT NULL, category_id INTEGER, account_id INTEGER NOT NULL,
            to_account_id INTEGER, note TEXT DEFAULT '', tx_date TEXT NOT NULL,
            tx_time TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO accounts(name, type, balance) VALUES('脏账户', 'cash', 90.97999999999999);
        INSERT INTO transactions(type, amount, account_id, tx_date, tx_time)
            VALUES('expense', 9.01999999999999, 1, '2026-01-01', '00:00:00');
    """)
    conn.commit()
    conn.close()

    db = Database(tmp)
    await db.init()
    repo = Repository(db)
    acc = await repo.get_account(1)
    tx = await repo.get_transaction(1)
    print("[4] 清洗后 balance =>", repr(acc["balance"]), "| amount =>", repr(tx["amount"]))
    assert acc["balance"] == 90.98, f"脏余额未清洗：{acc['balance']!r}"
    assert tx["amount"] == 9.02, f"脏金额未清洗：{tx['amount']!r}"
    await db.close()


async def main():
    await test_normal_ops()
    await test_legacy_cleanup()
    print("\nALL PASS")


asyncio.run(main())
