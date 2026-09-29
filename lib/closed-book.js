/**
 * closed-book mode: keep the model off the web, without taking away the ability
 * to read files or run the target.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bundle's offline guarantee works by deleting the `web` / `web-search-deepseek`
 * / `tool-web` rows from the whole composition. That is only possible in a profile
 * dedicated to analysis (`binary`). This plugin is also mounted in the `web`
 * profile, where those rows are deliberately left in place so ordinary work keeps
 * its network — which means an analysis session there can still look the answer
 * up, and a shell is enough to do it (`pwsh -c "iwr ..."`). Ranking a shell-based
 * lookup above "no web tools" is the bug this row closes.
 *
 * HOW IT WORKS
 * ------------
 * `ctx.tools.restrict()` appends a mask to the layer of the scope it is called
 * from, and `ToolRuntime.view()` (dsh-tools/lib/index.js:2843-2868) filters what
 * that scope INHERITS — the global layer plus every ancestor layer — with
 * `layers.every((layer) => layer.admits(name))`. So calling it from a scope hides
 * the named tools from that scope and from every agent joined to it, while
 * leaving the rest of the profile alone. A scope's OWN registrations are exempt,
 * which is why `deny` is the right shape: a preset's own `os_*` rows are never at
 * risk.
 *
 * The mask is not a guess about what exists: the effective surface is read from
 * `ctx.tools.view(ctx).restrictableNames`, so only names that are really there
 * are denied, and everything else is reported rather than thrown.
 *
 * VERIFICATION STATUS
 * -------------------
 * The masking semantics are read from `view()`, not observed in a live session:
 * a scoped context cannot be built outside the harness runtime, and a throwaway
 * DSH_HOME cannot install the harness's private packages (the public npm registry
 * returns 404 for `@deepseek-ai/dsh-headless`). The `closed-book` service this
 * plugin provides is what settles it empirically — it reports the tools that
 * actually disappeared, from inside the real runtime.
 */

/** Tools that reach the network, or reach a tool that can. */
export const NETWORK_ROUTES = [
  'web_search', // direct
  'web_fetch', // direct
  'pwsh', // a shell is a network client: iwr / curl / git clone
  'bash', // same, POSIX flavour
  'subagent', // a child agent's own scope is not restricted
  'workflow', // fans out to subagents
  'ralph', // fresh agents, same problem
]

export const name = 'closed-book'
export const inject = ['tools']

export function apply(ctx, userConfig = {}) {
  const deny = [...new Set(userConfig.denylist ?? NETWORK_ROUTES)]
  const extraDeny = [...new Set(userConfig.extraDeny ?? [])]
  const requested = [...new Set([...deny, ...extraDeny])]
  const mode = userConfig.mode ?? 'enforce' // enforce | audit

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.tools
    const readSurface = () => {
      const view = tools.view(toolsCtx)
      const available = view.restrictableNames ?? view.knownNames ?? new Set()
      return { view, available }
    }

    const { view: before, available } = readSurface()
    const removable = requested.filter((tool) => available.has(tool))
    const notPresent = requested.filter((tool) => !available.has(tool))

    const report = {
      mode,
      requested,
      removable,
      notPresent,
      surfaceBefore: [...before.visible.keys()].sort(),
      applied: false,
      denied: [],
      confirmedGone: [],
      stillVisible: [],
    }

    // `restrict()` throws on an unknown name, which would take this row down.
    // The surface was read first, so only real names are named.
    if (mode === 'enforce' && removable.length > 0) {
      try {
        tools.restrict({ deny: removable })
        report.applied = true
        report.denied = removable
      } catch (error) {
        report.error = String(error?.message ?? error)
      }
    }

    const after = tools.view(toolsCtx).visible
    report.surfaceAfter = [...after.keys()].sort()
    report.confirmedGone = removable.filter((tool) => !after.has(tool))
    report.stillVisible = removable.filter((tool) => after.has(tool))

    ctx.provide('closedBook', report)
    ctx.logger?.info?.(
      `closed-book[${mode}]: denied ${report.denied.length}/${requested.length} route(s) `
      + `— confirmed gone: ${report.confirmedGone.join(', ') || 'none'}`
      + (report.stillVisible.length ? `; STILL VISIBLE: ${report.stillVisible.join(', ')}` : '')
      + (notPresent.length ? `; not on this surface: ${notPresent.join(', ')}` : ''),
    )
  })
}
