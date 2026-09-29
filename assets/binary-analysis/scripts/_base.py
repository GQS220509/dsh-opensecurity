# -*- coding: utf-8 -*-
"""summary: IDA Pro AI 智能分析命令 — 公共基础模块

description:
  提供所有工具脚本共享的基础设施，包括：
  1. log(msg) — 日志输出（中文、[*]/[+]/[!] 前缀）
  2. env_str(key, default) — 读取环境变量字符串
  3. env_bool(key) — 读取布尔环境变量
  4. env_int(key, default) — 读取整数环境变量
  5. write_json_output(output_path, result) — JSON 输出到文件
  6. run_headless(business_func) — headless 入口模板

  所有工具脚本（query.py、update.py、scripts/*.py）必须 import 此模块，
  使用 run_headless() 驱动 headless 入口，使用 write_json_output() 输出结果。

level: intermediate
"""

import json
import io
import os
import sys
import traceback

import ida_auto
import ida_kernwin
import ida_pro


def _text_path(value):
    """Return a filesystem path of the type the running interpreter's text I/O wants.

    Python 3's `open` accepts `str` paths. Python 2.7's `io.open` used in text
    mode requires a `unicode` path, and fails with `write() argument 1 must be
    unicode, not str` otherwise. This keeps one call site working on both.
    """
    if sys.version_info[0] < 3 and isinstance(value, str):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value
    return value


def log(msg):
    """统一日志输出。headless 模式写 stderr（idat -L 自动加时间戳），GUI 模式写 Output 窗口（手动加时间戳）。"""
    is_batch = bool(ida_kernwin.cvar.batch)
    lines = msg.split("\n")
    if is_batch:
        out_msg = ""
        for line in lines:
            if line:
                out_msg += line + "\n"
        if not msg.endswith("\n") and lines and lines[-1]:
            out_msg = out_msg.rstrip("\n")
        sys.stderr.write(out_msg)
        sys.stderr.flush()
    else:
        from datetime import datetime
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        ts_lines = []
        for line in lines:
            if line:
                ts_lines.append("{0} {1}".format((ts), (line)))
        ts_msg = "\n".join(ts_lines)
        if msg.endswith("\n"):
            ts_msg += "\n"
        ida_kernwin.msg(ts_msg)


def env_str(key, default=""):
    """读取环境变量字符串值。"""
    return os.environ.get(key, default)


def env_bool(key):
    """读取布尔环境变量（值为 '1' 时返回 True）。"""
    return os.environ.get(key, "") == "1"


def env_int(key, default=0):
    """读取整数环境变量。"""
    try:
        return int(os.environ.get(key, str(default)))
    except ValueError:
        return default


def write_json_output(output_path, result):
    if not output_path:
        log("[!] 未指定输出路径（IDA_OUTPUT 为空），跳过写入\n")
        return False
    try:
        output_dir = os.path.dirname(output_path)
        if output_dir:
            try:
                os.makedirs(output_dir)
            except OSError:
                if not os.path.isdir(output_dir):
                    raise
        with open(_text_path(output_path), "wb") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        log("[+] 结果已写入: {0}\n".format((output_path)))
        return True
    except Exception as e:
        log("[!] 写入输出文件失败: {0} — {1}\n".format((output_path), (e)))
        return False


def run_headless(business_func):
    """headless 入口模板：检测 batch 模式 → auto_wait → 执行业务函数 → 输出 JSON → qexit。

    business_func 签名: () -> dict（返回结果字典，必须包含 success 字段）
    """
    is_batch = bool(ida_kernwin.cvar.batch)
    if not is_batch:
        return

    output_path = env_str("IDA_OUTPUT", "")
    result = None

    log("[*] headless 模式: 等待 IDA 自动分析完成...\n")
    try:
        ida_auto.auto_wait()
    except Exception as e:
        log("[!] auto_wait 异常: {0}\n".format((e)))

    log("[*] headless 模式: 自动分析完成，开始执行\n")

    try:
        result = business_func()
    except Exception as e:
        log("[!] 业务执行异常: {0}\n".format((e)))
        log("[!] 堆栈: {0}\n".format((traceback.format_exc())))
        result = {"success": False, "error": str(e), "data": None}

    if result is None:
        result = {"success": False, "error": "业务函数返回 None", "data": None}

    write_json_output(output_path, result)

    exit_code = 0 if result.get("success") else 1
    log("[*] headless 模式: 执行结束，退出码 {0}\n".format((exit_code)))
    ida_pro.qexit(exit_code)
