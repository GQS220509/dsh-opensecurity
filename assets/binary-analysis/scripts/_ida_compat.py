# -*- coding: utf-8 -*-
"""summary: IDA 版本兼容层 —— 统一新老 IDAPython 的信息查询 API

description:
  同一份分析脚本要能在 IDA 7.0 和 IDA 9.x 上跑，而"查询数据库信息"这一组 API
  在两个版本里**完全不同名**：

    | 语义            | IDA >= 7.5（新）              | IDA < 7.5（旧）                      |
    |-----------------|-------------------------------|--------------------------------------|
    | 处理器名        | ida_ida.inf_get_procname()    | ida_idaapi.get_inf_structure().procname |
    | 64 位？         | ida_ida.inf_is_64bit()        | get_inf_structure().is_64bit()       |
    | 精确 32 位？    | ida_ida.inf_is_32bit_exactly()| get_inf_structure().is_32bit()       |
    | 位数            | ida_ida.inf_get_app_bitness() | 由 is_64bit() 推出                    |
    | 文件类型        | ida_ida.inf_get_filetype()    | get_inf_structure().filetype         |
    | 镜像基址        | ida_ida.inf_get_baseaddr()    | get_inf_structure().baseaddr（常为 0）|
    | 段类型          | ida_segment.segm_class(seg)   | ida_segment.get_segm_class(seg)      |

  在本机实测（IDA 7.00 + Python 2.7.13）：`ida_ida` 里 **一个 `inf_*` 都没有**
  （`dir(ida_ida)` 里没有任何以 `inf_` 开头的名字），`ida_segment.segm_class`
  也不存在，而 `ida_segment.get_segm_class`、`get_inf_structure()`、
  `idc.GetProcessorName()`、`idc.MinEA()` 都在。

  所以脚本里不要再直接写 `ida_ida.inf_*`：那是把"本机能跑"钉死在一个 IDA 版本上，
  而且失败方式是跑到一半 `AttributeError`。改调这里的函数，由这一个文件吸收差异。

  这个文件是**手工维护的**：tools/py2-compat.py 用 --shim 安装它，但从不重写它。

level: beginner
"""

import ida_idaapi

try:
    import ida_ida
except ImportError:  # 极老的版本没有这个模块
    ida_ida = None

try:
    import ida_segment
except ImportError:
    ida_segment = None

try:
    import ida_xref
except ImportError:
    ida_xref = None


def _info_structure():
    """旧版 API 的信息结构体；新版本里已经没有它了。"""
    getter = getattr(ida_idaapi, "get_inf_structure", None)
    if getter is None:
        return None
    try:
        return getter()
    except Exception:
        return None


def _modern(name):
    """取新版 `ida_ida.inf_*` 函数，不存在则返回 None。"""
    if ida_ida is None:
        return None
    function = getattr(ida_ida, name, None)
    return function if callable(function) else None


def procname():
    """处理器名（如 metapc / ARM / mips）。新老版本都能拿到。"""
    function = _modern("inf_get_procname")
    if function is not None:
        try:
            return function()
        except Exception:
            pass
    info = _info_structure()
    if info is not None:
        try:
            return info.procname
        except Exception:
            pass
    try:
        import idc

        return idc.GetProcessorName()
    except Exception:
        return ""


def is_64bit():
    """数据库是否是 64 位。"""
    function = _modern("inf_is_64bit")
    if function is not None:
        try:
            return bool(function())
        except Exception:
            pass
    info = _info_structure()
    if info is not None:
        try:
            return bool(info.is_64bit())
        except Exception:
            pass
    return app_bitness() == 64


def is_32bit_exactly():
    """是否**恰好** 32 位（旧版没有对应函数时用 is_32bit() 近似）。"""
    function = _modern("inf_is_32bit_exactly")
    if function is not None:
        try:
            return bool(function())
        except Exception:
            pass
    info = _info_structure()
    if info is not None:
        try:
            return bool(info.is_32bit())
        except Exception:
            pass
    return app_bitness() == 32


def app_bitness():
    """位数：32 或 64。"""
    function = _modern("inf_get_app_bitness")
    if function is not None:
        try:
            return int(function())
        except Exception:
            pass
    info = _info_structure()
    if info is not None:
        try:
            return 64 if info.is_64bit() else 32
        except Exception:
            pass
    try:
        return 64 if ida_idaapi.get_kernel_version().startswith("9") else 32
    except Exception:
        return 32


def filetype():
    """文件类型常量，与 `ida_ida.f_PE` / `f_ELF` / `f_MACHO` 比较。"""
    function = _modern("inf_get_filetype")
    if function is not None:
        try:
            return function()
        except Exception:
            pass
    info = _info_structure()
    if info is not None:
        try:
            return info.filetype
        except Exception:
            pass
    try:
        import idc

        return idc.GetFileType()
    except Exception:
        return 0


def baseaddr():
    """镜像基址。

    宁可回退也不返回 0：IDB 里 `get_inf_structure().baseaddr` 实测为 0，而把 0
    当基址会让"文件偏移 -> 虚拟地址"整条换算全错，还不报错。所以为 0 时改用
    `idc.MinEA()`。
    """
    function = _modern("inf_get_baseaddr")
    if function is not None:
        try:
            value = function()
            if value:
                return value
        except Exception:
            pass
    info = _info_structure()
    if info is not None:
        try:
            value = info.baseaddr
            if value:
                return value
        except Exception:
            pass
    try:
        import idc

        return idc.MinEA()
    except Exception:
        return 0


def segm_class(seg):
    """段的类别名（CODE / DATA / BSS / ...）。"""
    if ida_segment is not None:
        # 7.0 的写法（7.5+ 仍然保留）。
        getter = getattr(ida_segment, "get_segm_class", None)
        if callable(getter):
            try:
                return getter(seg)
            except Exception:
                pass
        # 7.5+ 的写法。
        module_function = getattr(ida_segment, "segm_class", None)
        if callable(module_function):
            try:
                return module_function(seg)
            except Exception:
                pass
    for attribute in ("sclass", "class"):
        try:
            value = getattr(seg, attribute)
            if value:
                return value
        except Exception:
            continue
    return ""


def func_chunks(func):
    """列出函数的所有尾部块（chunk）。

    老 IDA（实测 7.00）的 `func_tail_iterator_t` **不可迭代**，
        for chunk in ida_funcs.func_tail_iterator_t(func)
    直接抛 `TypeError: 'func_tail_iterator_t' object is not iterable`；
    必须走 `first()` / `next()` / `chunk()` 三步协议。新版本两者都支持。
    这里统一成"返回 chunk 列表"，调用方不再关心是哪一种。
    """
    chunks = []
    try:
        iterator = ida_funcs.func_tail_iterator_t(func)
    except Exception:
        return chunks

    # 新版本：可迭代。
    if hasattr(iterator, "__iter__"):
        try:
            return list(iterator)
        except Exception:
            pass

    # 老版本：显式协议。
    if not hasattr(iterator, "first"):
        return chunks
    try:
        ok = iterator.first()
        guard = 0
        # 上限只是防御：尾块链是线性的，正常远小于此值。
        while ok and guard < 100000:
            try:
                chunks.append(iterator.chunk())
            except Exception:
                break
            ok = iterator.next()
            guard += 1
    except Exception:
        pass
    return chunks


class _Reference(object):
    """一条交叉引用的最小形状：frm / to / iscode / type。"""

    __slots__ = ("frm", "to", "iscode", "type")

    def __init__(self, frm, to, iscode, ref_type):
        self.frm = frm
        self.to = to
        self.iscode = iscode
        self.type = ref_type


class xrefblk_t(object):
    """`ida_xref.xrefblk_t` 的兼容门面，补齐老版本缺失的方法。

    老 IDA（实测 7.00）只有 `first_to`/`next_to`/`first_from`/`next_from`，
    新版本只有 `crefs_to`/`fcrefs_to`/`crefs_from`/`fcrefs_from`。
    两种写法在脚本里都出现过，所以这里**同时提供两套**，让调用点保持原样：

        xb = _ida_compat.xrefblk_t()
        for ref in xb.crefs_to(ea):     # 新版本原生，老版本由本类补上
            ...

    "两套名字都能用"比"把每个调用点改成另一种写法"更不容易出错：调用点上的
    迭代协议（`for ref in ...` 还是 `first()/next()`）不必跟着改。
    """

    def __init__(self):
        self._block = ida_xref.xrefblk_t()

    # ── 新版本风格：属性式生成器 ──────────────────────────────────────────
    def _iterate(self, direction, code_only):
        modern_name = ("crefs_" if code_only else "fcrefs_") + direction
        modern = getattr(self._block, modern_name, None)
        if callable(modern):
            try:
                return list(modern(self._last_ea))
            except Exception:
                return []
        return []

    def _walk(self, direction, ea, code_only):
        self._last_ea = ea
        modern_name = ("crefs_" if code_only else "fcrefs_") + direction
        if callable(getattr(self._block, modern_name, None)):
            return self._iterate(direction, code_only)
        first = getattr(self._block, "first_" + direction, None)
        step = getattr(self._block, "next_" + direction, None)
        if not callable(first) or not callable(step):
            return []
        out = []
        try:
            ok = first(ea)
            while ok:
                if not code_only or getattr(self._block, "iscode", 1):
                    out.append(
                        _Reference(
                            getattr(self._block, "frm", None),
                            getattr(self._block, "to", None),
                            getattr(self._block, "iscode", 1),
                            getattr(self._block, "type", None),
                        )
                    )
                ok = step()
        except Exception:
            pass
        return out

    def crefs_to(self, ea):
        return self._walk("to", ea, True)

    def fcrefs_to(self, ea):
        return self._walk("to", ea, False)

    def crefs_from(self, ea):
        return self._walk("from", ea, True)

    def fcrefs_from(self, ea):
        return self._walk("from", ea, False)

    # ── 老版本风格：游标 ─────────────────────────────────────────────────
    def __getattr__(self, name):
        return getattr(self._block, name)


def xrefs_to(ea, code_only=False):
    """返回 (from_ea, type) 列表：谁引用了 `ea`。"""
    xb = ida_xref.xrefblk_t()
    modern = getattr(xb, "crefs_to" if code_only else "fcrefs_to", None)
    if callable(modern):
        try:
            return [(ref.frm, ref.type) for ref in modern(ea)]
        except Exception:
            return []
    first = getattr(xb, "first_to", None)
    step = getattr(xb, "next_to", None)
    if not callable(first) or not callable(step):
        return []
    found = []
    try:
        ok = first(ea)
        while ok:
            if not code_only or xb.iscode:
                found.append((xb.frm, xb.type))
            ok = step()
    except Exception:
        pass
    return found


def xrefs_from(ea, code_only=False):
    """返回 (to_ea, type) 列表：`ea` 引用了谁。"""
    xb = ida_xref.xrefblk_t()
    modern = getattr(xb, "crefs_from" if code_only else "fcrefs_from", None)
    if callable(modern):
        try:
            return [(ref.to, ref.type) for ref in modern(ea)]
        except Exception:
            return []
    first = getattr(xb, "first_from", None)
    step = getattr(xb, "next_from", None)
    if not callable(first) or not callable(step):
        return []
    found = []
    try:
        ok = first(ea)
        while ok:
            if not code_only or xb.iscode:
                found.append((xb.to, xb.type))
            ok = step()
    except Exception:
        pass
    return found
