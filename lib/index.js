/**
 * `dsh-opensecurity-binary` — the OpenSecurity binary-analysis capability as a
 * dsh profile bundle plugin.
 *
 * What this replaces: in OpenSecurity the model had to remember, for every
 * single IDA action, the environment-variable protocol of `query.py`
 * (`IDA_QUERY=… IDA_PATTERN=… IDA_OUTPUT=… idat -A -S"<abs script>" -L"<abs log>"
 * <db>`) and build that command line itself in bash or PowerShell — the same
 * protocol spelled twice, once per shell, out of prose. Every character of that
 * command line was model output, and every mistake in it cost a turn.
 *
 * What this does instead: one typed model-facing tool per operation. The model
 * names the operation and its arguments; this module owns the env-var mapping,
 * the argument order, the log/output paths, the timeout, the abort wiring and
 * the JSON read-back. The model never writes a command line for a query again.
 *
 * The plugin is deliberately offline: it spawns only local executables (`idat`
 * and the python interpreter) and never opens a socket. The bundle patch removes
 * the `web_search` / `web_fetch` tools and the `web` service rows, so the
 * offline stance is a composition fact rather than a promise.
 *
 * @module dsh-opensecurity-binary
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { preflight, renderPreflight } from './preflight.js'
import { bitnessHint, readLogTail, runnerOrder } from './runner.js'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'opensecurity-binary'

/** The plugin package's own directory — how the bundled assets are found. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Hard dependencies. `subprocess` is the execution seam every idat/python
 * invocation routes through; `tools` is the registry the model-facing tools are
 * published to. Without either the plugin has nothing to do, so it waits
 * instead of half-mounting.
 */
export const inject = ['subprocess', 'tools']

/** Every `IDA_QUERY` value `query.py` accepts, in its own docstring's order. */
const IDA_QUERIES = [
  'entry_points',
  'functions',
  'decompile',
  'disassemble',
  'func_info',
  'xrefs_to',
  'xrefs_from',
  'strings',
  'imports',
  'exports',
  'segments',
  'read_data',
  'packer_detect',
]

/**
 * Operations that address one function or address and therefore require
 * `address`. Kept as data so the schema description, validation and the error
 * message cannot drift apart.
 */
const QUERIES_REQUIRING_ADDRESS = new Set([
  'decompile',
  'disassemble',
  'func_info',
  'xrefs_from',
  'read_data',
])

/** Operations whose optional `pattern` argument is meaningful. */
const QUERIES_ACCEPTING_PATTERN = new Set(['functions', 'strings'])

/** `read_data` modes accepted by `query.py` (`IDA_READ_MODE`). */
const READ_MODES = ['auto', 'string', 'bytes', 'pointer']

/**
 * Where a query's JSON and idat log land. One directory per session keeps
 * sequential operations on the same target together, and the root matches the
 * original plugin's own `$HOME/bw-security-analysis` data directory so an
 * existing installation keeps its artefacts in one place.
 */
function defaultDataDir() {
  return join(homedir(), 'bw-security-analysis')
}

/**
 * Probe the usual IDA Pro install locations for a headless runner.
 *
 * Two flavours are reported, because they are NOT interchangeable and picking
 * wrong costs a full second-long load before anything can tell you so:
 *
 *   * `idat.exe`  — 32-bit. Opens 32-bit `.idb` databases, and refuses a 64-bit
 *     one with `bTree error: Please use 32-bit IDA to open this database` printed
 *     in the reverse direction.
 *   * `idat64.exe`— 64-bit. The usual choice for a modern `.i64`.
 *
 * `probeIdat` therefore collects every candidate rather than stopping at the
 * first hit, and the caller picks by target database flavour, falling back to the
 * other one when the first attempt reports a bitness mismatch. A single hardcoded
 * `idat64` silently fails on every 32-bit database, which is exactly what
 * happened against the IDA 7.0 install this plugin was validated on.
 *
 * The directory list covers both installed and PORTABLE layouts, because a
 * portable IDA is a normal thing to have and it does not live under
 * `Program Files`: `<root>/idat.exe` and `<root>/<rootname>/idat.exe` are both
 * probed.
 * @returns `{ idat, idat64, dir, candidates }` with nulls for what is absent.
 */
function probeIdat() {
  const roots = [
    process.env.IDA_PRO_HOME,
    process.env.IDA_HOME,
    process.env.IDADIR,
    'C:\\Program Files\\IDA Pro 9.0',
    'C:\\Program Files\\IDA Professional 9.0',
    'C:\\Program Files\\IDA Pro 9.1',
    'C:\\Program Files\\IDA Pro 8.4',
    'C:\\Program Files\\IDA Pro 8.3',
    'C:\\Program Files (x86)\\IDA Pro 7.5',
    join(homedir(), 'ida'),
    'D:\\IDA_Pro_V7.0_Potable',
    'D:\\IDA',
    'C:\\IDA',
  ].filter((value) => typeof value === 'string' && value.length > 0)

  const names = process.platform === 'win32'
    ? { bit64: 'idat64.exe', bit32: 'idat.exe' }
    : { bit64: 'idat64', bit32: 'idat' }

  const found = { idat: null, idat64: null, dir: null, candidates: [] }
  for (const root of roots) {
    // A portable distribution is often unpacked one level deep.
    for (const dir of [root, join(root, basename(root))]) {
      const bit64 = join(dir, names.bit64)
      const bit32 = join(dir, names.bit32)
      if (existsSync(bit64) && found.idat64 === null) {
        found.idat64 = bit64
        found.candidates.push(bit64)
      }
      if (existsSync(bit32) && found.idat === null) {
        found.idat = bit32
        found.candidates.push(bit32)
      }
      if (found.dir === null && (existsSync(bit64) || existsSync(bit32))) found.dir = dir
    }
  }
  return found
}

/**
 * Resolve an IDA database path from whatever the caller wrote.
 *
 * An unpacked database is a SET of files (`x.id0`, `x.id1`, `x.id2`, `x.nam`,
 * `x.til`), and the `.idb`/`.i64` the user thinks of may not exist on disk at
 * all — IDA reconstructs it from the `.id0`. Handing `idat` the name of a file
 * that is not there fails the run for no reason, so a matching `.id0` is
 * accepted as proof that the database is real and is converted back to the name
 * `idat` expects.
 *
 * @param target - the path the model supplied.
 * @returns the path to hand to `idat`.
 */
function resolveDatabaseTarget(target) {
  const absolute = resolve(target)
  if (existsSync(absolute)) return absolute
  // `x.idb` is not on disk, but `x.id0` is: the database is unpacked, and IDA
  // opens it by either name.
  const withoutExtension = absolute.replace(/\.(idb|i64|id0|id1)$/i, '')
  if (withoutExtension !== absolute && existsSync(`${withoutExtension}.id0`)) return absolute
  return absolute
}

/**
 * Resolve the interpreter that owns the toolchain's dependencies (the venv the
 * original plugin installed into). Falls back to the ambient interpreter so the
 * plugin still reports a usable environment when the venv is absent instead of
 * refusing to mount.
 * @param dataDir - the resolved data root.
 * @returns the interpreter path or command name.
 */
/**
 * The interpreter that owns the toolchain's dependencies (the venv the original
 * plugin installed into). Falls back to the ambient interpreter so the plugin
 * still reports a usable environment when the venv is absent instead of
 * refusing to mount.
 * @param dataDir - the resolved data root.
 * @returns the interpreter path or command name.
 */
function resolvePython(dataDir) {
  const venv = process.platform === 'win32'
    ? [
        join(dataDir, '.venv', 'python.exe'),
        join(dataDir, '.venv', 'Scripts', 'python.exe'),
        join(dataDir, '.venv', 'Scripts', 'python3.exe'),
      ]
    : [join(dataDir, '.venv', 'bin', 'python3'), join(dataDir, '.venv', 'bin', 'python')]
  for (const candidate of venv) {
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Plugin config schema; every field optional with a working default. */
export const Config = z.object({
  openSecurityRoot: z.string().default(''),
  idatPath: z.string().default(''),
  dataDir: z.string().default(''),
  idatTimeoutMs: z.number().default(300000),
  refuseOnDatabaseLock: z.boolean().default(true),
  gateOnFirstStep: z.boolean().default(true),
  cacheResults: z.boolean().default(true),
})

/** Directory listing that degrades to `[]` instead of throwing when absent. */
function listFiles(dir, suffix) {
  try {
    return readdirSync(dir).filter((entry) => entry.endsWith(suffix)).sort()
  } catch {
    return []
  }
}

/**
 * Resolve the asset root and the toolchain inventory once at mount.
 *
 * Two layouts are supported, bundled first:
 *  1. `<package>/assets/binary-analysis` — the self-contained default. The
 *     analysis assets travel with the plugin, so the checkout this capability
 *     came from can move, be renamed, or be deleted without breaking it.
 *  2. `openSecurityRoot` — an explicit override pointing at a live OpenSecurity
 *     checkout. This is the development mode: edit `.opencode/binary-analysis`
 *     and reload the row.
 *
 * Every tool reads this snapshot, so a query costs no filesystem discovery.
 * @param config - validated plugin config.
 * @returns the resolved state.
 */
/**
 * The `output.render` every tool needs, and why it is not optional.
 *
 * `defineTool` requires `output.render`: it is the function that turns the
 * validated result into the model-facing content blocks. Omitting it does not
 * degrade gracefully — the call fails with
 * `invalid output: output.render failed: userRender is not a function`, so a tool
 * whose body worked perfectly still returns nothing at all. An earlier revision
 * of this module omitted it on all six tools, and no amount of direct execution
 * of the tool bodies could reveal that: only driving a real session does.
 *
 * Two behaviours are deliberate:
 *
 *   * **bounded.** An `os_ida_batch` result can be megabytes. Below
 *     `FULL_RENDER_LIMIT` the JSON is shown; above it the model gets a compact
 *     shape summary plus the `outputPath` holding the whole thing. This is the
 *     same posture the subprocess caps take — a tool that can flood the context
 *     breaks the session it was meant to help.
 *   * **a string result is rendered as itself,** because a failed idat run
 *     returns prose and the model should read the prose, not a JSON-quoted copy.
 * @param value - the validated tool result.
 * @returns the text to show.
 */
const FULL_RENDER_LIMIT = 120000

function renderValue(value) {
  if (typeof value === 'string') return value
  let serialized
  try {
    serialized = JSON.stringify(value, null, 2)
  } catch (error) {
    return `result could not be serialized: ${String(error?.message ?? error)}`
  }
  if (serialized === undefined) return String(value)
  if (serialized.length <= FULL_RENDER_LIMIT) return serialized
  const keys = value !== null && typeof value === 'object' ? Object.keys(value) : []
  const path = typeof value?.outputPath === 'string' ? value.outputPath : undefined
  return [
    `result is ${serialized.length} bytes — too large to inline.`,
    `top-level keys: ${keys.join(', ') || '(none)'}`,
    path === undefined ? 'no outputPath was returned' : `full JSON: ${path}`,
    '',
    'Query a narrower operation, or read the JSON file above.',
  ].join('\n')
}

/** The shared `output.render` implementation for these tools. */
function textRender(_args, value) {
  return [{ type: 'text', text: renderValue(value) }]
}

function resolveState(config) {
  const bundled = join(PACKAGE_ROOT, 'assets', 'binary-analysis')
  const override = config.openSecurityRoot === '' ? '' : resolve(config.openSecurityRoot)
  const overrideDir = override === '' ? '' : join(override, '.opencode', 'binary-analysis')
  const agentDir = existsSync(overrideDir)
    ? overrideDir
    : existsSync(bundled)
      ? bundled
      : overrideDir !== '' ? overrideDir : bundled
  const root = existsSync(overrideDir) && override !== '' ? override : PACKAGE_ROOT
  const source = existsSync(overrideDir) ? 'external checkout' : 'bundled assets'
  const dataDir = config.dataDir === '' ? defaultDataDir() : resolve(config.dataDir)
  const probed = probeIdat()
  const explicit = config.idatPath === '' ? null : resolve(config.idatPath)
  return {
    root,
    source,
    agentDir,
    knowledgeDir: join(agentDir, 'knowledge-base'),
    // ONE script directory, and it is the same one the documents name:
    // `$ASSET_DIR/scripts/<file>.py`. The IDAPython scripts, the standalone
    // tool scripts and `registry.json` all live here, so a path in a skill and a
    // path in this module cannot disagree. (An earlier revision put four of them
    // in the asset root while reporting `scripts/` as the script directory, so
    // the documented paths named files that did not exist.)
    scriptsDir: join(agentDir, 'scripts'),
    dataDir,
    idat: explicit ?? (probed.idat64 ?? probed.idat),
    idat32: probed.idat,
    idat64: probed.idat64,
    idaDir: probed.dir,
    idatCandidates: probed.candidates,
    python: resolvePython(dataDir),
    knowledgeBase: listFiles(join(agentDir, 'knowledge-base'), '.md'),
    scripts: listFiles(join(agentDir, 'scripts'), '.py'),
  }
}

/**
 * One readable line per configured capability, for the gate report.
 *
 * `networkDenied` must be measured, not assumed. This report is injected into
 * the model's context and read as fact, and the plugin is mounted in profiles
 * that keep their network (the installer strips the denial rows for those), so a
 * hardcoded "network is denied" line is a lie the model then reasons from. The
 * caller passes whether the `web` service is actually absent from this context.
 * @param state - resolved capability state.
 * @param networkDenied - true only when no web service is reachable here.
 */
function renderBootReport(state, networkDenied = true) {
  const idatLine = state.idat === null
    ? 'NOT FOUND — set `idatPath` in the plugin config, or IDA_PRO_HOME in the environment'
    : `${state.idat}${state.idat === state.idat64 ? ' (64-bit)' : state.idat === state.idat32 ? ' (32-bit)' : ''}`
  const networkLine = networkDenied
    ? '- Network access: denied by this profile (the web service and its tools are not mounted)'
    : '- Network access: AVAILABLE in this profile (the web service is mounted, so the offline guarantee does not hold here — run the `binary` profile for that)'
  const lines = [
    '## OpenSecurity binary-analysis plugin — environment',
    '',
    `- Asset source: ${state.source}`,
    `- Assets (knowledge base + scripts): ${state.agentDir}`,
    `- Scripts (all of them): ${state.scriptsDir}`,
    `- IDA headless runner (idat): ${idatLine}`,
    `- Python interpreter: ${state.python}`,
    `- Data/artefact root: ${state.dataDir}`,
    `- Knowledge base files: ${state.knowledgeBase.length}`,
    `- Tool scripts: ${state.scripts.length}`,
    networkLine,
    '',
    '### Variable legend',
    '',
    'These are the ONLY names the documents and scripts use. `os_binary_boot`',
    'reports the value of each, and nothing else is injected into any shell.',
    '',
    `- \`$ASSET_DIR\` = ${state.agentDir}  (every script is \`$ASSET_DIR/scripts/<file>.py\`)`,
    `- \`$IDAT\` = ${state.idat ?? '(unresolved)'}`,
    `- \`$PYTHON\` = ${state.python}`,
    '- `$TASK_DIR` = the per-session artefact directory reported by this tool as `taskDir`',
    '',
    'You rarely need those paths: `os_ida_initial`, `os_ida_query`, `os_ida_batch`,',
    '`os_ida_update` and `os_env_detect` take the operation and its arguments and',
    'build the command line themselves. Reach for the paths only when a knowledge',
    'document tells you to run something this plugin does not expose as a tool.',
  ]
  if (state.idatCandidates.length > 1) {
    lines.push(
      '',
      '### IDA runners found (alternates — the runner in use is the "idat" line above)',
      '',
      'IDA databases are bitness-specific and the wrong runner refuses the file, so',
      'both flavours are probed and the plugin retries with the sibling when IDA',
      'says so. You do not need to choose one.',
      '',
      'This list is every runner the probe found, in probe order, and it can name',
      'more than one installation directory: a portable IDA is often unpacked one',
      'level inside its own folder and both copies are real. The `idat` line above is',
      'the one this plugin will actually use — treat these as fallbacks, not as a',
      'second opinion about which path is correct.',
      '',
      ...state.idatCandidates.map((entry) => `- \`${entry}\``),
    )
  }
  if (state.knowledgeBase.length > 0) {
    lines.push('', '### Knowledge base (published as skills — load one with the skill tool, never all at once)', '')
    for (const entry of state.knowledgeBase) lines.push(`- \`${entry.replace(/\.md$/, '')}\``)
  }
  if (state.scripts.length > 0) {
    lines.push('', '### Tool scripts', '')
    for (const entry of state.scripts) lines.push(`- \`${entry}\``)
  }
  return lines.join('\n')
}

/**
 * The gate text injected as the first step of a session. This is the strongest
 * enforcement dsh offers: a prompt section is persuasion and a tool description
 * is a hint, while an `agent/pre-step` injection is a message the model
 * provably receives before it selects a tool. dsh has no "first tool call must
 * be X" primitive — the tool registry deliberately has no forced-call seat, and
 * a guard can only reject a call, never compel one — so the honest mechanism is
 * this reminder plus the fact that the binary tool surface is the only one
 * mounted for the work it describes.
 * @param networkDenied - true only when no web service is reachable here, so the
 *   reminder never claims an offline guarantee this profile does not provide.
 * @returns the reminder text.
 */
function gateText(networkDenied = true) {
  const networkLines = networkDenied
    ? [
        'Network access is not available in this profile. Every conclusion must come',
        'from the local toolchain, from the local knowledge base, or be reported as',
        'unverified. Never present a guess as a fact, and never claim a verification',
        'you did not run.',
      ]
    : [
        'Network access IS available in this profile, so the offline guarantee does',
        'not apply here. Prefer the local toolchain and the local knowledge base for',
        'every claim about a target; treat anything reached over the network as a',
        'separate, weaker source. Never present a guess as a fact, and never claim a',
        'verification you did not run.',
      ]
  return [
    '<system-reminder>',
    'This profile mounts the OpenSecurity binary-analysis capability.',
    '',
    'Before any other action, call `os_binary_boot` once. It reports the IDA',
    'runner, the Python interpreter, the knowledge-base index and this session\'s',
    'artefact directory. Do not inspect the filesystem to rediscover what that',
    'tool already reports, and do not construct an `idat` command line by hand:',
    '`os_ida_initial`, `os_ida_query` and `os_ida_update` own that protocol.',
    '',
    ...networkLines,
    '</system-reminder>',
  ].join('\n')
}

/**
 * Mount the binary-analysis surface.
 * @param ctx - the Cordis context of the mounted row.
 * @param userConfig - the row's config after schema validation.
 */
export function apply(ctx, userConfig = {}) {
  const config = {
    openSecurityRoot: userConfig.openSecurityRoot ?? '',
    idatPath: userConfig.idatPath ?? '',
    dataDir: userConfig.dataDir ?? '',
    idatTimeoutMs: userConfig.idatTimeoutMs ?? 300000,
    refuseOnDatabaseLock: userConfig.refuseOnDatabaseLock ?? true,
    gateOnFirstStep: userConfig.gateOnFirstStep ?? true,
    cacheResults: userConfig.cacheResults ?? true,
  }
  const state = resolveState(config)

  /**
   * Whether the offline guarantee actually holds in THIS profile.
   *
   * The bundle patch deletes the network-denial rows for a profile that is
   * allowed a network (the installer's `$removeDenial`), and this same package is
   * mounted in both worlds. So the plugin cannot infer it from its own source: it
   * has to look. The `web` service is provided by the host `web` row, and that
   * row is exactly what the denial block disables, so its absence is the signal.
   * Claiming "offline" while the web tools are mounted would be a false premise
   * injected straight into the model's context.
   */
  let networkDenied = true
  try {
    networkDenied = ctx.get('web') === undefined
  } catch {
    networkDenied = true
  }

  /** Per-session artefact directory, so results stay together and findable. */
  const taskDirs = new Map()
  function taskDirFor(sessionId) {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'session'
    const existing = taskDirs.get(key)
    if (existing !== undefined) return existing
    const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14)
    const dir = join(state.dataDir, 'dsh', `${stamp}_${key.slice(-8)}`)
    mkdirSync(dir, { recursive: true })
    taskDirs.set(key, dir)
    return dir
  }

  /** Sessions whose gate reminder has already been published. */
  const gatedSessions = new Set()

  /**
   * Read-only results, keyed by (database mtime, script, operation env).
   *
   * The cache is valid because a query cannot change the database: if the
   * database's modification time is unchanged, the same query has the same
   * answer. Including the mtime rather than only the path is what keeps that
   * true after `os_ida_update` writes or after IDA saves.
   */
  const resultCache = new Map()

  /**
   * The identity of a cacheable read-only result, or null when caching must not
   * apply (disabled, or a write path).
   * @param targetPath - the database being read.
   * @param scriptPath - the script producing the result.
   * @param env - the operation's IDA_* variables.
   * @returns a cache key, or null.
   */
  function cacheKeyFor(targetPath, scriptPath, env) {
    if (!config.cacheResults) return null
    if (/update\.py$/.test(scriptPath)) return null
    let stamp = 0
    try {
      stamp = statSync(targetPath).mtimeMs
    } catch {
      return null
    }
    const shape = Object.keys(env)
      .sort()
      .map((key) => `${key}=${String(env[key])}`)
      .join('\u0000')
    return `${targetPath}\u0000${stamp}\u0000${basename(scriptPath)}\u0000${shape}`
  }

  /**
   * Run one local process to completion and return its captured streams.
   * Routed through `ctx.subprocess` so the child is tree-managed, abortable and
   * torn down with the plugin — never a bare `node:child_process` leak.
   * @param argv - executable and arguments; never shell-interpreted.
   * @param options - cwd, abort signal, environment overlay, stdout cap.
   * @returns exit facts plus the collected streams.
   */
  async function run(argv, options) {
    // The wall-clock budget is `idatTimeoutMs`, and it is enforced HERE because
    // a config field that nothing reads is worse than no field at all: the
    // operator sets a 60 s cap, no cap is applied, and a wedged IDA load holds
    // the session for as long as it likes. A timeout aborts the child's tree via
    // the same signal the tool's own cancellation uses.
    const timeoutMs = options.timeoutMs ?? config.idatTimeoutMs
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    let timedOut = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : null
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxBytes ?? 262144 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 5000,
      signal: controller.signal,
      env: options.env,
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      if (timer !== null) clearTimeout(timer)
      return {
        ok: false,
        exitCode: null,
        timedOut,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: timedOut
          ? `timed out after ${timeoutMs} ms (idatTimeoutMs)`
          : String(error?.message ?? error),
      }
    }
    if (timer !== null) clearTimeout(timer)
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
    return {
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      timedOut,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  /**
   * Guard: refuse to touch an IDA database another instance still holds open.
   * An open handle *is* the lock: renaming a file another process holds fails on
   * Windows, and elsewhere the rename pair is brief and paired. That is the same
   * posture the original `detect_db_lock.sh` takes (lsof first, advisory flock
   * as the fallback). A false negative costs one idat retry; a false positive
   * would block a legitimate run, so an absent `.id0` short-circuits.
   * @param databasePath - the database or binary path being opened.
   * @returns the contended `.id0` path, or null when free.
   */
  function databaseLocked(databasePath) {
    if (!config.refuseOnDatabaseLock) return null
    const id0 = /\.(i64|idb)$/i.test(databasePath)
      ? `${databasePath.slice(0, -4)}.id0`
      : `${databasePath}.id0`
    if (!existsSync(id0)) return null
    const probe = `${id0}.dsh-lock-probe`
    try {
      renameSync(id0, probe)
      renameSync(probe, id0)
      return null
    } catch {
      return id0
    }
  }

  /**
   * The one place an idat invocation is constructed. Every tool above hands over
   * a script path, a target and an env-var map; nothing else in this module is
   * allowed to spell an `idat` command line.
   *
   * `prepare` is what lets the batch tool share this path: it receives the
   * session's task directory and returns the environment overlay to apply for
   * this one call (writing any side files it needs). Single-operation tools pass
   * an empty overlay.
   *
   * Two behaviours here are the difference between a plugin that works on a real
   * machine and one that only works on the machine it was written on:
   *
   *   * **bitness retry.** A database is 32- or 64-bit and the opposite runner
   *     refuses it outright. Whichever flavour was probed first is tried; if IDA
   *     answers "please use the other IDA", the sibling is tried before any
   *     failure is reported, so a 32-bit `.idb` on a machine where only `idat64`
   *     was detected still analyses.
   *   * **result cache.** `(database mtime, script, env)` identifies a
   *     read-only result, and the second identical call is free. A real analysis
   *     re-reads the same function often; the database cannot have changed if
   *     its own mtime did not. Write paths (`os_ida_update`) never cache and
   *     clear what is there.
   *
   * @param scriptPath - the IDAPython script to run headlessly.
   * @param targetPath - the database or binary idat opens.
   * @param env - the operation's `IDA_*` variables.
   * @param exec - the tool execution context (abort signal, owning agent).
   * @param label - artefact filename tag.
   * @param prepare - optional callback returning extra environment entries.
   * @returns the parsed JSON result, or a structured failure.
   */
  async function runIdatScript(scriptPath, targetPath, env, exec, label, prepare) {
    if (state.idat === null) {
      return {
        ok: false,
        error:
          'idat not found: set `idatPath` in the plugin config (or IDA_PRO_HOME / IDA_HOME in the environment) and reload the row',
      }
    }
    if (!existsSync(scriptPath)) {
      return {
        ok: false,
        error: `script does not exist: ${scriptPath} — the plugin's asset root (${state.agentDir}) is incomplete`,
      }
    }
    if (!existsSync(targetPath)) {
      return {
        ok: false,
        error: `target does not exist: ${targetPath} — if this is an unpacked database, its .id0 files must sit beside it`,
      }
    }
    const lock = databaseLocked(targetPath)
    if (lock !== null) {
      return { ok: false, error: `IDA database is open elsewhere (${lock}); refusing to run concurrently` }
    }

    const cacheKey = cacheKeyFor(targetPath, scriptPath, env)
    const cached = cacheKey === null ? undefined : resultCache.get(cacheKey)
    if (cached !== undefined) return { ...cached, cached: true }

    const session = exec.agent?.session
    const taskDir = taskDirFor(session?.id ?? session?.header?.id)
    const tag = `${label}_${createHash('sha1').update(`${targetPath}|${Date.now()}`).digest('hex').slice(0, 8)}`
    const outputPath = join(taskDir, `${tag}.json`)
    const logPath = join(taskDir, `${tag}.log`)
    const extra = prepare === undefined ? {} : prepare({ taskDir, tag, outputPath, logPath })
    const childEnv = {
      ...env,
      ...extra,
      IDA_OUTPUT: outputPath,
      IDA_ENV_JSON: join(state.dataDir, 'env_cache.json'),
    }

    // Runner order comes from the target's own bitness facts (see runner.js):
    // the `.i64`-on-a-32-bit-runner case has no recoverable failure mode, so it
    // must not be entered at all. The retry below stays as the backstop for
    // targets whose bitness no header settles.
    const runners = runnerOrder(targetPath, state)
    if (runners.length === 0) runners.push(state.idat)

    let result = null
    let attempted = runners[0]
    let logTail = ''
    for (const runner of runners) {
      attempted = runner
      result = await run([runner, '-A', `-S${scriptPath}`, `-L${logPath}`, targetPath], {
        cwd: taskDir,
        signal: exec.signal,
        env: childEnv,
      })
      if (existsSync(outputPath)) break
      // IDA states its reason in the `-L` log, not on the streams, so the log
      // is part of the evidence -- without it the hint below is always null and
      // this loop never retries (that was the 2026-09-27 bug).
      logTail = readLogTail(logPath)
      // Only a bitness complaint justifies burning a second load; anything else
      // is a real failure the caller must see immediately.
      const wanted = bitnessHint(`${result.stderr}\n${result.stdout}\n${logTail}`)
      const next = wanted === 'bit32' ? state.idat32 : wanted === 'bit64' ? state.idat64 : null
      if (next === null || next === runner) break
      if (!runners.slice(runners.indexOf(runner) + 1).includes(next)) break
    }

    if (!existsSync(outputPath)) {
      const hint = bitnessHint(`${result.stderr}\n${result.stdout}\n${logTail}`)
      const reason = logTail.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-3).join(' | ')
      return {
        ok: false,
        error: result.timedOut === true
          ? `idat timed out after ${config.idatTimeoutMs} ms — raise idatTimeoutMs for a large database, or query a narrower operation`
          : result.ok
            ? `idat exited 0 but wrote no output file at ${outputPath}`
            : `idat exited with code ${result.exitCode}${hint === null ? '' : ` (IDA wants the ${hint === 'bit32' ? '32-bit' : '64-bit'} runner, which was not found next to ${attempted})`}${reason === '' ? '' : ` — idat log: ${reason}`}`,
        runner: attempted,
        logPath,
        stdoutTail: result.stdout.slice(-1000),
        stderrTail: result.stderr.slice(-2000),
      }
    }
    try {
      const parsed = { ok: true, outputPath, logPath, data: JSON.parse(readFileSync(outputPath, 'utf8')) }
      if (cacheKey !== null) resultCache.set(cacheKey, parsed)
      return parsed
    } catch (error) {
      return { ok: false, error: `output file is not valid JSON: ${String(error?.message ?? error)}`, outputPath, logPath }
    }
  }

  /**
   * The "one call per operation" argument rules, shared by `os_ida_query` and
   * `os_ida_batch` so a batch entry and a single query accept exactly the same
   * shape. Throws on a caller mistake, which surfaces before idat is launched.
   * @param operation - one operation object.
   * @returns the `IDA_*` environment entries for that operation.
   */
  function operationEnv(operation) {
    const op = String(operation.operation ?? '')
    if (!IDA_QUERIES.includes(op)) {
      throw new Error(`unknown operation "${op}"; expected one of ${IDA_QUERIES.join(', ')}`)
    }
    const address = typeof operation.address === 'string' ? operation.address.trim() : ''
    if (QUERIES_REQUIRING_ADDRESS.has(op) && address === '') {
      throw new Error(`operation "${op}" requires \`address\``)
    }
    const pattern = typeof operation.pattern === 'string' ? operation.pattern.trim() : ''
    if (pattern !== '' && !QUERIES_ACCEPTING_PATTERN.has(op) && op !== 'xrefs_to') {
      throw new Error(`operation "${op}" does not accept \`pattern\``)
    }
    const env = { IDA_QUERY: op }
    // `query.py` reads IDA_FUNC_ADDR for the function-addressed operations and
    // IDA_ADDR for the address-addressed ones, with xrefs_to accepting either.
    if (address !== '') {
      env.IDA_FUNC_ADDR = address
      env.IDA_ADDR = address
    }
    if (pattern !== '') {
      env.IDA_PATTERN = pattern
      if (address === '') env.IDA_ADDR = pattern
    }
    if (op === 'read_data') {
      env.IDA_READ_MODE = typeof operation.readMode === 'string' ? operation.readMode : 'auto'
      if (typeof operation.readSize === 'number') env.IDA_READ_SIZE = String(operation.readSize)
      if (operation.dereference === true) env.IDA_DEREF = '1'
    }
    if ((op === 'decompile' || op === 'disassemble' || op === 'func_info') && operation.forceCreate === true) {
      env.IDA_FORCE_CREATE = '1'
    }
    return env
  }

  /**
   * The optional `target` argument's answer: what this file is, whether the
   * `os_ida_*` family applies to it, and whether it can be RUN on this machine.
   *
   * Why the gate answers it: the boot report describes the MACHINE, and the
   * model reads "IDA is installed" as "IDA is the tool for this target". For a
   * `.lua`, `.py` or `.c` target that inference spends the first turns of a
   * session on a tool that cannot open the file.
   * @param targetPath - the path the caller named (already resolved).
   * @returns a report section, or a one-line not-found note.
   */
  function renderTargetFacts(targetPath) {
    if (!existsSync(targetPath)) {
      return `\n### Target\n- \`${targetPath}\` — not found on disk; the gate only reports facts about a path that exists\n`
    }
    const result = preflight(targetPath, { statSync, openSync, readSync, closeSync, readFileSync })
    const L = []
    L.push('')
    L.push('### Target — what this file is, and which tools apply')
    L.push(`- Path: \`${targetPath}\``)
    L.push(`- Classified as: ${result.classification.label} (family \`${result.classification.family}\`)`)
    L.push(`- **os_ida_* applies: ${result.applicability.applies}** — ${result.applicability.why}`)
    if (result.cannotRun?.length > 0) {
      L.push(`- **Cannot be RUN here**: ${result.cannotRun.map((c) => c.need).join(', ')} — plan for static analysis only`)
    } else if (result.canRun?.length > 0) {
      L.push(`- Can be run here: ${result.canRun.map((c) => `${c.need} (${c.satisfiedBy.join(', ')})`).join('; ')}`)
    }
    if (result.blocking.length > 0) {
      L.push(`- **STOP-AND-TELL**: ${result.blocking.map((b) => b.need).join(', ')} missing, with no alternative present — tell the user and stop`)
    }
    for (const w of result.warnings ?? []) L.push(`- 资源预警: ${w.need} — ${w.note}`)
    L.push('- Full requirement list and alternatives: call `os_preflight` on this path')
    L.push('')
    return L.join('\n')
  }

  // ── tool 1: the gate ──────────────────────────────────────────────────────
  const bootTool = defineTool({
    name: 'os_binary_boot',
    description:
      "Report the OpenSecurity binary-analysis environment for this session: the IDA headless runner, the Python interpreter, the knowledge-base index, the tool-script list and this session's artefact directory. Call this once before any reverse-engineering work. Pass `target` when the path to analyse is already known: the report then also states what that file is, whether the os_ida_* tools apply to it, and whether this machine can run it.",
    parameters: {
      target: { type: 'string', description: 'Optional absolute path of the file about to be analysed. When given, the report adds its classification, os_ida_* applicability and run-here verdict.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
          idat: { type: 'string' },
          python: { type: 'string', required: true },
          taskDir: { type: 'string', required: true },
          assetSource: { type: 'string', required: true },
          assetDir: { type: 'string', required: true },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const targetArg = typeof args?.target === 'string' ? args.target.trim() : ''
      const report = renderBootReport(state, networkDenied)
        + (targetArg === '' ? '' : renderTargetFacts(resolve(targetArg)))
      return {
        report,
        ...state.idat === null ? {} : { idat: state.idat },
        python: state.python,
        taskDir: taskDirFor(session?.id ?? session?.header?.id),
        assetSource: state.source,
        assetDir: state.agentDir,
      }
    },
    presentCall() {
      return { card: 'generic', title: 'OpenSecurity binary environment', kind: 'read' }
    },
  })

  // ── tool 2: the initial pipeline ──────────────────────────────────────────
  const initialTool = defineTool({
    name: 'os_ida_initial',
    description:
      'Run the OpenSecurity initial analysis pipeline against one binary or IDA database: segments, entry points, imports, strings, packer detection and scene classification in a single IDA headless pass. Returns the structured result.',
    parameters: {
      target: { type: 'string', required: true, description: 'Absolute path of the binary or .i64/.idb database to analyse.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'object', additionalProperties: true },
          outputPath: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      if (typeof args.target !== 'string' || args.target.trim() === '') throw new Error('target must be a non-empty path')
      const target = resolveDatabaseTarget(args.target.trim())
      const result = await runIdatScript(join(state.scriptsDir, 'initial_analysis.py'), target, {}, exec, 'initial')
      if (!result.ok) throw new Error(JSON.stringify(result))
      return { data: result.data, outputPath: result.outputPath, logPath: result.logPath }
    },
    presentCall(args) {
      return { card: 'generic', title: `Initial analysis ${basename(String(args.target))}`, kind: 'read', rawInput: args.target }
    },
  })

  // ── tool 3: every query type ──────────────────────────────────────────────
  const queryTool = defineTool({
    name: 'os_ida_query',
    description: [
      'Query one IDA database through the OpenSecurity query script and return its structured JSON.',
      `Operations: ${IDA_QUERIES.join(', ')}.`,
      '`address` is required for decompile, disassemble, func_info, xrefs_from and read_data, and accepts a function name (main, sub_401000) or a hex address (0x401000).',
      '`pattern` is honoured by functions (name glob) and strings (substring or glob); xrefs_to accepts an address or a pattern as its target.',
      '`readMode` and `readSize` apply to read_data only.',
    ].join(' '),
    parameters: {
      database: { type: 'string', required: true, description: 'Absolute path of the .i64/.idb (or the original binary) to open.' },
      operation: { type: 'string', required: true, enum: IDA_QUERIES, description: 'The IDA_QUERY operation to run.' },
      address: { type: 'string', description: 'Function name or hex address; required by the address-addressed operations.' },
      pattern: { type: 'string', description: 'Name or substring pattern for functions, strings and xrefs_to.' },
      readMode: { type: 'string', enum: READ_MODES, description: 'read_data interpretation mode (default auto).' },
      readSize: { type: 'number', description: 'read_data byte count.' },
      dereference: { type: 'boolean', description: 'read_data: follow one pointer before reading.' },
      forceCreate: { type: 'boolean', description: 'decompile/disassemble/func_info: allow creating a function when the address has none.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'object', additionalProperties: true },
          outputPath: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const env = operationEnv(args)
      const result = await runIdatScript(
        join(state.scriptsDir, 'query.py'),
        resolveDatabaseTarget(String(args.database)),
        env,
        exec,
        `query_${env.IDA_QUERY}`,
      )
      if (!result.ok) throw new Error(JSON.stringify(result))
      return { data: result.data, outputPath: result.outputPath, logPath: result.logPath }
    },
    presentCall(args) {
      const subject = String(args.address ?? args.pattern ?? '')
      return {
        card: 'generic',
        title: `IDA ${String(args.operation)} ${subject}`.trim(),
        kind: 'read',
        rawInput: String(args.database),
      }
    },
  })

  // ── tool 3b: many queries, one idat launch ────────────────────────────────
  //
  // The single largest performance lever in this plugin. Every idat invocation
  // pays a cold start (process spawn + .i64 load + auto_wait), measured in
  // seconds, while the query it performs usually takes milliseconds. A realistic
  // analysis wants a dozen or more queries, so one-at-a-time means paying that
  // startup a dozen times for work that would fit in one.
  //
  // This tool writes the operation list to a file, hands it to `batch_query.py`,
  // and lets that script run every operation inside the already-loaded database.
  const batchTool = defineTool({
    name: 'os_ida_batch',
    description: [
      'Run several IDA queries in ONE headless IDA session and return every result.',
      'Use this instead of calling os_ida_query repeatedly: each idat launch costs a full database load, so batching N operations saves N-1 cold starts.',
      'Each entry accepts the same fields as os_ida_query (operation, address, pattern, readMode, readSize, dereference, forceCreate).',
      'A failing entry does not abort the batch; its result carries success:false and an error.',
    ].join(' '),
    parameters: {
      database: { type: 'string', required: true, description: 'Absolute path of the .i64/.idb (or the original binary) to open once.' },
      operations: {
        type: 'array',
        required: true,
        description: 'The operations to run, in order. Each is { operation, address?, pattern?, readMode?, readSize?, dereference?, forceCreate? }.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            operation: { type: 'string', required: true, enum: IDA_QUERIES },
            address: { type: 'string' },
            pattern: { type: 'string' },
            readMode: { type: 'string', enum: READ_MODES },
            readSize: { type: 'number' },
            dereference: { type: 'boolean' },
            forceCreate: { type: 'boolean' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'object', additionalProperties: true },
          outputPath: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
          batchPath: { type: 'string', required: true },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const operations = Array.isArray(args.operations) ? args.operations : []
      if (operations.length === 0) throw new Error('operations must be a non-empty array')
      // Validate every entry up front: a bad entry must fail before idat starts,
      // not after the database has spent seconds loading.
      for (const [index, operation] of operations.entries()) {
        try {
          operationEnv(operation)
        } catch (error) {
          throw new Error(`operations[${index}]: ${String(error?.message ?? error)}`)
        }
      }
      let batchPath = ''
      const result = await runIdatScript(
        join(state.scriptsDir, 'batch_query.py'),
        resolveDatabaseTarget(String(args.database)),
        {},
        exec,
        `batch${operations.length}`,
        ({ taskDir, tag }) => {
          batchPath = join(taskDir, `${tag}.batch.json`)
          writeFileSync(batchPath, JSON.stringify(operations), 'utf8')
          // `IDA_BATCH_CALLER` is the flag that stops `query.py` — imported by
          // `batch_query.py` for its handler table — from running its own
          // single-query entry point inside the same idat session.
          return { IDA_BATCH_FILE: batchPath, IDA_BATCH_CALLER: 'os_ida_batch' }
        },
      )
      if (!result.ok) throw new Error(JSON.stringify(result))
      return { data: result.data, outputPath: result.outputPath, logPath: result.logPath, batchPath }
    },
    presentCall(args) {
      const count = Array.isArray(args.operations) ? args.operations.length : 0
      return {
        card: 'generic',
        title: `IDA batch (${count} operations)`,
        kind: 'read',
        rawInput: String(args.database),
      }
    },
  })

  // ── tool 4: the write path, preview first ─────────────────────────────────
  const updateTool = defineTool({
    name: 'os_ida_update',
    description:
      'Apply a durable change to an IDA database: rename a symbol, set a function comment or set a line comment. Defaults to a dry run — pass `dryRun: false` only after the user has seen the preview.',
    parameters: {
      database: { type: 'string', required: true, description: 'Absolute path of the .i64/.idb to modify.' },
      operation: {
        type: 'string',
        required: true,
        enum: ['rename', 'set_func_comment', 'set_line_comment'],
        description: 'The IDA_OPERATION to run.',
      },
      oldName: { type: 'string', description: 'rename: the existing symbol name.' },
      newName: { type: 'string', description: 'rename: the replacement symbol name.' },
      address: { type: 'string', description: 'set_func_comment / set_line_comment: target function name or hex address.' },
      comment: { type: 'string', description: 'The comment text to write.' },
      dryRun: { type: 'boolean', description: 'Preview only; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'object', additionalProperties: true },
          outputPath: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const operation = String(args.operation)
      const env = { IDA_OPERATION: operation, IDA_DRY_RUN: args.dryRun === false ? '0' : '1' }
      if (operation === 'rename') {
        if (typeof args.oldName !== 'string' || args.oldName === '') throw new Error('rename requires `oldName`')
        if (typeof args.newName !== 'string' || args.newName === '') throw new Error('rename requires `newName`')
        env.IDA_OLD_NAME = args.oldName
        env.IDA_NEW_NAME = args.newName
      } else {
        if (typeof args.address !== 'string' || args.address === '') throw new Error(`${operation} requires \`address\``)
        if (typeof args.comment !== 'string') throw new Error(`${operation} requires \`comment\``)
        env.IDA_FUNC_ADDR = args.address
        env.IDA_ADDR = args.address
        env.IDA_COMMENT = args.comment
      }
      const result = await runIdatScript(
        join(state.scriptsDir, 'update.py'),
        resolveDatabaseTarget(String(args.database)),
        env,
        exec,
        `update_${operation}`,
      )
      if (!result.ok) throw new Error(JSON.stringify(result))
      // A write invalidates every cached read of this database. Keying the cache
      // on mtime already covers it, but the mtime is only as fresh as the
      // filesystem's timestamp resolution, so the entries are dropped outright.
      resultCache.clear()
      return { data: result.data, outputPath: result.outputPath, logPath: result.logPath }
    },
    presentCall(args) {
      const verb = args.dryRun === false ? 'Apply' : 'Preview'
      return { card: 'generic', title: `${verb} ${String(args.operation)}`, kind: 'edit', rawInput: String(args.database) }
    },
  })

  // ── tool 5: the environment probe ─────────────────────────────────────────
  const envTool = defineTool({
    name: 'os_env_detect',
    description:
      'Probe the local reverse-engineering toolchain (IDA Pro, compilers, python packages, Frida, debuggers) and return the structured environment report. Runs entirely locally.',
    parameters: {
      output: { type: 'string', description: "Optional absolute path for the JSON report; defaults to this session's artefact directory." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'object', additionalProperties: true },
          outputPath: { type: 'string', required: true },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const taskDir = taskDirFor(session?.id ?? session?.header?.id)
      const outputPath = typeof args.output === 'string' && args.output !== '' ? resolve(args.output) : join(taskDir, 'env.json')
      const script = join(state.scriptsDir, 'detect_env.py')
      if (!existsSync(script)) throw new Error(`environment probe not found at ${script}`)
      const result = await run([state.python, script, '--output', outputPath], { cwd: taskDir, signal: exec.signal })
      if (!existsSync(outputPath)) {
        throw new Error(JSON.stringify({ error: `probe produced no report (exit ${result.exitCode})`, stderrTail: result.stderr.slice(-2000) }))
      }
      return { data: JSON.parse(readFileSync(outputPath, 'utf8')), outputPath }
    },
    presentCall() {
      return { card: 'generic', title: 'Probe reverse-engineering toolchain', kind: 'read' }
    },
  })

  // ── tool 7: target preflight ──────────────────────────────────────────────
  //
  // Derives what THIS target needs from the target itself -- never from the
  // knowledge base. A KB-driven list would report every optional tool missing at
  // session start, which is noise; a target-driven list says "this is a Game Boy
  // ROM and no emulator is installed", which is worth stopping for.
  //
  // The contract: when a `runtime` requirement is missing, report it and tell the
  // user, rather than spending turns on a path that cannot work. Soft gaps
  // (analysis or framework tools) are listed but never block, because a fallback
  // usually exists and stopping for them would be the noise this row exists to
  // avoid.
  const preflightTool = defineTool({
    name: 'os_preflight',
    description:
      'Classify a target and report what software IT needs, then check this machine. Distinguishes hard blockers (a runtime that must be present for the target to run at all) from soft gaps (analysis or framework tools with fallbacks). Call this before committing to an approach: if a runtime is missing, say so and stop instead of burning turns.',
    parameters: {
      target: { type: 'string', required: true, description: 'Absolute path of the target file or directory to classify.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
          family: { type: 'string', required: true },
          verdict: { type: 'string', required: true },
          blocking: { type: 'string', required: true, description: 'JSON array of the hard blockers, empty when none.' },
        },
      },
      render: textRender,
    },
    async execute(args) {
      const target = resolve(String(args.target))
      const result = preflight(target, { statSync, openSync, readSync, closeSync })
      return {
        report: renderPreflight(result),
        family: result.ok ? result.classification.family : 'error',
        verdict: result.ok ? result.verdict : `error: ${result.error}`,
        blocking: result.ok ? JSON.stringify(result.blocking) : '[]',
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Preflight ${basename(String(args.target))}`, kind: 'read' }
    },
  })

  // Every registration is owned by this plugin's fiber, so stop, update or
  // removal takes all seven tools away with it — no manual teardown.
  for (const tool of [bootTool, initialTool, queryTool, batchTool, updateTool, envTool, preflightTool]) ctx.tools.register(tool)

  // ── the gate ──────────────────────────────────────────────────────────────
  //
  // One reminder per session, injected as a user message on the first step. A
  // `agent/pre-step` listener is the only place a plugin can add a message the
  // model is guaranteed to see before it chooses a tool, which is why the
  // "call the gate first" instruction lives here and not in a prompt section.
  if (config.gateOnFirstStep) {
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const session = agent?.session?.id ?? agent?.session?.header?.id
      const key = typeof session === 'string' ? session : 'session'
      if (gatedSessions.has(key)) return decision
      gatedSessions.add(key)
      if (signal?.aborted === true) return decision
      const published = (agent?.session?.events ?? []).some(
        (event) => event?.type === 'user/message' && event?.data?.source?.kind === 'opensecurity-gate',
      )
      if (published) return decision
      return {
        kind: 'enter',
        messages: [
          ...messages,
          createUserMessage({
            content: [{ type: 'text', text: gateText(networkDenied) }],
            source: { kind: 'opensecurity-gate', form: 'instructions' },
          }),
        ],
      }
    })
  }
}
