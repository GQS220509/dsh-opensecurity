# -*- coding: utf-8 -*-
"""summary: 批量查询 —— 一次 idat 会话内顺序执行多个查询操作

description:
  背景：每次 `idat -A -S` 调用都要付一次冷启动（进程启动 + 加载 .i64 + auto_wait），
  通常是秒级；而单个查询本身往往只要几十毫秒。真实分析一次要查十几个函数，
  逐个调用等于把冷启动付十几次。本脚本在**同一个已加载的数据库**上跑完 N 个操作。

  这是 dsh 插件 `os_ida_batch` 工具的后端。模型只写操作数组，命令行的拼装、
  环境变量的映射、输出的落盘全部由插件负责。

  环境变量：
    IDA_BATCH_FILE   必填，JSON 数组文件，每项形如
                     {"operation": "decompile", "address": "main", "pattern": "...",
                      "readMode": "auto", "readSize": 64, "dereference": true,
                      "forceCreate": true}
    IDA_OUTPUT       必填，结果 JSON 的落盘路径
    IDA_BATCH_CALLER 由插件设置。非空表示"作为库被导入"，
                     因此 query.py 的单查询入口不会执行（见其文件末尾）。

  输出结构：
    {"success": bool, "total": N, "succeeded": n, "failed": m,
     "results": [{"index": i, "operation": op, "success": bool,
                  "data": {...} | null, "error": str | null}, ...]}

  设计要点：
  1. **复用 query.py 的 `_QUERY_HANDLERS`**，不另写一份分发表。
     单查和批查因此接受**完全一样**的字段，行为不可能分叉——这正是
     "批量"最容易写错的地方（两份协议各自演化）。
  2. **单项失败不中断整批**。每个操作独立 try/except，失败写进该项目的
     `error`，其余操作照跑。一次手滑不该毁掉全部已完成的工作。
  3. **整批仍然以 0/1 退出码表达结果**：只要有任意一项成功，success=True，
     退出码 0——半成功的结果比"全丢"有用得多，而"哪几项失败"在结果里。

level: intermediate
"""

import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _base import env_str, run_headless

# 导入 query 模块即可拿到它的 _QUERY_HANDLERS 与全部查询实现。
# query.py 末尾的单查询入口被 IDA_BATCH_CALLER 守卫挡住，因此这里是纯导入。
import query


def _text(value):
    """把 JSON 解出的字符串统一成环境变量能接受的形式。

    Python 2.7 的 json 解出的是 unicode，而 `isinstance(u"x", str)` 是 **False**
    （str 是字节串，unicode 是另一支）。所以"是不是字符串"必须同时认这两支，否则
    每一项带地址的操作都会被当成"没给地址"，表现为 6 个操作齐刷刷报
    "无法解析函数/地址"。写进 os.environ 前再编码成字节串：2.7 的 os.environ 在
    Windows 上对 unicode 值不总是可靠。
    """
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value
    if isinstance(value, str) or isinstance(value, unicode):  # noqa: F821 - py2 only
        return value.encode("utf-8")
    return str(value)


def _write_env(mapping):
    """按操作设置 IDA_* 环境变量；先清掉上一个操作留下的键，避免串味。

    串味是真实风险：`xrefs_to` 用 IDA_PATTERN 定位，紧接着跑 `functions`
    时若不清除，就会拿上一个操作的模式去过滤。所以这里做的是"重置到基线"
    而不是"叠加"。
    """
    for key in (
        "IDA_QUERY",
        "IDA_FUNC_ADDR",
        "IDA_ADDR",
        "IDA_PATTERN",
        "IDA_READ_MODE",
        "IDA_READ_SIZE",
        "IDA_DEREF",
        "IDA_FORCE_CREATE",
    ):
        if key in os.environ:
            del os.environ[key]
    for key, value in mapping.items():
        os.environ[key] = value


def _operation_env(operation):
    """把一项操作翻译成 query.py 读取的 IDA_* 环境变量。

    这是 lib/index.js 里 `operationEnv()` 的 Python 侧对应物：插件负责在
    idat 启动之前把参数校验到"一定能跑"，这里只做翻译。
    """
    op = _text(operation.get("operation"))
    env = {"IDA_QUERY": op}
    address = _text(operation.get("address"))
    pattern = _text(operation.get("pattern"))
    if address:
        env["IDA_FUNC_ADDR"] = address
        env["IDA_ADDR"] = address
    if pattern:
        env["IDA_PATTERN"] = pattern
        if not address:
            env["IDA_ADDR"] = pattern
    if op == "read_data":
        mode = _text(operation.get("readMode"))
        env["IDA_READ_MODE"] = mode if mode else "auto"
        size = operation.get("readSize")
        if isinstance(size, int):
            env["IDA_READ_SIZE"] = str(size)
        if operation.get("dereference") is True:
            env["IDA_DEREF"] = "1"
    if op in ("decompile", "disassemble", "func_info") and operation.get("forceCreate") is True:
        env["IDA_FORCE_CREATE"] = "1"
    return env


def _load_operations():
    """读取批量操作文件；返回 (operations, error)。"""
    path = env_str("IDA_BATCH_FILE", "")
    if not path:
        return None, "IDA_BATCH_FILE environment variable is not set"
    if not os.path.isfile(path):
        return None, "batch file does not exist: {0}".format(path)
    try:
        with open(path, "rb") as handle:
            payload = json.loads(handle.read().decode("utf-8"))
    except ValueError as exc:
        # `ValueError` covers both `json.JSONDecodeError` (Python 3) and the
        # plain `ValueError` Python 2.7's json module raises.
        return None, "batch file is not valid JSON: {0}".format(exc)
    except (IOError, OSError) as exc:
        return None, "batch file could not be read: {0}".format(exc)

    if isinstance(payload, dict):
        payload = payload.get("operations")
    if not isinstance(payload, list) or not payload:
        return None, "batch file must contain a non-empty JSON array of operations"
    return payload, None


def _main():
    from _base import log

    operations, error = _load_operations()
    if error is not None:
        log("[!] {0}\n".format(error))
        return {
            "success": False,
            "total": 0,
            "succeeded": 0,
            "failed": 0,
            "results": [],
            "error": error,
        }

    log("[*] batch: {0} operations in one IDA session\n".format(len(operations)))

    results = []
    succeeded = 0
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            results.append(
                {
                    "index": index,
                    "operation": None,
                    "success": False,
                    "data": None,
                    "error": "operation #{0} is not an object".format(index),
                }
            )
            continue
        op = operation.get("operation", "")
        handler = query._QUERY_HANDLERS.get(op)
        if handler is None:
            available = ", ".join(sorted(query._QUERY_HANDLERS.keys()))
            results.append(
                {
                    "index": index,
                    "operation": op,
                    "success": False,
                    "data": None,
                    "error": 'unknown operation "{0}"; expected one of {1}'.format(op, available),
                }
            )
            continue

        log("[*] batch {0}/{1}: {2}\n".format(index + 1, len(operations), op))
        try:
            _write_env(_operation_env(operation))
            data = handler()
        except Exception as exc:  # one bad entry must not end the batch
            results.append(
                {
                    "index": index,
                    "operation": op,
                    "success": False,
                    "data": None,
                    "error": "{0}: {1}".format(type(exc).__name__, exc),
                    "traceback": traceback.format_exc(),
                }
            )
            continue

        if isinstance(data, dict) and "error" in data and "success" not in data:
            results.append(
                {
                    "index": index,
                    "operation": op,
                    "success": False,
                    "data": None,
                    "error": data["error"],
                }
            )
            continue

        results.append(
            {"index": index, "operation": op, "success": True, "data": data, "error": None}
        )
        succeeded += 1

    failed = len(results) - succeeded
    log("[+] batch done: {0} ok, {1} failed\n".format(succeeded, failed))
    return {
        "success": succeeded > 0,
        "total": len(operations),
        "succeeded": succeeded,
        "failed": failed,
        "results": results,
        "error": None if succeeded > 0 else "every operation in the batch failed",
    }


run_headless(_main)
