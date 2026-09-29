# DSH 插件：机制、融合与发布记录

> 适用版本：dsh `0.1.1-rc.2`，插件 `dsh-opensecurity 0.1.0`，仓库 `GQS220509/dsh-opensecurity`
> 证据标注：**【代码】**= 逐行读过实现（给文件:行号）；**【代码·交叉核查】**= 来自并行子代理的报告，我复核过关键引用但未逐行通读；**【文档】**= 包内 README/注释的设计说明；**【实测】**= 本机真实跑出来的结果；**【推断】**= 我的判断，未证实。

---

## 1. 一页速览

DSH 的"插件"就是 cordis 插件。调用分两层：

- **装配期**：profile 的 `package.json` 声明 bundles → 各层 `cordis.patch.yml` 叠加成配置行 → loader 按行 `import(name)` → `ctx.registry.plugin(plugin, config)` 建 **Fiber** → 等 `inject` 的服务全部就位后校验 config、执行插件体（`apply(ctx, config)`）。
- **运行期**：插件把自己的能力**注册到上下文的某个扩展点**上（服务、工具、提示词段、事件监听器）；之后由宿主或 agent 循环在正确时机触发。事件总线有五种分发模式，其中 `waterfall` 决定策略插件的"包装/否决"语义。

一句话：**插件只在装配期被"调用"一次（apply），之后一直在运行期被"触发"（hook）。**

---

## 2. 装配期：一行配置怎么变成活插件

### 2.1 行的形状 【代码】`cordis-plugin-loader/src/config/entry.ts:9-22`

```ts
export interface EntryOptions {
  id: string          // 树内稳定标识
  name: string        // 要 import 的模块名
  config?: any        // 传给插件的配置
  group?: boolean | null
  disabled?: boolean | null   // 支持 !!js 表达式
  inject?: Inject | null
}
```

### 2.2 每行拿到自己的子上下文：靠原型链继承 【代码】`entry.ts:67,116`

```ts
this.ctx = loader.ctx.extend({ [Entry.key]: this })   // 建子上下文
Object.setPrototypeOf(this.ctx, this.parent.ctx)      // 父上下文挂到原型上
```

服务查找沿原型链向上走 —— 这也是 `agent.ctx` 能"遮蔽同名全局工具/提示段"的底层原因（就近层赢）。

### 2.3 真正的"调用"只有这一句 【代码】`entry.ts:291-297`

```ts
private async _start(plugin: any) {
  await this._patchContext([])
  this.loader.showLog(this, 'apply')
  fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
  await fiber.await()
}
```

`registry.plugin()` 做三件事 【代码】`cordis/src/registry.ts:316-336`：解析插件形态 → 建/复用 runtime 记录 → `new Fiber(ctx, config, Inject.resolve(plugin.inject), runtime, ...)`，返回 thenable。**`await` 它 = 等插件加载完成**（配置错/启动错会 reject）。

### 2.4 三种合法插件形态与可声明的元数据 【代码】`registry.ts:92-133, 100-111`

| 形态 | 签名 | 本仓库实例 |
|---|---|---|
| 函数插件 | `(ctx, config) => any` | `lib/diagram.js`、`dsh-spill-policy` |
| 类插件 | `new (ctx, config)` | 服务型插件（`extends Service`） |
| 对象插件 | `{ apply(ctx, config) }` | `lib/index.js` |

元数据：`name`（诊断名）、`Config`（Standard Schema 校验器）、`inject`（依赖的服务）、`provide`（我提供什么服务）、`intercept`。

loader 用 `unwrapExports` 解包 ESM 命名导出，所以 `export { apply, inject, name, Config }` 的模块即合法插件。

### 2.5 `inject` ＝ 服务可用性驱动激活，不是启动顺序 【代码】`registry.ts:169-176` + `events.ts:335-339`

```ts
ctx.inject(deps, callback)   // 等价于 ctx.plugin({ inject, apply: callback })
// 「the callback is unloaded and re-run whenever a required service changes」
```

内置事件 `internal/config` 的注释写着：*"Resolve raw plugin config **after the fiber's injections become active**"* —— **先等依赖服务就位，再校验配置、再跑插件体**。这就是 `dsh-base` 里那句 *"Row order carries no load semantics (activation is service-availability driven)"* 的实现依据 【代码】`dsh-base/cordis.patch.yml:12`。

**对本仓库的直接影响**：`lib/diagram.js` 声明 `inject = ['systemPrompt','webServer']`，所以在没有 `webServer` 的 profile（headless / binary）里这一行**自动不激活**，而二进制工具面照常工作 —— 这是设计，不是缺陷。

### 2.6 `disabled` 是运行时求值的表达式 【代码】`entry.ts:100-108`

```ts
return isJsExpr(options.disabled)
  ? Boolean(this.evaluate(options.disabled.__jsExpr))
  : Boolean(options.disabled)
```

所以同一份 patch 能在不同平台激活不同插件（本机实例：`tool-pwsh` 与 `tool-bash` 靠 `!!js process.platform === 'win32'` 互斥）。

### 2.7 配置热更新是事务性的 【代码】`entry.ts:142-246`

- 只有 `config` 变 → `fiber.update(config)`，**不重启插件**；
- `name` / `inject` / `group` 变 → 完整重启（dispose → 重新 import → 重新 start）；
- **任何一步失败都回滚**（连着旧插件一起拉回，否则抛 `AggregateError`）。

启动时 `profile-boot` 还挂了 HMR 与 `watchUserPatches` 【代码】`lib/profile-boot-DG5t9aNs.js:256-273`，所以 **改 `cordis.patch.yml` 不用重启**；改插件**代码**需要 HMR 或重启。

---

## 3. 运行期：hook 是怎么被调用的

### 3.1 五种分发模式 【代码】`cordis/src/events.ts:24-32`

| 模式 | 语义 | 典型用途 |
|---|---|---|
| `emit` | 同步跑完，不等 Promise | `session/event`、`agent/status` 通知 |
| `parallel` | `Promise.allSettled`，错误聚合成 `AggregateError` | 多条独立通知 |
| `serial` | 顺序 await，遇 bail 值停 | |
| `bail` | 同步顺序，遇 bail 值停 | `internal/listener` 拦截注册 |
| **`waterfall`** | **每个监听器包住后面整条链** | `agent/pre-step`、`tools/*`、`llm/stream` |

### 3.2 waterfall 的"包装 / 否决"只有 8 行 【代码】`events.ts:234-243`

```ts
waterfall(...args: any[]) {
  const cbs = this.dispatch('waterfall', args)
  const inner = args.pop()          // 最后一个参数是最内层 next
  const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }
  args.push(next)
  return next()
}
```

监听器**外层先跑**，调 `next()` 才轮到里面；**不调 `next()` 就等于否决**，连内置行为一起否决。于是：
- `agent/pre-step` 返回 `{kind:'reject'}`、`tools/pre-execute` 返回 `{kind:'deny'}` 都是"不往下走"；
- `dsh-spill-policy` 用 `{ prepend: true }` 把自己放最外层，先 `await next()` 让下游跑完，**再**对最终结果做字节封顶 【代码】`dsh-spill-policy/lib/index.js:136-153`。

### 3.3 监听器是 fiber 的"效果"，随插件卸载自动撤销 【代码】`events.ts:254-260, 288-302`

注册时先 `ctx.fiber.assertActive()`（已 dispose 的 fiber 不许再注册），然后以 `fiber.effect(...)` 登记。**所以插件不需要手写清理逻辑**：配置更新、插件卸载、进程退出时，它注册的服务/监听器/工具/定时器一起消失。

### 3.4 作用域过滤：每个 hook 记录里带着自己的 `ctx` 【代码】`events.ts:120-123, 165-175`

派发时按 `Context.filter` 过滤 → agent 作用域注册的 hook 只对该 agent 生效。

### 3.5 本机可查的四个真实策略插件

| 插件 | 挂点 | 作用 |
|---|---|---|
| `dsh-spill-policy` | `tools/post-execute`（prepend） | 超 `maxInlineBytes`（本机 50 000 B【代码】`cordis.patch.yml:352`）的纯文本结果落盘，模型只看到首尾预览 + 路径 |
| `dsh-tool-call-timeout-policy` | `tools/execute`（环绕） | 只对声明了 `timeoutMs` 的工具设协作式截止时间，超时替换成 `TOOL_TIMEOUT` |
| `dsh-session-checkpoint-policy` | `llm/stream`、`tools/execute`、`agent/pre-step` | **先落盘再请求首块**；嵌套 dispatch 复用外层那次 flush 【代码】`:26-31, 53, 66-75` |
| `dsh-opensecurity`（本仓库） | `agent/pre-step` + `ctx.tools.register` | 首步门禁提醒 + 7 个 `os_*` 工具 |

---

## 4. 工具插件与客户端插件

### 4.1 工具插件：从注册到被模型调用

1. 插件 `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`；
2. schema 经 `ctx.systemPrompt.tools()` 自动进入系统提示词组装；
3. 模型发起调用后走流水线：`tools/pre-execute`（门禁）→ guards → `tools/execute`（超时/重试环绕）→ `tools/post-execute` → `finalizeContent` → `tools/result` 【文档】`dsh-tools/README.zh.md:5`；
4. 并发由工具自己的 `isConcurrencySafe(args)` 分类，**只有严格 `=== true` 才并行**，否则独占 【代码·交叉核查】`dsh-tools/lib/index.js:2940-2947`；agent 循环把连续 `parallel` 调用归入有界滚动池，上限 `maxParallelToolCalls` 默认 **10** 【文档】`dsh-agent-loop/README.zh.md:40,52,72`。

### 4.2 客户端插件（浏览器半边）的三条硬约束

宿主侧机制 【代码】`dsh-client-modules/lib/index.js:67-87`：**扫描 loader 的行**，读该包的 `dsh.client`，组合 `./client` 导出，按 `/plugins/<id>/client.js` 下发，并把 boot manifest 注入首页。

| 约束 | 依据 |
|---|---|
| `package.json` 要有 `dsh.client: { platform: "web", inject: [...] }` | 【代码】`:119-134, 390`（`platform !== 'web'` 直接忽略） |
| `exports["./client"]` 必须存在且指向**已构建**产物 | 【代码】`:135-146, 395`（缺失即抛 `client bundle not found; run pnpm run build`） |
| bundle 内部注册的 `id` **必须等于包名** | 【代码】浏览器侧 `dsh-client-modules/lib/client.js:202` 会校验 `factories.has(id)`，否则抛 `bundle <url> loaded without registering "<id>"` |

客户端 bundle 的格式是 dsh 私有的模块加载器，不是普通 ESM：

```js
window.__ModuleLoader__.load({
  id: "dsh-opensecurity",
  factory: (require) => { let react = require("react"); /* … */ }
})
```

**本轮实测的宿主分配行**（证明 id 契约）：

```json
{"id":"dsh-opensecurity","url":"/plugins/dsh-opensecurity/client.js?rev=0b24169e9e06",
 "rev":"0b24169e9e06","inject":["@deepseek-ai/dsh-client-runtime"]}
```

`rev` 是 bundle 内容的 sha1 前 12 位，用于缓存击穿。

### 4.3 为什么"工具目录跨模式保持不变"

plan-mode 的说明里写着：*"The tool catalog stays the same across modes for **request-cache stability**"* —— 为了让服务端前缀/KV cache 持续命中，宁可让 plan 模式也带着用不到的工具 schema 【代码】`dsh-base/cordis.patch.yml:273`。同理，fork 子代理刻意不追加段与工具，*"keeping the parent's request prefix"* 【代码】`:320-329`。

---

## 5. 本次融合：`dsh-opensecurity` 双面包

把「自己的 OpenSecurity 二进制分析插件」与「可视化（mermaid 渲染）插件」合成**一个可发布包**：host 能力与 client 能力同包，用户一条命令装齐。

### 5.1 包结构

| 路径 | 角色 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client` 双面声明；`exports["."]` / `["./diagram"]` / `["./client"]` |
| `cordis.patch.yml` | 闭卷块 + `opensecurity` 行 + `opensecurity-diagram` 行 |
| `lib/index.js` `preflight.js` `runner.js` `closed-book.js` | host 半边：7 个 `os_*` 工具、首步门禁、预检、闭卷收敛 |
| `lib/diagram.js` | host 半边：画图规范提示词段 + `/dsh-opensecurity/mermaid.min.js` 本地路由 |
| `lib/client.js` | client 半边：预构建 bundle（id 已重写为包名） |
| `assets/binary-analysis/` + `assets/skills/` | 知识库与生成的 skill（`lib` 用 `import.meta.url` 定位自己的 `assets/`） |
| `agent-presets/binary-analysis/` | 「二进制分析」preset 组装文件 |
| `overlays/*.yml` | 可选覆盖层：开网 / 启用 preset |
| `scripts/check.mjs` | 装配契约自检（18 项） |

### 5.2 patch 的三层职责

1. **闭卷（默认开启）**：`tool-web` 关 search/fetch，`web`、`web-search-deepseek` 置 `disabled: true`；三处说明怎么关（删段 / 叠 `overlays/enable-network.yml` / 改自己的 profile 层）。
2. **工具面**：`insert` 一行 `opensecurity`（`name: 'dsh-opensecurity'`）带上全部 config。
3. **客户端配套**：`opensecurity-diagram` 行（`name: 'dsh-opensecurity/diagram'`）—— 同一个包用**子路径**挂第二个 host 半边，loader 的 `unwrapExports` 认这种模块。

### 5.3 合并时必须做对的三件事

| 事项 | 原因 |
|---|---|
| 重写 client bundle 里的 `id` 为 `dsh-opensecurity` | 否则浏览器侧抛 `loaded without registering` |
| 统一 mermaid 路由字符串 | `lib/diagram.js` 的 `MERMAID_SCRIPT_ROUTE` 与 `lib/client.js` 的 `MERMAID_SRC` 必须一致，改一处忘一处即静默不出图 |
| **harness 包写成可选 peer** | 见下节坑 1 |

### 5.4 preset 为什么只能手动启用

`dsh-agent-presets` 的 roster **只按目录扫描**，roots 只接受文件系统路径（`~` 会展开），且**没有运行期注册 API** —— 而随包目录的真实路径里含 profile 名，插件在组合期不知道自己被装到哪个 profile 下。因此 `overlays/with-agent-preset.yml` 留了一行给使用者填 `<你的 profile>`。

---

## 6. 验证证据（全部本机实测）

| 项 | 结果 |
|---|---|
| 解码无关 | 本次只涉及插件发布，未触碰题目资产 |
| `file:` 安装 | `pnpm install` → `+ dsh-opensecurity 0.1.0` |
| **`github:` 安装** | `dsh plugin --profile ostest add github:GQS220509/dsh-opensecurity` → `+ dsh-opensecurity 0.1.0`，8.3s，**无需任何 `allowBuilds` 配置** |
| 启动 | `dsh --profile ostest --port 3097` → `dsh web: http://127.0.0.1:3097`，日志无 error |
| 客户端发现 | 首页 manifest 出现 `{"id":"dsh-opensecurity",...}` |
| `client.js` 下发 | HTTP **200**，33 475 B，首行 `window.__ModuleLoader__.load({` |
| mermaid 路由 | HTTP **200**，3 572 661 B（从**已安装副本自己**的依赖树取 mermaid） |
| 合成树 | `--dump-config` 含两行挂载 + 闭卷三行（`tool-web` search/fetch=false、`web`/`web-search-deepseek` disabled） |
| 自检 | `node --experimental-vm-modules scripts/check.mjs` → 18 项全过 |
| 推送一致性 | 远端 `refs/heads/main` = 本地 HEAD = `94b92ea…` |

测试环境刻意隔离：`DSH_HOME=D:\实习\.dsh-home-test`，**没有碰正在运行的 3080 服务**。

---

## 7. 坑清单（现象 → 根因 → 修法）

1. **`dsh plugin add` 在依赖解析阶段就失败**（`ERR_PNPM_NO_MATCHING_VERSION ... @deepseek-ai/dsh-agent`）
   根因：harness 包的 npm `latest` tag 是**占位版**（`@deepseek-ai/dsh-tools` 的 latest 是 `0.0.1-rc.1`，真线在 `next`/`alpha`），peer 写死 `^0.1.1-rc.2` 时 pnpm 自动装 peer 就解析不到。
   修法：harness 包一律写 **可选 peer**（`peerDependenciesMeta.*.optional = true`），只把真正需要独立安装的（`mermaid`）放 `dependencies`。

2. **客户端不生效、浏览器控制台报 `loaded without registering`**
   根因：bundle 内 `id` 与宿主分配的行 id 不一致（重命名包之后必然发生）。
   修法：让 bundle 的 `id` 恒等于 `package.json` 的 `name`；`scripts/check.mjs` 会断言这一条。

3. **`Copy-Item` 造出硬链接，git 无法索引且两边共享 inode**（`Function not implemented`）
   根因：同卷复制保留硬链接；新包与旧插件共享文件。
   修法：逐文件"复制→删原→改名"断链（`st.nlink > 1` 即处理）。

4. **Windows Defender 误报隔离**
   现象：`assets/binary-analysis/knowledge-base/crypto-validation-patterns.md` 及其生成的 `SKILL.md` 写入后数秒被隔离删除，git 看到 `ENOSYS`/ENOENT 交替，`git add` 连带整体失败。
   修法：给仓库目录加 Defender 排除项后再拷回；`README.md` 的「已知限制」已记录此事（仍是当前仓库的唯一缺口）。

5. **`github:` 安装报 `Could not connect to server` / `ETIMEDOUT`**
   根因：本机**只**掐断了 `github.com:443`（`api.github.com`、`raw.githubusercontent.com`、`registry.npmjs.org` 都通），而 pnpm 解析 `github:` spec 是用 HTTPS `git ls-remote`。
   修法：`git config --global http.https://github.com.proxy http://127.0.0.1:7890`（只对 github.com 生效；本机 7890 有可用代理）。

6. **`ERR_PNPM_UNEXPECTED_STORE`**
   根因：同一 profile 的 `node_modules` 是别的工作目录下用 pnpm 装的，store 路径不一致。
   修法：在该 profile 目录跑一次 `pnpm install`，或删掉 `node_modules` 重装。

7. **用 PowerShell `Get-Content/Set-Content` 改 UTF-8 文件导致中文注释变乱码、字符串字面量损坏**
   根因：中文 Windows 上 PS 5.1 的默认编码往返。
   修法：一律用 Node（显式 `utf8`）或编辑工具改文本；**不要**用 PS 做含非 ASCII 的文件往返。

---

## 8. 运维手册

```powershell
# 安装（先移除会重名的旧插件）
dsh plugin --profile web remove dsh-opensecurity-binary
dsh plugin --profile web add github:GQS220509/dsh-opensecurity
# 然后重启 dsh（插件集合与客户端判定都在启动时装配）

# 本地开发安装（改完代码即生效，免走网络）
dsh plugin --profile web add file:D:\实习\dsh-opensecurity

# 关闭闭卷的三种方式
#   A 删掉 cordis.patch.yml 里 BEGIN-OFFLINE…END-OFFLINE 段
#   B dsh --profile web --patch <插件目录>\overlays\enable-network.yml
#   C 在自己 profile 的 cordis.patch.yml 重述那三行并写 disabled: false

# 启用「二进制分析」preset（先把 <你的 profile> 改掉）
dsh --profile <你的 profile> --patch <插件目录>\overlays\with-agent-preset.yml

# 自检 / 检查合成树
node --experimental-vm-modules scripts\check.mjs
dsh --profile web --dump-config
```

**改代码的规矩**

- 改 host 半边：`lib/*.js` 是纯 ESM，**无需构建**，重启 dsh 即可。
- 改 diagram host 半边：改 `src/diagram/index.ts` 后需要回填 `lib/diagram.js`；改渲染逻辑要改 `src/diagram/client/*`，用 dsh 的客户端打包链重建 `lib/client.js`，**并保持 id 等于包名**。本仓库不含那套打包链。
- 改 patch：profile 层与 home 层有 watcher，改完不用重启（插件集合变化仍需重启）。
- 发版：改 `package.json` 的 `version` → `git tag v0.1.1 && git push --tags`（用 `github:` 安装的人需显式升级或改 ref）。

---

## 9. 已知限制与待办

- **客户端半边是预构建产物**：仓库带源码（`src/diagram/`）但不在本仓库重建。
- **`assets/` 里缺 1 篇知识库文章 + 其 skill**（Defender 误报，见坑 4）；插件仍可正常启动，只是知识库少一篇、skill 少一个。
- **preset 需手动启用**（见 5.4）。
- **非 Web profile 无图渲染**（`webServer` 缺失时该行自动不激活）。
- **IDA 路径靠探测**，装在别处请在 config 里给 `idatPath`。
- **`github:` 安装依赖本机到 github.com 的连通性**；受限网络需代理（见坑 5），或改用 npm 发布后用 `dsh plugin add dsh-opensecurity`。

---

## 10. 沿革（这条线之前的工作）

| 文档 / 产物 | 位置 | 内容 |
|---|---|---|
| 插件改动点·审核稿 | `D:\实习\插件改动点-审核稿.md` | A/B/C 三类改动点（补验收证据 / 新改动 / 非插件事项） |
| 插件改进汇报 | `D:\实习\插件改进汇报.md` | 改进项与验证情况 |
| 插件改动实施记录 | `D:\实习\dsh-session-export\插件改动-实施记录-20260927.md` | 64 位 IDA 通道、preflight 四缺口、识图 A 方案的三层证据 |
| 源码级机制笔记 | `docs/dsh-plugin-mechanics-source-verified.md` | 本仓库内保留的插件机制调研 |
| 旧插件本体 | `D:\实习\dsh-opensecurity-binary\` | 融合前的 host-only 版本（含 dev 脚本 `tools/`，不随包发布） |
| 本次融合包 | 本仓库 | 双面包 + 自检脚本 + 覆盖层 |

机制部分的代码引用路径约定：`cordis/` 与 `cordis-plugin-loader/` 为框架本体（带 TypeScript 源码），`dsh-*/` 为已构建的 DSH 包，均位于 dsh 安装目录的 `node_modules/@deepseek-ai/` 下。
