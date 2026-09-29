# DSH (0.1.1-rc.2) source-verified investigation report

Path roots used below (declared once; every citation is relative to one of them):

- `<DSH>` = `C:\Users\31388\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
- `<PKG>` = `<DSH>\node_modules\@deepseek-ai`
- `<HOME>` = `C:\Users\31388\.ohdsh`
- Install anchor (the app package.json) = `<DSH>\package.json`; `bin` = `<DSH>\lib\bin.js`.

Evidence types: `— <path>:<line>` for source claims; fenced blocks are literal command output I ran in this session (PowerShell 5.1 / Node v24.20.0, `curl.exe`, `node`, `dsh.cmd`). Anything I could not verify is labelled **unverified**.

---

## Q1 — Loader/bootstrap semantics (`dsh-app-boot`)

### Q1.1 `loadProfile` signature and how `dsh.profile.bundles` is read

```js
function loadProfile(binName, name, installAnchor, home = resolveDshHome(), options = {}) {
	const dir = resolveProfileDir(name, home);
	if (!existsSync(join(dir, "package.json"))) {
		const template = PROFILE_TEMPLATES[name];
		if (template === void 0) throw new Error(`${binName}: profile ${JSON.stringify(name)} does not exist; create it with 'dsh plugin --profile ${name} add <package>'`);
		initProfile(dir, template);
	}
	const layers = (normalizeShippedProfile(name, dir, readProfileManifest(binName, dir)).dsh?.profile?.bundles ?? []).map((packageName) => {
		const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
		const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
		if (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
		const patchPath = join(packageDir, declared);
		return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) };
	});
	const patchPath = join(dir, PROFILE_PATCH_FILENAME);
	return { name, dir, layers, patchPath, patches: options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [] };
}
```
— `<PKG>\dsh-app-boot\lib\index.js:539-566`

- The 4th parameter is `home` (default `resolveDshHome()`); the launcher passes `void 0` — `<DSH>\lib\profile-boot-DG5t9aNs.js:142` (`loadProfile(NAME, name, INSTALL_ANCHOR, void 0, { userLayer })`).
- `dsh.profile.bundles` is read as `manifest.dsh?.profile?.bundles ?? []`, i.e. a **missing `dsh.profile` section yields an empty layer list, not an error** — `<PKG>\dsh-app-boot\lib\index.js:546`. The manifest is re-read from disk (`readProfileManifest`), so it is not cached in the service — `<PKG>\dsh-app-boot\lib\index.js:445-456`.
- `normalizeShippedProfile` rewrites exactly one legacy tuple (`headless` = base+web-app+headless → the shipped template) and writes the manifest back; every other list is user-owned — `<PKG>\dsh-app-boot\lib\index.js:473-490`, tuples at `:328-332`.
- A listed bundle without `dsh.bundle.patch` **fails loud** (no silent "no patches"): `— <PKG>\dsh-app-boot\lib\index.js:549`.
- Each bundle patch file is loaded with `loadOverlayPatches` (missing file throws; non-array or non-mapping entry throws) — `<PKG>\dsh-app-boot\lib\index.js:812-819` and `834-846`.

### Q1.2 Patch-layer application ORDER

The boot path (the authoritative one) composes and passes ONE flattened patch list:

```js
function allPatches(composed) {
	return [ ...composed.bundlePatches, ...composed.profile.patches, ...composed.homePatches, ...composed.overlays ];
}
```
— `<DSH>\lib\profile-boot-DG5t9aNs.js:146-154`

```js
const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
...
const composedOverlays = [...overlays];
if (rows.has("agent-presets")) composedOverlays.push({ id: "agent-presets", config: { ...rows.get("agent-presets")?.config ?? {}, roots: [{ path: SHIPPED_PRESET_ROOT, trust: "system" }] } });
const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID));
if (telemetryPatch !== void 0) composedOverlays.push(telemetryPatch);
```
— `<DSH>\lib\profile-boot-DG5t9aNs.js:170-190`

Order (later wins), all applied as one flatten into the include's single patch pass at `<DSH>\lib\profile-boot-DG5t9aNs.js:247` (`boot(NAME, rootConfig, structuredClone(allPatches(composed)), …)`):

1. `bundlePatches` — every bundle's patch list, flattened in `dsh.profile.bundles` order.
2. `profile.patches` — the profile's own `<profileDir>\cordis.patch.yml`.
3. `homePatches` — `$DSH_HOME\cordis.patch.yml` (a machine-wide layer, applied over the per-profile one) — `<DSH>\lib\profile-boot-DG5t9aNs.js:94-96`, `168`.
4. `overlays` — `--patch <file>` overlays in argv order, *then* the launcher-generated `agent-presets` root patch (only when the composition carries an `agent-presets` row), then the `DSH_TELEMETRY_DISABLED` disable patch.
   - The `agent-presets` overlay **replaces** any `roots` the earlier layers declared (it spreads the existing config then overwrites `roots` with exactly the shipped preset root alone) — `<DSH>\lib\profile-boot-DG5t9aNs.js:181-187`.

The same live stack is recomposed for the HMR watcher as bundle patches + profile patch file + home patch file + composed overlays, i.e. the launcher rows remain last — `<DSH>\lib\profile-boot-DG5t9aNs.js:241-273`.

The offline dump (`--dump-config`) uses the SAME patch algorithm but its own layer labels and does **not** include the launcher-generated `agent-presets`/telemetry overlays — `<DSH>\lib\dump-config-D-jtgwY3.js:24-48`; documented at `<PKG>\dsh-app-boot\lib\index.js:869-877` (one `applyEntryPatches` call so a dump cannot drift from what boots).

### Q1.3 `applyEntryPatches` — exact semantics of an `id` patch (quoted)

```js
function applyEntryPatches(data, patches, warn) {
	data = structuredClone(data);
	if (!patches?.length) return data;
	const entryMap = /* @__PURE__ */ new Map();
	const buildMap = (entries) => {
		for (const entry of entries) {
			if (entry.id) entryMap.set(entry.id, entry);
			if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
		}
	};
	buildMap(data);
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) { warn("patch insert: entry %C not found", id); continue; }
				if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) { warn("patch: id is required for non-insert patches"); continue; }
		const target = entryMap.get(id);
		if (!target) { warn("patch: entry %C not found", id); continue; }
		if (name && name !== target.name) { warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name); continue; }
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
	}
	return data;
}
```
— `<PKG>\dsh-app-boot\lib\index.js:57-106`

Semantics, exactly:

- **Not a merge.** A patch entry is a mapping whose every key other than `id`/`insert`/`name` is assigned **wholesale** onto the target row: `target[key] = value` (`:100-103`). So `config:` **replaces** the entire config object; it does not deep-merge.
- **`disabled`** is an ordinary override key: `disabled: true` disables, `disabled: false` re-enables a row an earlier layer disabled, and `!!js` is allowed in it because `Entry._disabled` evaluates it — `<PKG>\cordis-plugin-loader\src\config\entry.ts:104-112`.
- **`name`** is a guard: if present and different from the target's module specifier, the patch warns and is skipped (`:96-99`).
- **`insert`** without `id` appends the list at the top level (`:83`); `insert` with an `id` appends into that row's `config` array and requires the target to be a group (`:70-85`). Inserted rows are indexed immediately, so a later patch in the same list can target a row an earlier patch inserted (`:84`, documented `:49-51`).
- Any non-matching patch is a **warning, not a failure** (`:73`, `:93`); malformed patch *files* fail loud at parse (`:834-846`).
- The input is never mutated; the result is always a `structuredClone` (`:58`).
- An `id` may also address a **nested** row: the index is built by recursing into `group: true` rows whose `config` is an array (`:61-66`).

Empirical confirmation (temp `DSH_HOME`, real launcher; `config` replacement, re-enable, missing-id warning, top-level insert):

```text
=== stderr ===
dsh.cmd : dsh: [C:\Users\31388\AppData\Local\Temp\dsh-probe-home\cordis.patch.yml] patch: entry "no-such-row-id" not found
=== agent-presets row after home patch ===
  name: '@deepseek-ai/dsh-client-ui-trajectory'
# == @deepseek-ai/dsh-web-app, patched by C:\Users\31388\AppData\Local\Temp\dsh-probe-home\cordis.patch.yml
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: minimal
    roots:
      - path: ~/probe-root
        trust: user
=== hmr row after home patch ===
  name: '@deepseek-ai/cordis-plugin-timer'
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app, C:\Users\31388\AppData\Local\Temp\dsh-probe-home\cordis.patch.yml
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root:
      - .
  disabled: false
=== last 12 lines (top-level insert appends) ===
- id: ui-trajectory
  name: '@deepseek-ai/dsh-client-ui-trajectory'
# == @deepseek-ai/dsh-web-app, patched by C:\Users\31388\AppData\Local\Temp\dsh-probe-home\cordis.patch.yml
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: minimal
# == C:\Users\31388\AppData\Local\Temp\dsh-probe-home\cordis.patch.yml
- id: probe-inserted-row
  name: '@deepseek-ai/dsh-tool-todo'
```

(The `# ==` lines and the layer ORDER visible in them — `@deepseek-ai/dsh-base`, then `@deepseek-ai/dsh-web-app`, then the home `cordis.patch.yml` — are produced by `renderConfigDump` at `<PKG>\dsh-app-boot\lib\index.js:926-952`.)

### Q1.4 `composeEntries` (quoted) — the same single call

```js
function composeEntries(layers, warn = () => {}) {
	return applyEntryPatches([], structuredClone(layers.flat()), (message, ...args) => {
		let index = 0;
		warn(message.replace(/%C/g, () => JSON.stringify(args[index++])));
	});
}
```
— `<PKG>\dsh-app-boot\lib\index.js:575-580`

Note the base is an **empty array**, not the bundle rows: every row in a profile tree comes from some patch layer's `insert`, which is why the profile's `cordis.yml` on disk is literally `[]` — `<DSH>\lib\profile-boot-DG5t9aNs.js:101-106` (`PROFILE_ROOT_CONFIG`).

### Q1.5 `resolveBundleDir` — resolution anchors and their order

```js
function packageDirFromAnchor(anchor, packageName) {
	for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
		const candidate = join(searchPath, packageName);
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
}
function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
	for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
		const dir = packageDirFromAnchor(anchor, packageName);
		if (dir !== void 0) return dir;
	}
	throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`);
}
```
— `<PKG>\dsh-app-boot\lib\index.js:499-524`

- Anchor order: **(1) the dsh installation's `package.json`** (`<DSH>\package.json`, defined at `<DSH>\lib\profile-boot-DG5t9aNs.js:98`), **(2) `<profileDir>\package.json`**. Installation-first is the documented contract so in-box bundles always come from the same installation — `<PKG>\dsh-app-boot\lib\types\profile.d.ts:133-145`.
- Resolution is a **directory probe** over Node's own `require.resolve.paths` order, deliberately not requiring the package to export `./package.json`, and `existsSync` follows symlinks/junctions — `<PKG>\dsh-app-boot\lib\index.js:491-505`.
- Literal probe output:

```text
resolveProfileDir("binary") = C:\Users\31388\.ohdsh\profiles\binary
resolveBundleDir(@deepseek-ai/dsh-base) = C:\Users\31388\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-base
resolveBundleDir(@deepseek-ai/schemastery) = C:\Users\31388\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\schemastery
resolveBundleDir(no-such-pkg-xyz) throws: dsh: cannot resolve profile bundle "no-such-pkg-xyz" from the dsh installation or C:\Users\31388\AppData\Local\Temp\dshnewprofile; run 'dsh plugin --profile dshnewprofile install' if its dependency is not installed
```

- Validation of the profile name itself (no `/`, `\`, `.`, `..`, `node_modules`, empty) — `<PKG>\dsh-app-boot\lib\index.js:318-321`.
- The flat fallback `<HOME>\profiles\node_modules` is maintained (185 entries right now) by `healProfilesModuleFallback`: BFS over the app manifest's `dependencies` + `peerDependencies`, one junction per package — `<PKG>\dsh-app-boot\lib\index.js:409-438`; called before every profile load at `<DSH>\lib\profile-boot-DG5t9aNs.js:141`.

### Q1.6 `initProfile` + `PROFILE_TEMPLATES` + `DEFAULT_PROFILE_BUNDLES`

```js
const PROFILE_TEMPLATES = { web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] };
const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];
```
— `<PKG>\dsh-app-boot\lib\index.js:322-334`

```js
function initProfile(dir, bundles) {
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) {
		const manifest = { name: `dsh-profile-${basename(dir)}`, private: true, dependencies: {}, dsh: { profile: { bundles: [...bundles] } } };
		writeFileSync(manifestPath, JSON.stringify(manifest, void 0, 2) + "\n");
	}
	const patchPath = join(dir, PROFILE_PATCH_FILENAME);
	if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE);
	const workspacePath = join(dir, "pnpm-workspace.yaml");
	if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE);
}
```
— `<PKG>\dsh-app-boot\lib\index.js:353-369`

`dsh plugin --profile binary add X` path:

```js
function runPlugin(profile, args) {
	const dir = resolveProfileDir(profile);
	if (!existsSync(join(dir, "package.json"))) {
		initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES);
		process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`);
	}
	const before = readProfileManifest(NAME, dir);
	const result = spawnSync("pnpm", args.map((a) => anchorPathSpec(a, process.cwd())), { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
	...
	if (exitCode === 0) reconcilePlugins(before, dir);
```
— `<DSH>\lib\plugin-9h8shc4d.js:101-121`

- A brand-new custom profile named `binary` therefore gets `dsh.profile.bundles = ["@deepseek-ai/dsh-base"]` on first `dsh plugin --profile binary add X`, plus an empty `cordis.patch.yml` and a `pnpm-workspace.yaml` with `nodeLinker: hoisted` / `autoInstallPeers: false` — `<PKG>\dsh-app-boot\lib\index.js:334-345`. Literal output of `initProfile(dir, DEFAULT_PROFILE_BUNDLES)`:

```text
DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]
PROFILE_TEMPLATES = {"web":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"],"headless":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}
--- files in new profile dir: cordis.patch.yml, package.json, pnpm-workspace.yaml
--- package.json ---
{
  "name": "dsh-profile-dshnewprofile",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base" ] } }
}
--- cordis.patch.yml ---
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
--- pnpm-workspace.yaml ---
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

- `add X` also **reconciles** `dsh.profile.bundles` against installed state: a dependency whose package declares `dsh.bundle.patch` is appended to the list; a removed/bundle-less dependency is dropped from it; a plain library install prints a warning and is not added — `<DSH>\lib\plugin-9h8shc4d.js:46-78` and `:25-33`.

What `dsh --profile binary` gets when the profile **directory was created by something else**:

- **No `package.json` in the dir** → treated as non-existent; `binary` has no template ⇒ hard error (no dir is created, no bundle list is invented) — `<PKG>\dsh-app-boot\lib\index.js:541-545`. Literal output against a throwaway `DSH_HOME`:

```text
Error: dsh: profile "binary" does not exist; create it with 'dsh plugin --profile binary add <package>'
    at loadProfile (…/dsh-app-boot/lib/index.js:543:34)
    at prepareProfile (…/dsh/lib/profile-boot-DG5t9aNs.js:142:18)
    at runDumpConfig (…/dsh/lib/dump-config-D-jtgwY3.js:24:17)
```

- **`package.json` present but no `dsh.profile`/`bundles`** → `bundles = []`, so the composition is EMPTY: zero plugin rows, only whatever other layers add. Literal output (I created such a dir in a temp home):

```text
=== dsh --profile binary --dump-config ===
[exit=0]                       # stdout was a single newline; the composed list is empty
=== files now in the profile dir ===
cordis.yml      223
package.json     75
=== cordis.yml content ===
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

`prepareProfile` **always rewrites** `<profileDir>\cordis.yml` to that empty list before boot, precisely because the vendored Loader can write the composed tree back into its include file — `<DSH>\lib\profile-boot-DG5t9aNs.js:140-145` and `:127-139`.

### Q1.7 The `!!js` expression scope (quoted) and `baseUrl`

Evaluation primitive — a `new Function` with `with (ctx)`:

```js
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`) as ((ctx: object, expr: string) => any)
```
— `<PKG>\cordis-plugin-loader\src\config\utils.ts:5-9`, bundle copy at `<PKG>\cordis-plugin-loader\lib\index.js:279-283`

Where it is invoked with which scope:

```js
ctx.on('internal/config', function (this: Fiber, _config, next) {
  const config = next()
  if (!this.entry || this.parent.fiber?.entry === this.entry) return config
  // Tree carriers (Group, Include) keep their configs literal: their
  // entry and patch lists hold other rows' configs, whose `!!js`
  // expressions belong to those rows' own fibers.
  const plugin = this.runtime?.callback as …
  if (plugin?.[EntryGroup.key]) return config
  return interpolate(this.ctx, config)
}, { global: true })
```
— `<PKG>\cordis-plugin-loader\src\index.ts:92-101` (bundle: `<PKG>\cordis-plugin-loader\lib\index.js:675-680`)

So the scope object is **the running plugin's own fiber context** (`this.ctx`), not the file, not the module, not a sandbox. Identifier reachability therefore = (properties of that context chain) ∪ (Node globals). What is registered on the context by the harness: `ctx.provide("dshHomePath", dshHomePath)` — `<PKG>\dsh-app-boot\lib\index.js:1172`; `baseUrl` is an own property set by the boot/Include code — `<PKG>\dsh-app-boot\lib\index.js:1171` and `:138`.

Probe of the exact construct (`new Function('ctx','expr', 'with (ctx) { return eval(expr) }')`, Node v24.20.0 ESM, ctx carrying `baseUrl`/`dshHomePath`):

```text
typeof process                                => object
typeof require                                => undefined
typeof import                                 => THROWS SyntaxError: Cannot use import statement outside a module
typeof fileURLToPath                          => undefined
baseUrl                                       => file:///C:/x/profiles/web/
typeof dshHomePath                            => function
typeof globalThis                             => object
typeof loader                                 => object
typeof module                                 => undefined
typeof __dirname                              => undefined
typeof fetch                                  => function
dynamic import('node:os').then => OK-os
require => THROWS require is not defined
```

Conclusions:

- `process` **is** reachable (Node global); shipped presets rely on it — `<DSH>\config\agent-presets\minimal\agent.cordis.yml:32,38,53,60,83` use `!!js process.platform …` / `process.env.DSH_CWD ?? process.cwd()`.
- `dshHomePath` **is** reachable **because the host provided it on the context** — `<PKG>\dsh-app-boot\lib\index.js:1172`; without that provide it would be a `ReferenceError`.
- `baseUrl` is reachable as a context property (it resolved to the value I put on `ctx`).
- `require` is **not** reachable in an ESM process (no global `require`; the loader module is ESM so its `new Function` body compiles in global scope). `fileURLToPath`, `module`, `__dirname` are equally unreachable. A static `import` statement is a SyntaxError.
- Dynamic `import()` **does** work from the expression (it is an expression, not a statement). **unverified**: whether a relative dynamic `import()` inside a patch expression resolves against any particular base — I did not test that, and the loader never sanctions it.
- A patch could only reach `require` if something had defined `require` on the context chain or on `globalThis`. **unverified in the live dsh process** (my probe tests the construct, not that process's globals).

`baseUrl` for a **bundle patch file** vs the **profile patch file**: both are the **profile directory** (the directory of the root `cordis.yml`), NOT the directory of the patch file. Evidence chain:

- `Include` derives its tree `baseUrl` from the config file it included: `this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl)); … this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href;` — `<PKG>\dsh-app-boot\lib\index.js:133-138`.
- The root include is `<profileDir>\cordis.yml` — `<DSH>\lib\profile-boot-DG5t9aNs.js:108` (`PROFILE_ROOT_FILENAME = "cordis.yml"`), written at `:143`, mounted at `:247`/`:240`.
- An entry's context inherits the tree context: `EntryTree` copies `baseUrl` (`this.ctx = ctx.extend({ baseUrl: ctx.baseUrl })` — `<PKG>\cordis-plugin-loader\src\config\tree.ts:15-17`), and `Entry._patchContext` links the entry ctx to its parent group before the config is applied (`Object.setPrototypeOf(this.ctx, this.parent.ctx)` — `<PKG>\cordis-plugin-loader\src\config\entry.ts:114-122`), with `_start` calling `_patchContext([])` **before** `registry.plugin(plugin, this.options.config, …)` — `<PKG>\cordis-plugin-loader\src\config\entry.ts:291-297`.
- Both bundle patches and the profile patch are just **data** applied into that one root include's entry list (`applyEntryPatches`), so all of their rows live in the profile-dir-anchored tree and see the same `baseUrl`. Nothing anywhere re-anchors a patch row to the patch file's own directory (only a `cordis:include` group row changes `baseUrl`, by including a *different* file — `<PKG>\dsh-app-boot\lib\index.js:133-138`).
- Consequence: a patch row's relative `name: ./x.js` resolves against the **profile directory**, not against the bundle or patch file. **Partially unverified**: I verified this by reading the code path end to end but did not run a live `!!js baseUrl` probe inside a booted tree.

### Q1.8 Plugin module resolution, and the JUNCTION consequence

The Loader resolves a plugin entry's specifier against **its own tree's `baseUrl`**, through Node's internal ESM loader when available:

```js
import(name, getOuterStack) {
  if (name.startsWith('cordis:')) return this.ctx.loader.builtins[name.slice(7)]
  return composeError(async (info) => {
    info.offset += 3
    if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})
    else if (name.startsWith('.')) return await import(new URL(name, this.ctx.baseUrl).href)
    else return await import(name)
  }, getOuterStack)
}
```
— `<PKG>\cordis-plugin-loader\src\config\tree.ts:144-162`

- For `dsh --profile <p>`, `boot()` is called **without** `bareModuleBaseUrl` (`runProfile` passes 4 args — `<DSH>\lib\profile-boot-DG5t9aNs.js:247`), so the root include is the plain `Include` class, not the `HostResolvedRootInclude` subclass that would resolve bare names against an installed host — `<PKG>\dsh-app-boot\lib\index.js:964-975`.
- Therefore a bare package name in a row is resolved **from the profile directory** (the tree `baseUrl`), i.e. Node walks `<profileDir>\node_modules`, then `<HOME>\profiles\node_modules` (the flat fallback of junctions into the install), then up. Not "from the plugin's own directory" — the loader has no per-plugin directory concept at all.
- The profile `web` has **no** `node_modules` of its own (`Test-Path <HOME>\profiles\web\node_modules` → `False`), so in practice in-box plugins resolve via the flat fallback `<HOME>\profiles\node_modules` (185 entries).

**Junction consequence (documented Node realpath behaviour + my experiment).** Node's ESM/CJS resolution realpaths the resolved module (default `--preserve-symlinks=false`), so a plugin package that is a **junction to a directory outside the profile tree** gets a module URL at its REAL location, and every bare import *inside that plugin* is resolved from the real directory's ancestor chain — never from `<profileDir>\node_modules` and never from `<HOME>\profiles\node_modules`. Experiment I ran (junction package vs byte-identical copied package, both imported from a profile-like tree, with `@deepseek-ai/schemastery` junctioned only into the profile-side `node_modules`):

```text
=== test-junction ===
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery' imported from C:\Users\31388\AppData\Local\Temp\dshtest\real\plugin\lib\index.mjs
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)
    at packageResolve (node:internal/modules/esm/resolve:784:25)
    at moduleResolve (node:internal/modules/esm/resolve:873:18)
    at defaultResolve (node:internal/modules/esm/resolve:1006:11)
    …
  code: 'ERR_MODULE_NOT_FOUND'
Node.js v24.20.0

=== test-copy ===
copied pkg -> [Module: null prototype] { default: 'object' }
```

- The error names the REAL path (`…\dshtest\real\plugin\lib\index.mjs`) even though the import was by bare specifier resolved through `…\dshtest\profile\node_modules\@test\plugin` (a junction) — that is the realpath behaviour, observed.
- **Answer: no.** A plugin whose directory is a junction into e.g. `D:\somewhere` **cannot** `import '@deepseek-ai/schemastery'` merely because that package is reachable from the profile. Its own dependency resolution starts at `D:\somewhere\...` and walks `D:\somewhere\node_modules`, `D:\node_modules`, … Node never walks back through the profile tree.
- Ways it can work: the plugin physically lives under the profile's `node_modules` (a pnpm/NPM install rather than a hand-made junction), or the target package is reachable from the plugin's real location (its own `node_modules`, a parent `node_modules`, or a global path). The harness's own comment describes the intended contract for physically-installed packages: "Symlinked packages resolve their own dependencies from their real directories (Node's default symlink-following), so each package needs only its one flat link" — `<PKG>\dsh-app-boot\lib\index.js:400-402`.

---

## Q2 — Tool definition API (`dsh-tools`)

### Q2.1 `defineTool` options — exact shape

```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string;
    readonly description: string;
    readonly parameters: S;
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```
— `<PKG>\dsh-tools\lib\types\schema.d.ts:177-239`

Requiredness (TypeScript): **required** = `name`, `description`, `parameters`, `output.schema`, `output.render`, `execute`. **Optional** = `output.presentationMeta`, `timeoutMs`, `isConcurrencySafe`, `finalizeContent`, `presentCall`, `presentResult`.

Implementation (what `defineTool` actually produces):

```js
export function defineTool(options) {
    const userExecute = options.execute; …
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
        throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
    const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
    const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
    const validate = (args) => validateJsonSchemaValue(parameters, args, '');
    const tool = { name, description, parameters, output: { schema: outputSchema, render(args, value) { return userRender(args, value); }, … }, …(timeoutMs), async execute(args, exec) { const violations = validate(args); if (violations.length > 0) throw new ToolArgsError(violations); return userExecute(args, exec); } };
    …
}
```
— `<PKG>\dsh-tools\lib\types\schema.js:274-348`

- `presentCall`/`presentResult`/`isConcurrencySafe` are wrapped so that **invalid args return `undefined`/`false` instead of throwing** (replay-safety) — `<PKG>\dsh-tools\lib\types\schema.js:322-346`.
- `execute` validates arguments **first** and throws `ToolArgsError` (`code: 'INVALID_ARGS'`) — `<PKG>\dsh-tools\lib\types\schema.js:312-317`, error class at `:249-257`.
- The registry-facing type is `ToolDefinition` (raw JSON Schema in `output.schema`, `parameters` as a JSON Schema object) — `<PKG>\dsh-tools\lib\types\index.d.ts:96-172`.

### Q2.2 Parameter schema DSL

Accepted keys per node (author vocabulary, enforced by `assertAuthorKeys`):

| node | accepted keys |
|---|---|
| any node | `description`, `title`, `default`, `examples` (`ANNOTATION_KEYS`) |
| `string`/`number`/`integer`/`boolean`/`null` | `+ type`, `enum`, `const` |
| `array` | `+ type`, `items` |
| `object` | `+ type`, `properties`, `additionalProperties` (mandatory boolean) |
| `json` | `+ type` |
| `oneOf` | `+ oneOf` (≥2 branches; mutually exclusive with `type`) |
| property positions | `+ required: true` |

— `<PKG>\dsh-tools\lib\types\schema.js:4` (ANNOTATION_KEYS), `:126,131-135,150-205` (per-type `assertAuthorKeys`), `<PKG>\dsh-tools\lib\types\schema.d.ts:9-84`.

- **`{ type: 'string', required: true, description, enum }` IS valid** for a parameter property; `required` is expressed **per property** as `required: true` and is compiled into a JSON Schema `required: [names]` array. There is **no** separate `required` array form: passing one throws.
- `ParameterSchemaSpec` is "an implicit open object root; requiredness remains a per-property `required: true` annotation" — `<PKG>\dsh-tools\lib\types\schema.d.ts:77-84`; only `required: true` is accepted (`required: false` throws) — `<PKG>\dsh-tools\lib\types\schema.js:78-82`.
- **`parameters: {}` means "a tool with no declared arguments"** and compiles to `{"type":"object","properties":{}}` (no `required` key at all) — `<PKG>\dsh-tools\lib\types\schema.js:238-247`.
- Literal probe of the real exported functions:

```text
parameters {type:string,required:true,description,enum} => {"type":"object","properties":{"mode":{"type":"string","description":"pick one","enum":["a","b"]}},"required":["mode"]}
parameters {} => {"type":"object","properties":{}}
parameters {x:{type:'string'}, required:['x']} => THROWS JsonSchemaError: unsupported JSON schema: parameters.required must be a value schema object
parameters with bogus key => THROWS JsonSchemaError: unsupported JSON schema: parameters.x.bogus is not supported by the value schema DSL
parameters with required:false => THROWS JsonSchemaError: unsupported JSON schema: parameters.x.required must be true when present
parameters with type 'text' => THROWS JsonSchemaError: unsupported JSON schema: parameters.x.type must be string/number/integer/boolean/null/array/object/json, or use oneOf
parameters with array root => THROWS JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object
validateArgs ok: []
validateArgs missing: ["missing required property \"x\""]
tool.execute({}) => ToolArgsError: invalid arguments: missing required property "x"
```

### Q2.3 Output schema

- Shape: `output: { schema: <ValueSchemaSpec>, render(args, value): ContentBlock[], presentationMeta?(args, value): JsonValue }`; `render` is **required** — `<PKG>\dsh-tools\lib\types\schema.d.ts:185-193`.
- `output.schema` in `defineTool` is the **author DSL** (`ValueSchemaSpec`, i.e. the same node vocabulary as parameters, but as a value ROOT and without `required`) — `<PKG>\dsh-tools\lib\types\schema.d.ts:71-72,124-148`; it is compiled to raw JSON Schema by `valueSchemaSpecToJsonSchema` and asserted against the enforced subset — `<PKG>\dsh-tools\lib\types\schema.js:228-232`.
- Required output properties are declared exactly like parameter properties: a per-property `required: true` inside `properties`, which the compiler turns into the JSON Schema `required` array (`task.required.push(task.key)` → `task.compiled.required = task.required`) — `<PKG>\dsh-tools\lib\types\schema.js:67-72, 78-82`.
- **`{ type: 'object', additionalProperties: false, properties: { x: { type: 'string', required: true } } }` IS valid**; `additionalProperties` is mandatory on every object node (`"must be explicitly true or false"`) — `<PKG>\dsh-tools\lib\types\schema.js:156-171`.
- Literal probe:

```text
output schema object example => {"type":"object","additionalProperties":false,"properties":{"x":{"type":"string"}},"required":["x"]}
output schema {type:'object',properties:{...}} (no additionalProperties) => THROWS JsonSchemaError: unsupported JSON schema: schema.additionalProperties must be explicitly true or false
defineTool keys: name,description,parameters,output,execute
defineTool.output.schema: {"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"}},"required":["ok"]}
```

- The output value is validated against this schema and a violation is a `ToolOutputError` — `<PKG>\dsh-tools\lib\types\index.d.ts:382-387`.

### Q2.4 Can anything FORCE the model to call a tool, or block a step / require a call?

**No — "force the model to call tool X first" is not expressible with any primitive in this registry.** The complete set of levers, with the reason each one cannot force a call:

1. **`ctx.tools.register(definition)`** — registers a tool and returns its disposer — `<PKG>\dsh-tools\lib\types\index.d.ts:597-603`, impl `<PKG>\dsh-tools\lib\index.js:2762-2770`. Registration only makes a tool *visible*.
2. **`ctx.tools.restrict({allow?, deny?})`** — masks the visible surface (agent-scoped only; throws from a plain context) — `<PKG>\dsh-tools\lib\types\index.d.ts:604-611`, impl `<PKG>\dsh-tools\lib\index.js:2780-2793`. Removing tools from the schema list cannot make the model pick a remaining one.
3. **`ctx.tools.guard(fn)`** — the only veto primitive, and it is **deny-only**. Exact doc comment:

```
    /**
     * Register a monotonic guard after the extensible `tools/pre-execute`
     * waterfall. A plain-context guard applies globally; one registered through
     * `agent.ctx` applies only to that agent. Any matching guard may deny by
     * returning a reason, while no guard can force-allow a call another guard
     * denied. The exact effect disposer is returned for ordered ownership and
     * HMR cleanup.
     * @param guard - synchronous check; a returned string denies the execution.
     * @returns the exact disposer that unregisters the guard.
     */
    guard(guard: ToolGuard): () => void;
```
— `<PKG>\dsh-tools\lib\types\index.d.ts:612-622` (identical text in the runtime impl doc at `<PKG>\dsh-tools\lib\index.js:2795-2810`)

and the type:

```ts
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
```
— `<PKG>\dsh-tools\lib\types\index.d.ts:480-488`; enforcement: "First monotonic denial from the global then the scope chain's guard layers, farthest first" — `<PKG>\dsh-tools\lib\index.js:2811-2820`, per-layer at `:2535-2541`. There is no allow/positive branch, so no guard can require a call.

4. **`tools/pre-execute` waterfall** — returns `PreToolDecision = {kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}` — `<PKG>\dsh-tools\lib\types\index.d.ts:412-426`, dispatch at `<PKG>\dsh-tools\lib\index.js:3105`. Same story: allow/deny/ask, no requirement channel.
5. **`tools/post-execute` waterfall** — `PostToolDecision`: accept (optionally replacing content), accept with a replacement `value`, or **block** with corrective `feedback` + `additionalContexts` — `<PKG>\dsh-tools\lib\types\index.d.ts:427-445`, doc `:50-61`. Blocking turns a result into an error the model may react to; it does not compel a specific next call.
6. **Events** — the complete list declared by the registry is `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/code-dispatch-log`, `tools/result`, `tools/change` — `<PKG>\dsh-tools\lib\types\index.d.ts:38,49,61,75,83,93`. None of them is a "require a call" channel; `tools/result` is an observe-only emit (listener failures contained).
7. **The request vocabulary has no `tool_choice`** — `GenerateOptions` is exactly `provider`, `model`, `reasoningEffort?`, `messages`, `system?`, `tools?`, `temperature?`, `maxTokens?`, `stop?`, `signal?`, `sessionId?`, `purpose?` — `<PKG>\dsh-llm\lib\types\types.d.ts:331-368`. Documented as a deliberate gap: "**`GenerateOptions` sampling is `temperature`/`maxTokens`/`stop` only** — no `tool_choice`, `top_p`, or penalty fields" — `<PKG>\dsh-llm\README.md:103`, and for the adapter: "**`tool_choice` is not mapped** — not part of the core vocabulary (MVP cut…)" — `<PKG>\dsh-llm-deepseek\README.md:139`. A whole-tree search for `tool_choice`/`toolChoice`/`requireToolCall`/`forceToolCall` finds only those doc/readme lines, no implementation.
8. **Reminder-style nudges exist but are advisory** — the nearest thing shipped is `@deepseek-ai/dsh-repeat-tool-reminder`, described as "Repeat-tool-call guard plugin: advisory reminders when an agent loops on identical tool calls" — `<PKG>\dsh-repeat-tool-reminder\package.json:3`. "Advisory" is the whole point: it reminds, it cannot require.

What a plugin *can* do to approximate "call X first": deny everything else from `tools/pre-execute` or a `guard` (message text can demand the call), then allow X; or attach a corrective `additionalContexts`/`feedback` message. All of that is prompt pressure + veto, not an enforced requirement.

### Q2.5 `concludesTurn` — how a tool result ends a turn, and where it is documented

- Documented API: `ToolRunContext.concludeTurn(): void` — "Mark a successful final result as terminal for the current agent turn. The marker rides this execution's own result (`concludesTurn` exists only on `ToolExecutionSuccess`)…" — `<PKG>\dsh-tools\lib\types\index.d.ts:283-300`.
- Result field: `ToolExecutionSuccess.concludesTurn?: true` (and `ToolExecutionFailure.concludesTurn?: never`) — `<PKG>\dsh-tools\lib\types\index.d.ts:388-409`.
- Implementation: `concludeTurn() { concludingExecutions.add(this); }` into a `WeakSet` keyed by the execution — `<PKG>\dsh-tools\lib\index.js:3025-3039`; the flag is materialized onto the success result — `<PKG>\dsh-tools\lib\index.js:3426-3432`; nested/composite transports forward `result.concludesTurn` — `<PKG>\dsh-tools\lib\index.js:3469` and `<PKG>\dsh-tools\lib\types\code-mode.js:469-474`; the subagent report path propagates the nested marker — `<PKG>\dsh-tools\lib\index.js:1302`.
- Consumer (turn actually stops): the agent loop records it while committing the batch: `concluded ||= result.concludesTurn === true;` — `<PKG>\dsh-agent-loop\lib\index.js:184`.
- Additional authoritative doc text (event that states the contrast, in the generated API surface reachable to agents): "The inverse control (stop a tool loop early) is data too: a tool result carrying `concludesTurn` ends the turn at its step. The conclusion never short-circuits already-submitted next-step work: same-step `additionalContexts` or racing steering still runs, and the turn closes only when that inbox drains." — `<PKG>\dsh-agent\lib\types\runtime-types.d.ts:284-294` (doc on `agent/turn-stopping`), duplicated into the agent-facing declarations at `<PKG>\dsh-tool-cordis\lib\index.js:3872`.
- Shipped users of the marker: `@deepseek-ai/dsh-tool-goal` (a successful autonomous `complete`/`blocked` round) — `<PKG>\dsh-tool-goal\README.md:17`; `@deepseek-ai/dsh-subagent-in-process-driver` (structured-output execution) — `<PKG>\dsh-subagent-in-process-driver\lib\index.js:75`, `<PKG>\dsh-subagent-in-process-driver\README.md:45`.

---

## Q3 — Client-side plugin serving (`dsh-client-modules`)

### Q3.1 How `/plugins/<pkg>/client.js` is resolved

The node half is a service that scans **enabled Loader entries** for web `dsh.client` packages and serves their built bundles:

```js
constructor(ctx) {
    super(ctx, "clientModules");
    if (ctx.baseUrl === void 0) throw new Error("client-modules: ctx.baseUrl is unset — the node half needs the config-tree anchor to resolve plugin packages");
    const require = createRequire(ctx.baseUrl);
    this.resolvePkgJson = (spec) => require.resolve(`${spec}/package.json`);
    …
    ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/plugins", handler: this.serveBundle }), "client-modules: bundle route");
```
— `<PKG>\dsh-client-modules\lib\index.js:272-299`

```js
serveBundle = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const prefix = "/plugins/";
    const mapSuffix = "/client.js.map";
    const bundleSuffix = "/client.js";
    const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix);
    const suffix = isSourceMap ? mapSuffix : bundleSuffix;
    const clientPath = pathname.startsWith(prefix) && pathname.endsWith(suffix) ? this.clientPath(pathname.slice(9, -suffix.length)) : void 0;
    const path = clientPath === void 0 ? void 0 : `${clientPath}${isSourceMap ? ".map" : ""}`;
    if (path === void 0) { res.writeHead(404); res.end(); return; }
    try {
        const body = await readFile(path);
        res.writeHead(200, { "content-type": isSourceMap ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-cache" });
        res.end(body);
    } catch { res.writeHead(404); res.end(); }
};
```
— `<PKG>\dsh-client-modules\lib\index.js:459-490`

Resolution details:

- The route is a **prefix** registration on `webServer` for `/plugins` (`:295-299`); `pathname.slice(9, -suffix.length)` strips exactly `"/plugins/"` and the `/client.js[.map]` suffix, so the id is the **bare package name** (query string, e.g. `?rev=…`, is ignored because only `pathname` is used) — `:466-472`.
- `clientPath(id)` is a **map lookup keyed by loader-entry id** (the package name): `return this.table.get(id)?.meta.clientPath;` — `<PKG>\dsh-client-modules\lib\index.js:316-318`.
- The table is built by `processOne`, which requires a **live, enabled loader entry** with that name: `for (const entry of this.ctx.loader.entries()) if (entry.options.name === entryName && entry.fiber !== void 0 && !entry.disabled) { qualifies = true; break; } if (!qualifies) return this.table.delete(entryName);` — `<PKG>\dsh-client-modules\lib\index.js:421-431`.
- For a qualifying entry, `resolveMeta` resolves `<pkg>/package.json` **from the profile anchor** using `createRequire(ctx.baseUrl)` (`ctx.baseUrl` = the config-tree anchor), requires `dsh.client.platform === "web"`, then requires an `exports["./client"]` bundle and joins it to the package directory — `<PKG>\dsh-client-modules\lib\index.js:274-276, 377-404`; failures to resolve return `null` (`:381-386`).
- Missing bundle file → `MissingClientBundleError` at activation (`:412-419`); the whole service throws one aggregate `ClientPackageCompositionError` if any already-loaded entry is malformed — `<PKG>\dsh-client-modules\lib\index.js:291-294`.
- README summary of the same: "The Node half scans enabled Loader entries for web `dsh.client` packages, resolves each `exports["./client"]`, hashes the built bundle into the boot graph … and serves each bundle with its source map under `/plugins`." — `<PKG>\dsh-client-modules\README.md:13`.

### Q3.2 Why a package absent from the profile's node_modules yields HTTP 404

Two independent failure points, both landing on the same `res.writeHead(404)` at `<PKG>\dsh-client-modules\lib\index.js:474-478` (and the `catch` at `:486-489`):

1. **It is not a live loader entry** (never mounted as a plugin row in the booted profile tree, or disabled) → `processOne` never inserts it → `clientPath(id)` → `undefined` → 404 — `<PKG>\dsh-client-modules\lib\index.js:421-431, 316-318, 474-478`.
2. **It is an entry but Node cannot resolve `<pkg>/package.json` from the profile anchor** → `resolveMeta` returns `null` (`createRequire(profileAnchor).resolve(...)` throws) → not in the table → 404 — `<PKG>\dsh-client-modules\lib\index.js:274-276, 381-386, 429-430`.

A package that is *not in `<profileDir>\node_modules`* but *is* in the flat fallback `<HOME>\profiles\node_modules` still resolves (the parent walk finds it) — which is exactly why in-box `@deepseek-ai/*` bundles are served today: the current `web` profile has **no** `node_modules` of its own and relies entirely on the fallback. A third-party package that was never installed (or was installed into a different profile) is absent from BOTH, and additionally is usually not a mounted entry — so both checks fail.

### Q3.3 Is there ANY built-in plugin marketplace in dsh?

**No.** Whole-tree search (`ripgrep` over `<DSH>\node_modules\@deepseek-ai`, then over the whole installed `@deepseek-ai` package root including the frontend dist):

- `(?i)marketplace` matches **nothing** in any `@deepseek-ai` package. The only hits in the entire installed `@deepseek-ai` tree are third-party dependencies: `@google/genai` docs/Typescript files ("Google Cloud Marketplace") and `clsx\readme.md` (a VS Code Marketplace link).
- `bridge failed` matches **nothing** anywhere.
- The frontend bundles `<PKG>\dsh-web-frontend\dist\assets\index-ClqxG24t.js` (399 KB) and `vendor-D22_Mp1f.js` (745 KB): `Select-String -SimpleMatch 'marketplace'` → **0** hits.
- The built-in Plugins UI is configuration/inventory only, not a store:
  - `<PKG>\dsh-client-ui-settings-plugins\README.md:5,9,15,37` — "The **Plugins** settings section and its **Plugin configuration** tab… one expandable card per Host plugin whose configuration a user owns"; the client bundle's own copy is `intro: "Configure and inspect the plugins installed in this deployment."` — `<PKG>\dsh-client-ui-settings-plugins\lib\client.js:1126`.
  - `<PKG>\dsh-host-plugin-inventory\README.md:5,22` — a "Read-only Host projection of the current Cordis Loader tree", which "cannot enable, disable, add, or remove plugins".
- The only install channel in the CLI is `dsh plugin --profile <name> <pnpm args>`, a thin pnpm forwarder — `<DSH>\lib\bin.js:96-105`, `<DSH>\lib\plugin-9h8shc4d.js:101-127`.
- There are **no** `/api/marketplace` or `/api/plugins` routes (live test below); the host's own plugin surface is the generated remote `pluginInventory/list` — `<PKG>\dsh-host-plugin-inventory\README.md:5`.

### Q3.4 Live tests against the running server (`http://127.0.0.1:3080`)

Literal `curl.exe` output (nothing was killed; the server is the user's live `dsh web`):

```text
=== GET http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-client-modules/client.js
HTTP/1.1 200 OK
content-type: text/javascript; charset=utf-8
cache-control: no-cache
Transfer-Encoding: chunked

HTTP_CODE:200
BYTES:15347
BODY(first 300): window.__ModuleLoader__.load({ 	id: "@deepseek-ai/dsh-client-modules", 	factory: (require) => { 		var module = { exports: {} }; …

=== GET http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-client-runtime/client.js
HTTP/1.1 200 OK
content-type: text/javascript; charset=utf-8
cache-control: no-cache

HTTP_CODE:200
BYTES:392229
BODY(first 300): window.__ModuleLoader__.load({ 	id: "@deepseek-ai/dsh-client-runtime", 	factory: (require) => { … let _deepseek_ai_cordis = require("@deepseek-ai/cordis"); …

=== GET http://127.0.0.1:3080/api/marketplace
HTTP/1.1 404 Not Found
content-type: text/plain;charset=UTF-8

HTTP_CODE:404
BYTES:9
BODY(first 300): not found

=== GET http://127.0.0.1:3080/api/plugins
HTTP/1.1 404 Not Found
content-type: text/plain;charset=UTF-8

HTTP_CODE:404
BYTES:9
BODY(first 300): not found
```

Extra 404 characterization (same server), showing the two failure modes:

```text
=== GET http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-tools/client.js
HTTP_CODE:404 BYTES:0
=== GET http://127.0.0.1:3080/plugins/@deepseek-ai/nonexistent-pkg/client.js
HTTP_CODE:404 BYTES:0
=== GET http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-client-modules/nope.js
HTTP_CODE:404 BYTES:0
```

`@deepseek-ai/dsh-tools` **is** a live entry but declares no `dsh` section at all, hence no client half — so its 404 comes from failure point 2 (`resolveMeta` → `null`), not from being unmounted:

```text
=== dsh-tools package.json 'dsh' section ===
                                          # (empty: the field is absent)
=== dsh section of a few packages (has client?) ===
dsh-client-runtime -> {"client":{"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-typert-registry","@deepseek-ai/dsh-api-remotes"],"platform":"web","immediately":true}}
dsh-api-gateway -> {"client":{"inject":["@deepseek-ai/dsh-typert-registry","@deepseek-ai/dsh-client-connection"],"platform":"web","immediately":true}}
dsh-tool-todo ->
dsh-agent-presets ->
dsh-host-plugin-inventory ->
```

The live boot graph the page actually loads (parsed out of `GET /` → the `__DSH_BOOT__` script tags) contains 44 `/plugins/…/client.js` URL occurrences, every one of them `@deepseek-ai/`-namespaced (two ids appear twice — once as a parser preload and once inside the boot graph):

```text
/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=7eb526320903
/plugins/@deepseek-ai/dsh-client-runtime/client.js?rev=aba836a0c42d
/plugins/@deepseek-ai/dsh-typert-registry/client.js?rev=f41d56e0b747
… (44 total, all @deepseek-ai/…)
```

### Q3.5 Where "plugin marketplace bridge failed" comes from

- It is **not produced anywhere in the dsh install**: `(?i)marketplace` has zero hits in every `@deepseek-ai` package except unrelated third-party dependency docs, and `bridge failed` has zero hits at all (Q3.3).
- It comes from a **third-party plugin**, not from dsh. Corroborating evidence on this machine:
  - A captured page snapshot in the workspace, `D:\实习\_boot.html`, contains third-party entries in `window.__DSH_BOOT__`, e.g. `{"id":"@oh-dsh/web","url":"/plugins/@oh-dsh/web/client.js?rev=38f39df5bf6a", …}` (grep of that file), and — per the prior session's own analysis at `D:\实习\dsh-opensecurity-plugin-方案.md:284-313` — a `@oh-dsh/plugin-marketplace` entry too.
  - That plugin is **not installed now**: the current profile `<HOME>\profiles\web` has no `node_modules` at all (`Test-Path` → `False`), `<HOME>\profiles\node_modules` contains no `@oh-dsh` scope directory, and a search of all of `<HOME>` for `oh-dsh` returns nothing. Hence `/plugins/@oh-dsh/plugin-marketplace/client.js` → 404 (as recorded in that same doc's live table).
- **unverified**: the literal string "plugin marketplace bridge failed" could not be located in any file I can inspect — not in the dsh install, not in `<HOME>`, not in the installed `@oh-dsh` packages (which are absent). I have no copy of `@oh-dsh/plugin-marketplace`'s source, so I cannot quote where *that plugin* constructs the message. What I can state from evidence is: (a) the string is not dsh's; (b) the plugin that owns it is not installed in the current profile; (c) the 404 its bridge saw is the documented behaviour of the `/plugins` route for a package that is not a mounted entry resolvable from the profile anchor.

---

## Q4 — Agent preset mechanism (`dsh-agent-presets`)

### Q4.1 On-disk layout it discovers

```ts
/** The composition file that makes a directory a preset. */
export declare const COMPOSITION_FILE = "agent.cordis.yml";
export declare const USER_PRESET_DIR = ".agent-presets";
```
— `<PKG>\dsh-agent-presets\lib\types\discovery.d.ts:17-18, 32`

- A preset is **a directory whose name is the preset id**, holding `agent.cordis.yml` (the composition) and optionally `preset.yml` (display metadata only: `name`, `description`, `order`) — `<PKG>\dsh-agent-presets\README.md:5, 73-82`; metadata file constant `METADATA_FILE` re-exported at `<PKG>\dsh-agent-presets\lib\types\index.d.ts:37`.
- Ids must match `[a-z0-9][a-z0-9-]*` (`PRESET_ID`), because the id becomes a path segment; other directories are skipped, not reported broken — `<PKG>\dsh-agent-presets\lib\types\preset.d.ts:8-16`, `<PKG>\dsh-agent-presets\README.md:11`.
- Discovery is **unmemoized** — `list()`/`resolve()` re-read the roots per call — `<PKG>\dsh-agent-presets\lib\types\index.d.ts:48-54`; health is a shape check that reports a `broken` reason instead of hiding the row — `<PKG>\dsh-agent-presets\lib\types\preset.d.ts:31-37`.
- Shipped presets in this installation (the root the launcher injects):

```text
<DSH>\config\agent-presets\code\agent.cordis.yml       13605
<DSH>\config\agent-presets\code\preset.yml               172
<DSH>\config\agent-presets\cordis\agent.cordis.yml     14185
<DSH>\config\agent-presets\cordis\preset.yml             180
<DSH>\config\agent-presets\cordis\skills\cordis-plugin-development\SKILL.md   20923
<DSH>\config\agent-presets\cordis\skills\editing-cordis-compositions\SKILL.md 14414
<DSH>\config\agent-presets\minimal\agent.cordis.yml     3673
<DSH>\config\agent-presets\minimal\preset.yml            113
<DSH>\config\agent-presets\standard\agent.cordis.yml   13103
<DSH>\config\agent-presets\standard\preset.yml           176
```

(`preset.yml` files carry UTF-8 Chinese display names — `order: 1` standard, `2` code, `3` minimal, `4` cordis.)

### Q4.2 The `agent-presets` row config keys

```js
static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({ path: z.string().required(), trust: z.union(["system", "user"]).default("user") })).default([]),
    includeUserRoot: z.boolean().default(true)
});
```
— `<PKG>\dsh-agent-presets\lib\index.js:808-815`

```js
this.resolvedRoots = config.includeUserRoot ? [...config.roots, { path: dshHomePath(USER_PRESET_DIR), trust: "user" }] : [...config.roots];
```
— `<PKG>\dsh-agent-presets\lib\index.js:851-854`

- `default` is **required** (fails loud if missing at mount time) — `<PKG>\dsh-agent-presets\lib\types\preset.d.ts:47-51`.
- `roots[].trust` defaults to `"user"`; `path` supports a leading `~` — `<PKG>\dsh-agent-presets\lib\types\preset.d.ts:39-45`, `<PKG>\dsh-agent-presets\README.md:86-90`.
- `includeUserRoot: true` (default) appends `<dshHome>/.agent-presets` as a `user` root **after** every configured root, so an earlier root wins a duplicate id — `<PKG>\dsh-agent-presets\README.md:96,100`.
- `default` has a **user settings layer**: with a settings provider composed, the plugin registers namespace `agent-presets` with `config.default` as its base, so `settings.yaml`'s `agent-presets.default` overrides the deployment default and is read per resolution — `<PKG>\dsh-agent-presets\lib\index.js:796, 855-857, 881`, README `:104-113`.
- The launcher **forces the shipped root** on every boot when the row exists — it overlays `roots: [{ path: <DSH>\config\agent-presets\, trust: "system" }]` (replacing any roots other layers declared, keeping other keys like `default`) — `<DSH>\lib\profile-boot-DG5t9aNs.js:86, 179-188`. (This is exactly the `agent-presets` row whose config I observed being replaced by a home patch in Q1.3 — the launcher overlay is applied after it and would win.)

### Q4.3 How a preset mounts its own cordis rows (`agent.cordis.yml`)

```js
class PresetTree extends Include {
    constructor(ctx, config) { super(ctx, config); mounted.set(config, { tree: this, fiber: ctx.fiber }); }
    import(name, getOuterStack) { … }
    write() { }                       // a preset is an input, never a persistence target
}
```
— `<PKG>\dsh-agent-presets\lib\types\mount.js:40-96`

```js
export async function mountPreset(agentCtx, preset) {
    if (scopeOf(agentCtx) === void 0) throw new Error(`agent-presets: refusing to mount preset "${preset.id}" into an unscoped context; its registrations would apply to every agent in the process`);
    const config = { path: pathToFileURL(preset.path).href };
    if (agentCtx.baseUrl !== undefined) harnessBase.set(config, agentCtx.baseUrl);
    pruneDisposedMounts();
    const handle = agentCtx.plugin(PresetTree, config);
    try {
        await handle.await();
        const subtree = mounted.get(config);
        const { tree, fiber } = subtree;
        const unusable = inactiveRows(tree);
        if (unusable.length > 0) throw new Error(`${String(unusable.length)} row(s) did not activate:…`);
        const leaked = leakedServices(agentCtx, fiber);
        if (leaked.length > 0) throw new Error(`row(s) published process-global service(s) [${leaked.join(', ')}]; a preset service must sit behind an \`isolate\` realm or move to the host composition`);
        mounts.add({ presetId: preset.id, fiber, key: scopeOf(agentCtx) });
    } catch (error) { … throw new PresetMountError(preset.id, `${mountDetail(error)} (${preset.path})`, { cause: error }); }
}
```
— `<PKG>\dsh-agent-presets\lib\types\mount.js:299-348` (bundle copy `<PKG>\dsh-agent-presets\lib\index.js:707-729`)

- So `agent.cordis.yml` **is an include file**: the preset's rows are a normal loader entry list (`- id / name / config`, groups, `!!js`), mounted as one subtree, exactly like the profile root — `<PKG>\dsh-agent-presets\lib\types\preset.d.ts:23` (`path` = "Absolute path of the preset's agent composition file").
- Bare package names in preset rows resolve from the **host composition's** base, not the preset directory, because a locally authored preset lives under the user's home where Node's upward walk never reaches the harness; relative specifiers still resolve from the preset's own directory and absolute paths become `file:` URLs — `<PKG>\dsh-agent-presets\lib\types\mount.js:29-35, 46-77`; README `:63-69`.
- The mounted tree's `write()` is a **no-op** so the loader's tree write-back can never rewrite a preset file — `<PKG>\dsh-agent-presets\lib\types\mount.js:78-95`; README `:127-131`.
- A preset's directory may also carry skills/assets, and `copy()` copies the whole directory — `<PKG>\dsh-agent-presets\lib\types\authoring.d.ts` (exported at `<PKG>\dsh-agent-presets\lib\types\index.d.ts:39`); shipped example: `<DSH>\config\agent-presets\cordis\skills\…`.

### Q4.4 How `isolate` works

`isolate` is a **loader entry option**, not a preset-specific concept: it remaps service implementation symbols per entry, either entry-locally (`true` → `LocalRealm`, suffix `#<entry id>`) or shared by label (`"<label>"` → `GlobalRealm`, suffix `@<label>`):

```ts
export interface EntryOptions { intercept?: Dict | null; isolate?: Dict<true | string> | null }
…
const label = entry.options.isolate?.[name]
if (!label) return
if (label === true) { realm = entry.realm ??= new LocalRealm(entry) }
else if (create) { realm = realms[label] ??= new GlobalRealm(label) }
else { realm = realms[label] }
return realm?.access(name, create)
```
— `<PKG>\cordis-plugin-loader\src\config\isolate.ts:5-9, 77-89`; realms `:26-68`; the hook installs a new isolate map before the entry's fiber is (re)loaded and migrates the old implementation — `:96-153`; labeled realms are garbage-collected when the last referencing entry goes away — `:155-172`.

Why presets need it: a preset that owns a service (e.g. a PTY registry) must not publish it into the ROOT realm, or the second preset publishing the same name collides and a host reader would resolve one preset's instance for every session:

- Guard: `mountPreset` rejects leaked root-realm services (quoted above) — `<PKG>\dsh-agent-presets\lib\types\mount.js:150-180, 328-332`; the package invariant re-checks on every service notification — `<PKG>\dsh-agent-presets\README.md:123-125`.
- Real shipped usage (groups carrying realms in preset compositions):

```text
\config\agent-presets\minimal\agent.cordis.yml:24:  isolate:
\config\agent-presets\minimal\agent.cordis.yml:78:  isolate:
\config\agent-presets\standard\agent.cordis.yml:107:  isolate:
\config\agent-presets\standard\agent.cordis.yml:140:  isolate:
\config\agent-presets\standard\agent.cordis.yml:177:  isolate:
\config\agent-presets\code\agent.cordis.yml:114:  isolate:
\config\agent-presets\code\agent.cordis.yml:147:  isolate:
\config\agent-presets\code\agent.cordis.yml:178:  isolate:
\config\agent-presets\cordis\agent.cordis.yml:95:  isolate:
\config\agent-presets\cordis\agent.cordis.yml:128:  isolate:
\config\agent-presets\cordis\agent.cordis.yml:165:  isolate:
```

e.g. `<DSH>\config\agent-presets\minimal\agent.cordis.yml:21-28` (`- id: persistent-shell / name: cordis:group / group: true / isolate: { terminals: true }`) and `:74-79` (`isolate: { fs: true }`), with the comment "The PTY registry is an agent-owned service, so it lives in an entry-local realm."

### Q4.5 Can a preset restrict which tools an agent sees — and are its own tool rows agent-scoped?

**Restricting tool visibility: yes, two ways.**

1. **Implicitly, by which rows it mounts.** In a preset-based deployment the global tool layer is empty — "Every model-facing row lives on the agent plane, so the tool registry's global layer is empty" — `<PKG>\dsh-agent-presets\README.md:35`; a preset's visible tool set is exactly the tool rows in its `agent.cordis.yml`. The `minimal` preset is the shipped demonstration: it mounts only a PTY/shell stack and `@deepseek-ai/dsh-tool-str-replace-editor` — `<DSH>\config\agent-presets\minimal\agent.cordis.yml:1-7, 21-88`.
2. **Explicitly, with `ctx.tools.restrict({ allow, deny })`**, which "applies an agent-scoped allow/deny mask to global tools and throws from a plain context… multiple masks intersect and scope-local tools merge afterwards… This is live visibility composition, not an authority boundary" — `<PKG>\dsh-tools\README.md:22`; API `<PKG>\dsh-tools\lib\types\index.d.ts:604-611`; impl `<PKG>\dsh-tools\lib\index.js:2780-2793`; masking applied in `view()` via `layers.every((layer) => layer.admits(name))` — `<PKG>\dsh-tools\lib\index.js:2843-2868`. Real in-tree caller: the subagent runtime restricts a child's tools from its composition's `toolFilter` — `<PKG>\dsh-subagent\lib\types\child-agent.js:134`, `<PKG>\dsh-subagent\lib\index.js:582`, documented at `<PKG>\dsh-subagent\lib\types\types.d.ts:127`.
   - **Unverified**: no shipped preset under `<DSH>\config\agent-presets\*` calls `restrict` (grep for `restrict` in those files: no hits), and I did not run a preset that calls it. Whether a row *inside a preset* can legally call `ctx.tools.restrict` depends on its context carrying a scope key; the mount's rows derive from the preset's standing scope (`createScope` writes `[kScope]: key` and descendants inherit it — `<PKG>\dsh-scope\lib\index.js:296-299`, `:312-314`), so it should be scoped — but I did not execute that path.
   - `ctx.tools.presentAs(mode)` additionally changes *presentation* (native/code/both) per scope, one declaration per scope — `<PKG>\dsh-tools\lib\types\index.d.ts:563-574`.

**Are the preset's own tool rows scoped to that agent only? No — they are scoped to the preset's standing scope, shared by every agent joined to that preset.** Evidence:

```js
async ensureStanding(preset) {
    …
    const created = (async () => {
        const key = { agentPreset: preset.id };
        const scope = createScope(this.selfCtx, key);
        try { … await mountPreset(scope.ctx, preset); return { key, scope, stamp }; }
        catch (error) { this.standing.delete(preset.id); await scope.dispose(); throw error; }
    })();
    this.standing.set(preset.id, created);
    return created;
}
```
— `<PKG>\dsh-agent-presets\lib\index.js:1129-1158`

```js
mount(agentCtx, id) { … const standing = await this.ensureStanding(preset); this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key)); … }
composeFrom(agentCtx, parentCtx) { … const standing = standingMountFor(parentCtx); if (standing === undefined) return undefined; this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key)); return standing.presetId; }
```
— `<PKG>\dsh-agent-presets\lib\index.js:942-960, 963-994` (docs at `<PKG>\dsh-agent-presets\lib\types\index.d.ts:146-186`)

- Registrations made by preset rows file into the **preset's** layer because `ctx.tools.register` routes through `this.layers.effect(this.ctx, …)`, which keys the layer by `scopeOf(ctx)` — `<PKG>\dsh-tools\lib\index.js:2762-2770`, `<PKG>\dsh-scope\lib\index.js:189-203`.
- Each agent's scope key is parented to that standing key, so the agent's view resolves `agent → preset → global` — README `<PKG>\dsh-agent-presets\README.md:5,7`; a child agent joins the **same** generation by binding (not by re-mounting) — `<PKG>\dsh-agent-presets\lib\types\index.d.ts:160-186`.
- The distinction from "agent-only" is explicit in the tool registry's own docs: a registration made through `agent.ctx` (the agent's own layer) shadows globals for that agent, whereas a preset contributes an ANCESTOR layer — `<PKG>\dsh-tools\lib\types\index.d.ts:625-647` ("reading the exempt set as 'the global layer' instead of 'not mine' held only while every model-facing tool sat in the host composition. Once presets moved them onto the agent plane they became an ANCESTOR contribution…").

Consequences worth stating plainly: two agents on the same preset share one plugin instance of every preset row (state is keyed per session inside those plugins — `<PKG>\dsh-agent-presets\lib\types\index.d.ts:1-15`); a preset's tool set is **not** narrowed per agent unless something in the agent's own scope (`agent.ctx`, e.g. the subagent `toolFilter`) restricts the inherited surface; and `recompose()` may only re-link an agent that has produced nothing — `<PKG>\dsh-agent-presets\lib\types\index.d.ts:253-274`, README `:47-51, 148`.

---

## Explicitly unverified / limits of this investigation

1. `require`, `fileURLToPath`, `module`, `__dirname` reachability inside `!!js` was probed with the loader's exact `evaluate` construct in a fresh Node ESM process, not inside the live dsh process. If anything set `globalThis.require` in that process, the answer would change (I found no such assignment).
2. `baseUrl` inside an actual `!!js` expression was derived from the code path (boot → Include → tree ctx → entry ctx prototype chain) and cross-checked against the observed `agent.cordis.yml`/patch behaviour; I did not boot a tree with a `!!js baseUrl` probe row.
3. Dynamic `import()` inside a `!!js` expression works syntactically, but I did not determine its resolution base (and the loader sanctions no such use).
4. `ctx.tools.restrict()` called from inside a preset row was not executed; the conclusion that its context is scoped follows from `createScope` + `scopeOf`.
5. The literal string "plugin marketplace bridge failed" is not present in any file I could inspect (dsh install, `$DSH_HOME`, workspace). Its ownership by the third-party `@oh-dsh/plugin-marketplace` is based on the captured `_boot.html` boot graph plus the prior session's analysis doc, not on that plugin's source (which is not installed here).
6. Parenthesized code quotes are verbatim copies of the shipped bundles with only whitespace preserved as printed; a few very long lines in the dsh-app-boot/`dsh-tools` sources are reproduced verbatim from the file content.
