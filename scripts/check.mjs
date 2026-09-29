// 自检：把「能被 dsh 正确装配」的每条契约都验一遍。
// 用法: node --experimental-vm-modules scripts/check.mjs
//
// 刻意不派生任何子进程：本仓库的自检必须在受限沙箱里也能跑（管道 stdio 会 EPERM）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
let failed = 0
let skipped = 0
const ok = (label, extra = '') => console.log(`  ok   ${label}${extra ? ' — ' + extra : ''}`)
const bad = (label, why) => {
  failed += 1
  console.log(`  FAIL ${label} — ${why}`)
}
const skip = (label, why) => {
  skipped += 1
  console.log(`  skip ${label} — ${why}`)
}
const assert = (cond, label, why) => (cond ? ok(label) : bad(label, why))

// ── 1. package.json 基本契约 ─────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert(pkg.name === 'dsh-opensecurity', 'package.json name', pkg.name)
assert(pkg.type === 'module', 'type=module')
assert(pkg.private !== true, '不是 private（可发布）')

// ── 2. exports / dsh 声明指向的文件必须存在 ───────────────────────────────────
const rel = (p) => join(root, String(p).replace(/^\.\//, ''))
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  const target = typeof value === 'string' ? value : value?.default
  assert(typeof target === 'string' && existsSync(rel(target)), `exports["${key}"]`, String(target))
}
const patchRel = pkg.dsh?.bundle?.patch
assert(typeof patchRel === 'string' && existsSync(rel(patchRel)), 'dsh.bundle.patch', String(patchRel))
assert(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform=web', String(pkg.dsh?.client?.platform))
assert(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client.inject 非空')

// ── 3. files 白名单必须覆盖运行期真正要用的路径 ───────────────────────────────
const runtimePaths = [
  'lib/index.js', 'lib/diagram.js', 'lib/client.js', 'lib/preflight.js', 'lib/runner.js',
  'lib/closed-book.js', 'assets/binary-analysis/knowledge-base', 'assets/binary-analysis/scripts',
  'assets/skills', 'agent-presets', 'overlays', 'cordis.patch.yml',
]
for (const p of runtimePaths) {
  const covered = (pkg.files ?? []).some((f) => p === f || p.startsWith(f + '/'))
  assert(covered, `files 覆盖 ${p}`, covered ? '' : '未覆盖 → 发布包里会缺文件')
}

// ── 4. YAML 可解析（补丁语法错要到 boot 才炸，这里提前拦）────────────────────
// 必须容忍 loader 自定义的 `!!js` 标签：它在本仓库是「表达式标量」，注册成字符串即可。
const yaml = require(join(
  process.env.DSH_CLI ?? 'C:/Users/31388/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh',
  'node_modules/js-yaml',
))
const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const schema = yaml.CORE_SCHEMA.extend([jsExprType])
for (const f of ['cordis.patch.yml', 'overlays/enable-network.yml', 'overlays/with-agent-preset.yml']) {
  try {
    const doc = yaml.load(readFileSync(join(root, f), 'utf8'), { schema })
    assert(Array.isArray(doc), `${f} 解析为行数组`, `entries=${Array.isArray(doc) ? doc.length : typeof doc}`)
  } catch (error) {
    bad(`${f} YAML 解析`, String(error).split('\n')[0].slice(0, 140))
  }
}

// ── 5. 客户端 bundle 的硬约束 ─────────────────────────────────────────────────
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
const idMatch = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
assert(idMatch?.[1] === pkg.name, 'client.js 注册 id == 包名', `id=${idMatch?.[1]} name=${pkg.name}`)

const diagram = readFileSync(join(root, 'lib/diagram.js'), 'utf8')
const routeHost = diagram.match(/MERMAID_SCRIPT_ROUTE\s*=\s*"([^"]+)"/)?.[1]
const routeClient = client.match(/MERMAID_SRC\s*=\s*"([^"]+)"/)?.[1]
assert(routeHost !== undefined && routeHost === routeClient, '客户端与宿主的 mermaid 路由一致', `${routeClient} vs ${routeHost}`)

// ── 6. 两个 host 入口的插件形态（loader 靠 unwrapExports 认 apply）────────────
for (const entry of ['lib/index.js', 'lib/diagram.js']) {
  const src = readFileSync(join(root, entry), 'utf8')
  assert(/export\s*\{[^}]*\bapply\b/.test(src) || /export\s+(async\s+)?function\s+apply/.test(src),
    `${entry} 导出 apply（插件形态）`)
}

// ── 7. 语法检查（ESM；不派子进程，用 vm.SourceTextModule）────────────────────
let SourceTextModule
try {
  ({ SourceTextModule } = await import('node:vm'))
} catch { /* 见下 */ }
if (typeof SourceTextModule !== 'function') {
  skip('ESM 语法检查', '需要 node --experimental-vm-modules（见 package.json 的 check 脚本）')
} else {
  for (const f of ['lib/index.js', 'lib/diagram.js', 'lib/preflight.js', 'lib/runner.js', 'lib/closed-book.js', 'lib/client.js']) {
    try {
      // eslint-disable-next-line no-new
      new SourceTextModule(readFileSync(join(root, f), 'utf8'), { identifier: f })
      ok(`语法检查 ${f}`)
    } catch (error) {
      bad(`语法检查 ${f}`, String(error?.message ?? error).slice(0, 160))
    }
  }
}

// ── 8. 素材里不能有 .pyc / __pycache__（平台相关且属构建垃圾）─────────────────
let pyc = 0
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === '__pycache__') pyc += 1
      walk(p)
    } else if (name.endsWith('.pyc') || name.endsWith('.pyo')) pyc += 1
  }
}
walk(join(root, 'assets'))
assert(pyc === 0, 'assets 内无 .pyc / __pycache__', String(pyc))

console.log(`\n${failed === 0 ? '全部通过 ✅' : `${failed} 项未通过 ❌`}${skipped ? `（${skipped} 项跳过）` : ''}`)
process.exit(failed === 0 ? 0 : 1)
