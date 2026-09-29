/**
 * preflight: what does THIS target need, and does this machine have it?
 *
 * Design rule (from the user, and it is the whole point):
 *   derive requirements from the TARGET, never from the knowledge base.
 *   A KB-driven list would report ten missing tools at start-up -- noise.
 *   A target-driven list says "this is a Cupid .gb ROM and there is no Game Boy
 *   emulator here", which is a hard blocker worth stopping for.
 *
 * Two axes per requirement:
 *   kind    'runtime'    -- nothing can run without it (hard blocker)
 *           'static'     -- analysis convenience; a fallback usually exists
 *           'framework'  -- technique library; optional by nature
 *           'dynamic'    -- needed only to RUN the target. Never blocks: IDA can
 *                          still read a Linux ELF on Windows. But "cannot be run
 *                          here" changes the whole plan, so it gets its own
 *                          section rather than hiding in a note -- and it is
 *                          checked properly (WSL *with a distribution*, Docker,
 *                          QEMU), because an assumed answer here is worse than
 *                          no answer.
 *           'resource'   -- the target declares a footprint this machine may not
 *                          meet (e.g. a generator whose own comment says 27 GB).
 *                          Never blocks; warns before a hang instead of after.
 *   status  'installed' | 'missing' | 'warn'
 *
 * Detection is real, not guessed: PATH lookup, version probe, module import,
 * directory probe. Nothing is assumed from a name.
 */

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { freemem, totalmem } from 'node:os'
import { extname, basename } from 'node:path'

const WIN = process.platform === 'win32'

/** Run a probe and return trimmed stdout, or null. Never throws. */
function probe(cmd, args, timeout = 5000) {
  try {
    return execFileSync(cmd, args, {
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).toString('utf8').trim()
  } catch {
    return null
  }
}

/** Is a command resolvable and does it answer? */
function commandOk(name, versionArg = '--version') {
  const locator = WIN ? ['where', [name]] : ['which', [name]]
  if (probe(locator[0], locator[1]) === null) return null
  const ver = probe(name, [versionArg])
  return ver === null ? '(version probe failed)' : ver.split('\n')[0].slice(0, 80)
}

/** Is a Python module importable under the given interpreter? */
function pythonModule(interp, moduleName) {
  const out = probe(interp, ['-c', `import ${moduleName}, sys; print(getattr(${moduleName}, '__version__', 'ok'))`])
  return out
}

/**
 * Run a probe and return its raw stdout bytes, or null.
 *
 * Needed for `wsl.exe -l`, which writes UTF-16LE — decoding those bytes as UTF-8
 * yields a NUL-separated smear (`U b u n t u`) that no string test can read.
 * wsl also reports "no installed distributions" on stderr with a non-zero exit,
 * so a thrown spawn error still carries usable stdout.
 */
function probeRaw(cmd, args, timeout = 20000) {
  try {
    return execFileSync(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch (error) {
    return Buffer.isBuffer(error?.stdout) ? error.stdout : null
  }
}

/** Decode text that may be UTF-16LE (wsl.exe) or UTF-8, and trim the NULs out. */
function decodeMaybeUtf16(buf) {
  if (buf === null || buf === undefined) return ''
  // UTF-16LE ASCII text has a 0x00 in every second byte
  const utf16 = buf.length > 1 && buf[1] === 0x00
  return (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/\u0000/g, '').trim()
}

/**
 * The WSL distributions this machine can actually start.
 *
 * This is the answer to "can a Linux ELF be RUN here", and it is worth probing
 * rather than assuming: an installed WSL with no distribution cannot run
 * anything, and a machine where `wsl -d Ubuntu -- uname` answers can.
 */
function wslDistros() {
  if (!WIN) return []
  const out = decodeMaybeUtf16(probeRaw('wsl.exe', ['-l', '-q']))
  if (out === '') return []
  return out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !/^wsl:/i.test(line))
}

/**
 * Is a Visual Studio / MSVC toolchain installed?
 *
 * `cl.exe` is never on PATH outside a developer prompt, so a PATH probe reports
 * it missing on a machine that has a full C++ toolchain. vswhere is the
 * supported way to ask, and the Installer directory is the fallback.
 */
function msvcPresent() {
  if (!WIN) return false
  const vswhere = `${process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'}/Microsoft Visual Studio/Installer/vswhere.exe`
  if (existsSync(vswhere)) {
    const out = probe(vswhere, ['-latest', '-property', 'installationPath'], 15000)
    if (out !== null && out.trim() !== '') return true
  }
  return existsSync('C:/Program Files/Microsoft Visual Studio') && existsSync('C:/Program Files (x86)/Microsoft Visual Studio')
}

/**
 * Look for an executable in the usual install roots, not just PATH.
 *
 * PATH is not the whole answer: a portable toolchain dropped in its own folder
 * is invisible to `where`, and reporting it missing is a false positive that
 * would send the user chasing software they already installed. For a
 * stop-and-tell tool, a false positive is the worst kind of error -- it costs
 * the user's attention for nothing.
 */
function findInCommonRoots(exeNames) {
  const roots = [
    'D:/lua', 'C:/lua', 'D:/tools', 'C:/tools',
    'C:/Program Files', 'C:/Program Files (x86)',
    'D:/Program Files',
    `${process.env.LOCALAPPDATA ?? ''}/Programs`,
    `C:/Users/${process.env.USERNAME ?? ''}/scoop/shims`,
  ].filter((r) => r && !r.startsWith('/'))
  for (const root of roots) {
    for (const exe of exeNames) {
      const p = `${root}/${exe}`
      if (existsSync(p)) return p
      if (existsSync(`${root}/bin/${exe}`)) return `${root}/bin/${exe}`
    }
  }
  return null
}

/**
 * Resolve a tool: PATH first (with a version probe), then the install roots.
 * Returns the version/detail string on success, null when genuinely absent.
 */
function resolveTool(name, versionArg, exeNames = [name + '.exe', name]) {
  const onPath = commandOk(name, versionArg)
  if (onPath !== null) return onPath
  const found = findInCommonRoots(exeNames)
  if (found !== null) return `found at ${found} (not on PATH)`
  return null
}

// ---------------------------------------------------------------------------
// Target classification: by extension, then by magic bytes for the ambiguous.
// ---------------------------------------------------------------------------
const BY_EXT = {
  '.py': { family: 'python-source', label: 'Python 源码' },
  '.pyw': { family: 'python-source', label: 'Python 源码' },
  '.c': { family: 'c-source', label: 'C 源码' },
  '.h': { family: 'c-source', label: 'C 头文件' },
  '.cpp': { family: 'cpp-source', label: 'C++ 源码' },
  '.cc': { family: 'cpp-source', label: 'C++ 源码' },
  '.cxx': { family: 'cpp-source', label: 'C++ 源码' },
  '.hpp': { family: 'cpp-source', label: 'C++ 头文件' },
  '.rs': { family: 'rust-source', label: 'Rust 源码' },
  '.go': { family: 'go-source', label: 'Go 源码' },
  '.java': { family: 'java-source', label: 'Java 源码' },
  '.lua': { family: 'lua-source', label: 'Lua 源码' },
  '.js': { family: 'js-source', label: 'JavaScript 源码' },
  '.mjs': { family: 'js-source', label: 'JavaScript 源码' },
  '.rb': { family: 'ruby-source', label: 'Ruby 源码' },
  '.php': { family: 'php-source', label: 'PHP 源码' },
  '.class': { family: 'java-bytecode', label: 'Java 字节码' },
  '.jar': { family: 'java-bytecode', label: 'Java 归档' },
  '.dex': { family: 'android', label: 'Android DEX' },
  '.apk': { family: 'android', label: 'Android 应用' },
  '.gb': { family: 'gb-rom', label: 'Game Boy ROM' },
  '.gbc': { family: 'gb-rom', label: 'Game Boy Color ROM' },
  '.gba': { family: 'gba-rom', label: 'Game Boy Advance ROM' },
  '.nes': { family: 'nes-rom', label: 'NES ROM' },
  '.sfc': { family: 'snes-rom', label: 'SNES ROM' },
  '.i64': { family: 'ida-db', label: 'IDA 数据库' },
  '.idb': { family: 'ida-db', label: 'IDA 数据库' },
  '.so': { family: 'elf', label: 'ELF 共享对象' },
  '.elf': { family: 'elf', label: 'ELF 可执行' },
  '.dll': { family: 'pe', label: 'PE DLL' },
  '.sys': { family: 'pe', label: 'PE 驱动' },
  '.ko': { family: 'elf-kmod', label: 'Linux 内核模块' },
  '.wasm': { family: 'wasm', label: 'WebAssembly' },
  '.pcap': { family: 'pcap', label: '网络抓包' },
  '.pcapng': { family: 'pcap', label: '网络抓包' },
  '.raw': { family: 'disk-image', label: '磁盘/内存镜像' },
  '.mem': { family: 'disk-image', label: '内存镜像' },
  '.vmem': { family: 'disk-image', label: '内存镜像' },
}

/** Sniff the first bytes to classify files whose extension is not decisive. */
function sniff(head) {
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return { family: 'elf', label: 'ELF 可执行' }
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return { family: 'pe', label: 'PE 可执行' }
  if (head.length >= 4 && head.readUInt32BE(0) === 0xfeedface) return { family: 'macho', label: 'Mach-O 可执行' }
  if (head.length >= 4 && head.readUInt32BE(0) === 0xfeedfacf) return { family: 'macho', label: 'Mach-O 可执行' }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) return { family: 'zip', label: 'ZIP 容器' }
  if (head.length >= 4 && head[0] === 0xce && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) return { family: 'macho', label: 'Mach-O 可执行' }
  if (head.length >= 3 && head[0] === 0x1f && head[1] === 0x8b) return { family: 'gzip', label: 'gzip 压缩' }
  return { family: 'unknown', label: '未识别（需进一步判断）' }
}

/**
 * Does this machine have any of the named alternatives?
 * Used to decide whether a missing runtime really blocks: a gap that can be
 * routed around is not a blocker, it is a note.
 */
function anyPresent(ids, tools) {
  const have = ids.filter((id) => tools.find((t) => t.id === id)?.status === 'installed')
  return { have, ok: have.length > 0 }
}

// ---------------------------------------------------------------------------
// Requirement table: what each family needs, and which needs really block.
//
// Blocking rule: a requirement blocks ONLY when the target cannot be run at all
// and no listed alternative is present on this machine. Anything with a viable
// alternative becomes a note instead -- stopping for a gap that can be routed
// around is exactly the noise this tool exists to avoid.
// ---------------------------------------------------------------------------
function requirementsFor(family, tools) {
  const req = []
  const has = (id) => tools.find((t) => t.id === id)?.status === 'installed'

  /** Add a requirement, computing alternatives and whether it truly blocks. */
  const add = (need, kind, alternatives, note) => {
    const { have, ok } = anyPresent(alternatives, tools)
    const status = ok ? 'installed' : 'missing'
    req.push({
      need,
      kind,
      status,
      satisfiedBy: have,
      alternatives,
      // only a runtime need, with nothing present to satisfy it, blocks
      blocks: kind === 'runtime' && !ok,
      note,
    })
  }

  switch (family) {
    case 'python-source':
      add('Python 解释器', 'runtime', ['python'], '脚本本身要能运行才能观察行为')
      add('IDA Pro + idat', 'static', ['ida'], '若无，纯文本题可直接阅读源码，影响有限')
      add('angr', 'framework', ['angr'], '符号执行/逆向求解；非必需')
      break
    case 'c-source':
    case 'cpp-source':
      // A compiler is the runtime here: the challenge usually ships source that
      // must be BUILT before it can be run, and "read it carefully" is not the
      // same as "see what it prints".
      add('C/C++ 编译器', 'runtime', ['gcc', 'clang', 'msvc', 'tcc', 'zig'],
        '要编译并复现目标行为必须能构建；只做静态阅读可绕过，但"跑一遍看输出"依赖它')
      add('IDA Pro + idat', 'static', ['ida'], '若已编译出二进制，可用 IDA 交叉验证')
      break
    case 'rust-source':
      add('Rust 工具链（cargo/rustc）', 'runtime', ['cargo', 'rustc'], '构建目标以观察行为')
      break
    case 'go-source':
      add('Go 工具链', 'runtime', ['go'], '构建目标以观察行为')
      break
    case 'java-source':
      add('JDK（javac/java）', 'runtime', ['java'], '编译并运行目标')
      break
    case 'lua-source':
      add('Lua 解释器', 'runtime', ['lua'], '混淆/虚拟机类 Lua 题必须能运行才能取运行时数据')
      add('Lua 反编译器（unluac 等）', 'static', ['unluac'], '仅在目标是预编译字节码时需要')
      break
    case 'js-source':
      add('Node.js', 'runtime', ['node'], '运行目标以观察行为')
      break
    case 'ruby-source':
      add('Ruby 解释器', 'runtime', ['ruby'], '运行目标以观察行为')
      break
    case 'php-source':
      add('PHP 解释器', 'runtime', ['php'], '运行目标以观察行为')
      break
    case 'java-bytecode':
      add('JDK（java/javap）', 'runtime', ['java'], '运行与反汇编字节码')
      add('JADX 或 CFR', 'static', ['jadx'], '反编译为可读 Java 源码')
      break
    case 'android':
      add('JDK（java）', 'runtime', ['java'], 'APK 内 DEX 处理依赖它')
      add('JADX', 'static', ['jadx'], 'APK/DEX 反编译的首选')
      add('apktool', 'static', ['apktool'], '资源与清单还原')
      add('Android 运行环境（模拟器/真机）', 'dynamic', ['adb'],
        '静态反编译不需要它；只有"跑起来观察行为"才需要')
      break
    case 'gb-rom':
    case 'gba-rom':
    case 'nes-rom':
    case 'snes-rom':
      // ANY emulator settles this: MAME is the documented one, not the only one.
      add('模拟器', 'runtime', ['mame'], 'ROM 需要模拟器才能运行；有任意一款即可')
      add('IDA Pro + idat', 'static', ['ida'], '静态反汇编；需对应处理器模块，可脱离模拟器独立使用')
      break
    case 'elf':
    case 'elf-kmod':
      add('IDA Pro + idat', 'static', ['ida'], '主分析工具')
      add('objdump/readelf', 'static', ['objdump'], '快速查看段与符号')
      // Measured 2026-09-27 on this machine: WSL2 has a working Ubuntu, so a
      // Linux ELF here CAN be run. Whether that is true is probed, never assumed.
      add('Linux 执行环境（运行 ELF）', 'dynamic', ['wsl-linux', 'docker', 'qemu'],
        '静态分析不依赖它；要动态运行/调试（或让程序打印结果）才需要')
      break
    case 'pe':
      add('IDA Pro + idat', 'static', ['ida'], '主分析工具')
      add('本机可运行 PE', 'dynamic', ['windows'], 'Windows 宿主可直接运行；非 Windows 只能静态分析')
      break
    case 'macho':
      add('IDA Pro + idat', 'static', ['ida'], '主分析工具')
      add('macOS 执行环境', 'dynamic', ['darwin'], 'Mach-O 只能在 macOS 上运行；否则仅静态分析')
      break
    case 'wasm':
      add('wasm 反汇编', 'static', ['wasm2wat', 'ida'], 'IDA 有 wasm 处理器，或用 wasm2wat')
      break
    case 'pcap':
      // tshark OR tshark-free parsing via python+scapy, OR hand-rolled parsing
      add('抓包解析', 'static', ['tshark', 'scapy'], 'tshark 或 scapy 任一即可；都没有也能手写解析 pcap')
      break
    case 'disk-image':
      add('镜像分析', 'static', ['volatility'], 'Volatility 是首选，但不是唯一途径')
      add('Python 解释器', 'runtime', ['python'], 'Volatility 与自写解析都依赖它')
      break
    case 'ida-db':
      add('IDA Pro + idat', 'runtime', ['ida'], '这是 IDA 自己的数据库，没有 IDA 打不开')
      break
    case 'zip':
      add('解压工具', 'runtime', ['python', 'node'], 'Windows 自带资源管理器即可，或任一脚本运行时')
      break
    case 'gzip':
      add('gzip 解压', 'runtime', ['python', 'node'], 'zlib/gzip 均可，或任一脚本运行时')
      break
    default:
      req.push({
        need: '自定义解析代码',
        kind: 'runtime',
        status: 'installed',
        satisfiedBy: [],
        alternatives: [],
        blocks: false,
        note: '未见标准格式：需要自写解析器，平台齐备与否不构成阻断',
      })
      break
  }
  return req
}

/** Probe the machine once, for every tool we might care about. */
export function detectToolchain() {
  const py = resolveTool('python', '-V', ['python.exe', 'python3.exe'])
  const interp = py !== null ? 'python' : null

  // each entry: PATH lookup, then the install roots -- a portable toolchain that
  // is off PATH must not be reported as missing.
  const simple = [
    ['lua', ['lua', 'lua53', 'lua54', 'lua5.4'], ['lua53.exe', 'lua54.exe', 'lua.exe'], 'Lua'],
    ['node', ['node'], ['node.exe'], 'Node.js'],
    ['ruby', ['ruby'], ['ruby.exe'], 'Ruby'],
    ['php', ['php'], ['php.exe'], 'PHP'],
    ['java', ['java'], ['java.exe'], 'Java'],
    ['jadx', ['jadx'], ['jadx.bat', 'jadx.exe'], 'JADX'],
    ['apktool', ['apktool'], ['apktool.bat', 'apktool.exe'], 'apktool'],
    ['mame', ['mame'], ['mame.exe'], 'MAME'],
    ['objdump', ['objdump'], ['objdump.exe'], 'objdump'],
    ['tshark', ['tshark'], ['tshark.exe'], 'tshark'],
    ['unluac', ['unluac'], ['unluac.bat', 'unluac.jar'], 'unluac'],
    ['wasm2wat', ['wasm2wat'], ['wasm2wat.exe'], 'wasm2wat'],
  ]

  const tools = [{ id: 'python', name: 'Python', status: py !== null ? 'installed' : 'missing', detail: py ?? '' }]
  for (const [id, cmds, exes, label] of simple) {
    let detail = null
    for (const c of cmds) {
      detail = resolveTool(c, '--version', exes)
      if (detail !== null) break
    }
    tools.push({ id, name: label, status: detail !== null ? 'installed' : 'missing', detail: detail ?? '' })
  }

  tools.splice(6, 0, {
    id: 'ida',
    name: 'IDA Pro (idat)',
    status: hasIda() ? 'installed' : 'missing',
    detail: idaDetail(),
  })

  // framework tools: python modules, so they ride the interpreter
  const frameworks = ['angr', 'z3', 'unicorn', 'frida', 'capstone', 'lief', 'scapy']
  for (const mod of frameworks) {
    let status = 'missing'
    let detail = interp === null ? 'no python interpreter to host it' : ''
    if (interp !== null) {
      const ver = pythonModule(interp, mod)
      if (ver !== null) { status = 'installed'; detail = ver.slice(0, 40) }
    }
    tools.push({ id: mod, name: `${mod} (python)`, status, detail })
  }

  // volatility is a python package or a script
  const vol = interp !== null ? pythonModule(interp, 'volatility3') : null
  tools.push({ id: 'volatility', name: 'Volatility 3', status: vol !== null || commandOk('vol.py') !== null ? 'installed' : 'missing', detail: vol ?? '' })

  // Compilers and language toolchains. These are what a SOURCE target needs
  // before it can be built and run, which is why they are probed in both ways
  // (PATH, then install roots): a portable toolchain off PATH must not be
  // reported as a hard blocker.
  const compilers = [
    ['gcc', ['gcc'], ['gcc.exe'], 'GCC'],
    ['clang', ['clang'], ['clang.exe'], 'Clang'],
    ['tcc', ['tcc'], ['tcc.exe'], 'TCC'],
    ['zig', ['zig'], ['zig.exe'], 'zig'],
    ['go', ['go'], ['go.exe'], 'Go'],
    ['rustc', ['rustc'], ['rustc.exe'], 'rustc'],
    ['cargo', ['cargo'], ['cargo.exe'], 'Cargo'],
  ]
  for (const [id, cmds, exes, label] of compilers) {
    let detail = null
    for (const c of cmds) {
      detail = resolveTool(c, '--version', exes)
      if (detail !== null) break
    }
    tools.push({ id, name: label, status: detail !== null ? 'installed' : 'missing', detail: detail ?? '' })
  }
  // MSVC has no PATH presence outside a developer prompt, so asking PATH alone
  // would report "no compiler" on a machine with a full Visual Studio.
  const msvc = msvcPresent()
  tools.push({ id: 'msvc', name: 'MSVC (Visual Studio)', status: msvc ? 'installed' : 'missing', detail: msvc ? 'found via vswhere / install dir' : '' })

  // Execution environments: "can this target be RUN here", as opposed to
  // analysed. Probed, never assumed -- the WSL answer differs from machine to
  // machine and can change after an install.
  const distros = wslDistros()
  tools.push({
    id: 'wsl-linux',
    name: 'WSL Linux 发行版',
    status: distros.length > 0 ? 'installed' : 'missing',
    detail: distros.length > 0 ? `distros: ${distros.join(', ')}` : 'wsl present but no distribution installed (or no wsl)',
  })
  for (const [id, cmd, label] of [['docker', 'docker', 'Docker'], ['qemu', 'qemu-system-x86_64', 'QEMU'], ['adb', 'adb', 'adb (Android)']]) {
    const detail = resolveTool(cmd, id === 'adb' ? 'version' : '--version', [`${cmd}.exe`])
    tools.push({ id, name: label, status: detail !== null ? 'installed' : 'missing', detail: detail ?? '' })
  }
  tools.push({ id: 'windows', name: 'Windows 宿主', status: WIN ? 'installed' : 'missing', detail: process.platform })
  tools.push({ id: 'darwin', name: 'macOS 宿主', status: process.platform === 'darwin' ? 'installed' : 'missing', detail: process.platform })
  return tools
}

/** The IDA root this session would use, if any. */
function idaRoot() {
  const candidates = [
    process.env.IDA_PRO_HOME,
    process.env.DSH_IDA_HOME,
    'D:/IDA_Pro_V7.0_Potable/IDA_Pro_V7.0_Potable',
    'D:/IDA_Pro_V7.0_Potable',
    'C:/Program Files/IDA Pro 9.0',
    'C:/Program Files/IDA Pro 8.4',
    'C:/Program Files/IDA Pro 7.0',
  ].filter(Boolean)
  for (const c of candidates) {
    for (const exe of ['idat64.exe', 'idat.exe', 'idat64', 'idat']) {
      if (existsSync(`${c}/${exe}`)) return c
    }
  }
  return null
}

function hasIda() {
  return idaRoot() !== null
}

function idaDetail() {
  const root = idaRoot()
  return root === null ? '' : `found at ${root}`
}

// ---------------------------------------------------------------------------
// Resource warning: a target that declares a footprint this machine cannot meet
// ---------------------------------------------------------------------------
/**
 * Why this exists: one challenge generator carries `# 27G of ram?` in its own
 * source, and running it on a 15 GB machine hangs for minutes before anyone
 * learns why. The cheapest honest warning is the one the target writes itself.
 *
 * Deliberately narrow -- two signals, both read from the target's own text:
 * an explicit hint near a memory word, and one huge allocation call. A wider
 * heuristic would produce exactly the noise this tool exists to avoid.
 *
 * @returns one `resource` requirement, or null when the target says nothing.
 */
function resourceWarning(targetPath, family, fsMod) {
  if (!/source|script|text/.test(family)) return null
  let text = ''
  try {
    const stat = fsMod.statSync(targetPath)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null
    text = fsMod.readFileSync(targetPath, 'utf8')
  } catch {
    return null
  }

  let claimedBytes = null
  let evidence = ''
  const hints = [
    /(\d+(?:\.\d+)?)\s*(GB|G|MB|M)\b[^\n]{0,24}?(?:ram|memory|内存)/i,
    /(?:ram|memory|内存)[^\n]{0,24}?(\d+(?:\.\d+)?)\s*(GB|G|MB|M)\b/i,
  ]
  for (const pattern of hints) {
    const m = pattern.exec(text)
    if (m === null) continue
    const value = Number(m[1])
    const unit = /^M/i.test(m[2]) ? 1024 ** 2 : 1024 ** 3
    if (Number.isFinite(value) && value > 0) {
      claimedBytes = value * unit
      evidence = m[0].trim().replace(/\s+/g, ' ')
      break
    }
  }
  if (claimedBytes === null) {
    // a single allocation big enough to matter: bytearray(2**31) style
    const alloc = /(bytearray|malloc|calloc|zeros|ones|empty|full|Array)\s*\(\s*(\d{8,})/i.exec(text)
    if (alloc !== null) {
      const count = Number(alloc[2])
      // zeros/ones default to float64 (8 bytes per element); the rest are bytes
      const per = /zeros|ones|empty|full|Array/i.test(alloc[1]) ? 8 : 1
      if (Number.isFinite(count)) {
        claimedBytes = count * per
        evidence = alloc[0].trim().replace(/\s+/g, ' ')
      }
    }
  }
  if (claimedBytes === null) return null

  const freeBytes = freemem()
  const totalBytes = totalmem()
  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1)
  const needs = gb(claimedBytes)
  const overTotal = claimedBytes > totalBytes
  const overFree = claimedBytes > freeBytes
  return {
    need: `内存/资源 ~${needs} GB`,
    kind: 'resource',
    status: overTotal || overFree ? 'warn' : 'installed',
    satisfiedBy: [],
    alternatives: [],
    blocks: false,
    note: `${overTotal
      ? `目标自述需要 ~${needs} GB，超过本机物理内存 ${gb(totalBytes)} GB —— 直接跑会挂死，先估算/换机器/换思路`
      : overFree
        ? `目标自述需要 ~${needs} GB，超过当前可用 ${gb(freeBytes)} GB（物理 ${gb(totalBytes)} GB）—— 先关掉别的程序或换思路`
        : `目标自述需要 ~${needs} GB，本机可满足`}（依据：\`${evidence}\`）`,
    evidence,
    claimedBytes,
  }
}

/**
 * Does the `os_ida_*` family apply to this target?
 *
 * The boot report states this explicitly because "there is an IDA here" and
 * "IDA is the right tool for this target" are different statements, and the
 * second one is the one that decides whether a turn is wasted.
 */
const IDA_YES = new Set(['pe', 'elf', 'elf-kmod', 'macho', 'ida-db', 'gb-rom', 'gba-rom', 'nes-rom', 'snes-rom'])
const IDA_MAYBE = new Set(['unknown', 'wasm', 'disk-image'])

export function idaApplicability(result) {
  const family = result?.ok === true ? (result.classification?.family ?? 'unknown') : 'unknown'
  if (IDA_YES.has(family)) return { applies: 'yes', why: `IDA 有 ${family} 的加载器 / 处理器模块` }
  if (IDA_MAYBE.has(family)) return { applies: 'maybe', why: `${family}：IDA 可能能开（需对应 loader/处理器），先试 os_ida_initial，失败就走专门工具` }
  return {
    applies: 'no',
    why: `这是 ${family}，IDA 对它没有意义：用对应语言的解释器 / 框架处理（见 os_preflight 的需求表）`,
  }
}

/** Full preflight for one target path. */
export function preflight(targetPath, fsMod) {  if (!existsSync(targetPath)) {
    return { ok: false, target: targetPath, error: 'target does not exist' }
  }
  const stat = fsMod.statSync(targetPath)
  const ext = extname(targetPath).toLowerCase()
  let kind = BY_EXT[ext] ?? null
  let head = Buffer.alloc(0)
  if (stat.isFile()) {
    const fd = fsMod.openSync(targetPath, 'r')
    try {
      head = Buffer.alloc(Math.min(16, stat.size))
      fsMod.readSync(fd, head, 0, head.length, 0)
    } finally { fsMod.closeSync(fd) }
  }
  if (!kind) kind = sniff(head)
  if (kind.family === 'unknown' && head.length >= 2) {
    const printable = [...head].filter((b) => b >= 32 && b < 127).length
    if (printable / head.length > 0.9) kind = { family: 'text', label: `纯文本（${ext || '无扩展名'}）` }
  }

  const tools = detectToolchain()
  const requirements = requirementsFor(kind.family, tools)
  const resource = resourceWarning(targetPath, kind.family, fsMod)
  if (resource !== null) requirements.push(resource)
  // Only needs that are genuinely unroutable block. A gap with a present
  // alternative is a note, by design.
  const blocking = requirements.filter((r) => r.blocks)
  const routable = requirements.filter((r) => r.kind === 'runtime' && r.status === 'missing' && !r.blocks)
  // "Cannot be run here" is not a blocker -- IDA still reads the file -- but it
  // invalidates every plan that starts with "run it and see", so it is reported
  // as its own fact rather than as a missing convenience.
  const cannotRun = requirements.filter((r) => r.kind === 'dynamic' && r.status === 'missing')
  const canRun = requirements.filter((r) => r.kind === 'dynamic' && r.status === 'installed')
  const warnings = requirements.filter((r) => r.status === 'warn')
  const verdict = blocking.length > 0
    ? `${blocking.length} hard blocker(s): ${blocking.map((b) => b.need).join(', ')}`
    : cannotRun.length > 0
      ? `no hard blocker, but this target cannot be RUN on this machine (static analysis only): ${cannotRun.map((c) => c.need).join(', ')}`
      : routable.length === 0
        ? 'no hard blocker: every runtime this target needs is present'
        : `no hard blocker: ${routable.length} runtime gap(s) present but routable via an alternative`
  return {
    ok: true,
    target: targetPath,
    name: basename(targetPath),
    size: stat.isFile() ? stat.size : null,
    isDir: stat.isDirectory(),
    classification: kind,
    requirements,
    blocking,
    routable,
    cannotRun,
    canRun,
    warnings,
    applicability: idaApplicability({ ok: true, classification: kind }),
    verdict,
    tools,
  }
}

/** A short, decision-oriented rendering. */
export function renderPreflight(r) {
  if (!r.ok) return `preflight failed: ${r.error ?? 'unknown'}\n`
  const L = []
  L.push('## Preflight — target requirements vs this machine')
  L.push('')
  L.push(`- Target: ${r.target}`)
  L.push(`- Classified as: ${r.classification.label} (family \`${r.classification.family}\`)`)
  if (r.size !== null) L.push(`- Size: ${r.size} bytes`)
  if (r.applicability) L.push(`- **os_ida_* applies: ${r.applicability.applies}** — ${r.applicability.why}`)
  L.push('')
  L.push('### Verdict')
  L.push(r.blocking.length === 0
    ? `- ${r.verdict}. Proceed.`
    : `- **STOP-AND-TELL: ${r.blocking.length} runtime(s) this target needs are missing, with no alternative present.**`)
  L.push('')
  L.push('### Requirements derived from THIS target')
  L.push('| need | kind | status | satisfied by | why |')
  L.push('|---|---|---|---|---|')
  for (const q of r.requirements) {
    const mark = q.status === 'installed' ? 'yes'
      : q.status === 'warn' ? '**WARN**'
        : q.blocks ? '**MISSING (blocks)**'
          : q.kind === 'dynamic' ? 'missing (cannot run here)'
            : 'missing (routable)'
    const by = q.satisfiedBy?.length ? q.satisfiedBy.join(', ') : (q.alternatives?.length ? `needs: ${q.alternatives.join(' / ')}` : '—')
    L.push(`| ${q.need} | ${q.kind} | ${mark} | ${by} | ${q.note ?? ''} |`)
  }
  L.push('')
  if (r.cannotRun?.length > 0) {
    L.push('### 执行环境 — this machine cannot RUN the target')
    for (const c of r.cannotRun) {
      L.push(`- **${c.need}** missing — ${c.note ?? ''}`)
      if (c.alternatives?.length) L.push(`  - would satisfy it: ${c.alternatives.join(', ')} (none present)`)
    }
    L.push('')
    L.push('This is **not** a blocker: the file can still be read statically. But do not plan')
    L.push('around "run it and observe", and say so instead of discovering it mid-analysis.')
    L.push('')
  }
  if (r.canRun?.length > 0) {
    L.push('### 执行环境 — the target CAN be run here')
    for (const c of r.canRun) L.push(`- ${c.need}: ${c.satisfiedBy.join(', ') || 'present'} — ${c.note ?? ''}`)
    L.push('')
  }
  if (r.warnings?.length > 0) {
    L.push('### 资源预警 — estimate before running')
    for (const w of r.warnings) L.push(`- **${w.need}** — ${w.note ?? ''}`)
    L.push('')
  }
  if (r.blocking.length > 0) {
    L.push('### Hard blockers — stop and ask')
    for (const b of r.blocking) {
      L.push(`- **${b.need}** — ${b.note ?? ''}`)
      if (b.alternatives?.length) L.push(`  - accepted alternatives: ${b.alternatives.join(', ')} (none present)`)
    }
    L.push('')
    L.push('Per the plugin contract: tell the user what is missing and stop, rather than')
    L.push('burning turns on a path that cannot work. Ask whether to install, switch')
    L.push('approach, or abandon.')
    L.push('')
  }
  if (r.routable?.length > 0) {
    L.push('### Routable gaps — do NOT stop for these')
    for (const g of r.routable) {
      L.push(`- ${g.need}: missing, but ${g.alternatives.join(' / ')} would satisfy it.`)
      L.push('  Route around it unless the user wants it installed.')
    }
    L.push('')
  }
  return L.join('\n')
}
