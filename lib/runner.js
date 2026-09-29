/**
 * idat runner selection — which IDA executable opens which target, and how a
 * failed load is read.
 *
 * This lives in its own module because it is the one part of the plugin that is
 * pure policy over file facts: it needs no cordis context, so it can be tested
 * without a harness (`tools/selftest-runner.mjs`).
 *
 * Context for the rules below — corrected 2026-09-27 against real IDA 7.0
 * output. A 64-bit target used to be unreachable, because the retry that was
 * supposed to recover had three independent holes:
 *   1. the reason for the failure was read from stdout/stderr, while IDA writes
 *      it into the `-L` log file, so the hint was always null;
 *   2. the pattern `please use 64-bit ida` does not match IDA's actual wording
 *      `Please use IDA Pro 64-bit to load 64-bit files`;
 *   3. a 32-bit runner handed a `.i64` DATABASE answers `You can't disassemble
 *      file with such an extension: …i64` — no bitness word at all.
 * Rules 1 and 2 made the retry condition unreachable; rule 3 needs the runner to
 * be chosen up front, which `runnerPreference` does.
 */
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'

/**
 * The tail of an idat log, or '' when there is none.
 *
 * IDA states the reason a load failed in the file named by `-L`, not on the
 * streams: measured 2026-09-27, both `stdout` and `stderr` came back empty while
 * the log carried `Please use IDA Pro 64-bit to load 64-bit files`.
 * @param logPath - the `-L` path handed to this invocation.
 * @param maxBytes - how much of the tail to keep.
 * @returns the log tail, or '' when it cannot be read.
 */
export function readLogTail(logPath, maxBytes = 4096) {
  try {
    const text = readFileSync(logPath, 'utf8')
    return text.length > maxBytes ? text.slice(-maxBytes) : text
  } catch {
    return ''
  }
}

/**
 * Whether an idat log says the target needs the other bitness.
 *
 * Matches the wordings IDA 7.0 actually prints, in both directions, plus the
 * database-extension complaint that means the same thing without naming a
 * bitness. `text` is meant to be stderr + stdout + the log tail concatenated.
 * @param text - everything the failed invocation produced.
 * @returns 'bit64' | 'bit32' | null when nothing in the text is a bitness signal.
 */
export function bitnessHint(text) {
  if (typeof text !== 'string') return null
  if (/please use (ida pro )?32-bit/i.test(text)) return 'bit32'
  if (/please use (ida pro )?64-bit/i.test(text)) return 'bit64'
  if (/can't disassemble file with such an extension:[^\n]*\.i64/i.test(text)) return 'bit64'
  if (/can't disassemble file with such an extension:[^\n]*\.idb/i.test(text)) return 'bit32'
  return null
}

/**
 * Which runner flavour the target itself calls for, before anything is spawned.
 *
 * `.i64` / `.idb` are decisive by extension; a bare binary is decisive by its own
 * header (ELF `e_ident[EI_CLASS]`, PE COFF `Machine`). Deciding here means the
 * common case never pays for a failed load plus a retry — and the `.i64` case,
 * which no retry can recognise, stops failing at all.
 * @param targetPath - the database or binary about to be opened.
 * @returns 'bit64' | 'bit32' | null (null means: no opinion, keep the probe order).
 */
export function runnerPreference(targetPath) {
  if (typeof targetPath !== 'string' || targetPath === '') return null
  if (/\.i64$/i.test(targetPath)) return 'bit64'
  if (/\.idb$/i.test(targetPath)) return 'bit32'
  try {
    const head = Buffer.alloc(64)
    const fd = openSync(targetPath, 'r')
    let read = 0
    try {
      read = readSync(fd, head, 0, head.length, 0)
    } finally {
      closeSync(fd)
    }
    // ELF: e_ident[EI_CLASS] — 1 = 32-bit, 2 = 64-bit
    if (read >= 5 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
      if (head[4] === 2) return 'bit64'
      if (head[4] === 1) return 'bit32'
    }
    // PE: e_lfanew (u32 at 0x3c) then the COFF Machine field. The COFF header
    // sits wherever e_lfanew says — usually well past any fixed prefix — so it
    // gets its own read instead of being assumed inside the first 64 bytes.
    if (read >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
      const peOffset = head.readUInt32LE(0x3c)
      if (peOffset > 0 && peOffset < 1024 * 1024) {
        const coff = Buffer.alloc(6)
        const fd2 = openSync(targetPath, 'r')
        let got = 0
        try {
          got = readSync(fd2, coff, 0, coff.length, peOffset)
        } finally {
          closeSync(fd2)
        }
        if (got >= 6 && coff.readUInt32LE(0) === 0x00004550) {
          const machine = coff.readUInt16LE(4)
          if (machine === 0x8664) return 'bit64' // AMD64
          if (machine === 0x014c) return 'bit32' // i386
          if (machine === 0xaa64) return 'bit64' // ARM64
          if (machine === 0x01c4) return 'bit32' // ARM Thumb-2
        }
      }
    }
  } catch {
    // unreadable target: no opinion, the probe order stands
  }
  return null
}

/**
 * The runner candidates for one target, best first.
 *
 * Order: the flavour the target calls for, then whatever the probe found (so a
 * machine with only one IDA still works), then the other flavour. The caller
 * tries them in order and stops early unless IDA asked for a specific one.
 * @param targetPath - the database or binary about to be opened.
 * @param state - the resolved plugin state carrying `idat`, `idat32`, `idat64`.
 * @returns the runner paths to try, in order, with duplicates and nulls removed.
 */
export function runnerOrder(targetPath, state) {
  const flavour = runnerPreference(targetPath)
  const preferred = flavour === 'bit64' ? state.idat64 : flavour === 'bit32' ? state.idat32 : null
  const opposite = flavour === 'bit64' ? state.idat32 : flavour === 'bit32' ? state.idat64 : null
  const runners = []
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate !== '' && !runners.includes(candidate)) runners.push(candidate)
  }
  push(preferred)
  push(state.idat)
  push(opposite)
  if (opposite === null && typeof state.idat === 'string') {
    push(state.idat === state.idat64 ? state.idat32 : state.idat64)
  }
  return runners
}
