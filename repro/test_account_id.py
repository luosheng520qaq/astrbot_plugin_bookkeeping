"""一次性验证脚本：模拟新用户首次初始化 + 账户 ID 分配 + 按 ID/名称记账。
运行：python repro/test_account_id.py
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db import Database
from db.repository import Repository
from llm_tools import _resolve_account, _accounts_hint


async def main():
    tmp = tempfile.mkdtemp()
    db = Database(Path(tmp) / "bookkeeping.db")
    await db.init()
    repo = Repository(db)

    # 1) 首次初始化：默认账户自动有自增 ID
    accs = await repo.list_accounts()
    print("[init] 默认账户:", [(a["id"], a["name"]) for a in accs])
    assert accs and all(a["id"] for a in accs), "默认账户必须都有数字 ID"

    # 2) 新建账户自动分配 ID
    acc = await repo.add_account("招商卡", "bank", 1000, "测试卡")
    print("[add_account] 新账户:", acc["id"], acc["name"], acc["balance"])
    assert acc["id"] and acc["id"] not in [a["id"] for a in accs], "新账户 ID 不能与已有冲突"

    # 3) 按 ID 记账（支出）
    tx = await repo.add_transaction("expense", 50, acc["id"], note="午饭")
    print("[tx] 按 ID 记账:", tx["id"], "account_id=", tx["account_id"], "余额后=", tx["balance_after"])
    assert tx["account_id"] == acc["id"]

    # 4) 转账：按 ID
    src = accs[0]
    tx2 = await repo.add_transaction("transfer", 200, src["id"], to_account_id=acc["id"], note="还钱")
    print("[tx] 按 ID 转账:", tx2["id"], f"{src['id']}->{acc['id']}")

    # 5) _resolve_account 各种入参
    accounts = await repo.list_accounts(include_archived=True)
    r1 = _resolve_account(accounts, account_id=acc["id"])
    r2 = _resolve_account(accounts, name=acc["name"])
    r3 = _resolve_account(accounts, name=str(acc["id"]))  # 字符串数字当 ID
    r4 = _resolve_account(accounts, name="不存在的账户")
    print("[resolve] 按ID:", r1["name"] if r1 else None,
          "| 按名称:", r2["name"] if r2 else None,
          "| 字符串ID:", r3["name"] if r3 else None,
          "| 不存在:", r4)
    assert r1 and r1["id"] == acc["id"]
    assert r2 and r2["id"] == acc["id"]
    assert r3 and r3["id"] == acc["id"]
    assert r4 is None

    # 6) 统计与余额（确保按 ID 记账后余额正确）
    summary = await repo.get_summary()
    print("[summary] 支出=%.2f 收入=%.2f 结余=%.2f" % (
        summary["total_expense"], summary["total_income"], summary["balance"]))
    acc_after = await repo.get_account(acc["id"])
    print("[balance] 招商卡余额:", acc_after["balance"])
    # 1000 初始 - 50 支出 + 200 转入 = 1150
    assert abs(acc_after["balance"] - 1150) < 1e-6, f"余额应为 1150，实际 {acc_after['balance']}"

    # 7) 模拟"老用户升级"：关闭后重新 init（CREATE TABLE IF NOT EXISTS 幂等），
    #    账户 ID 与交易记录必须原样保留。
    db_path = db.db_path
    await db.close()
    db2 = Database(db_path)
    await db2.init()
    repo2 = Repository(db2)
    accs2 = await repo2.list_accounts(include_archived=True)
    by_id = {a["id"]: a["name"] for a in accs2}
    print("[reopen] 账户:", by_id)
    assert by_id.get(acc["id"]) == "招商卡", "重开后账户 ID/名称必须保留"
    txs2 = await repo2.list_transactions(limit=10)
    print("[reopen] 交易:", [(t["id"], t["account_id"], t["to_account_id"]) for t in txs2])
    assert len(txs2) == 2, "重开后交易必须保留"
    pairs = {(t["account_id"], t["to_account_id"]) for t in txs2}
    assert (acc["id"], None) in pairs and (src["id"], acc["id"]) in pairs, "交易仍须引用原账户 ID"
    await db2.close()
    print("\nALL PASS")


asyncio.run(main())
