/**
 * dsh-diagram 宿主入口（Host half）。
 *
 * 宿主侧做两件事：
 *  1. 向每个 agent 的系统提示词注册「画图规范」公告：审查代码 / 分析架构 /
 *     解释数据流、调用链、请求时序时，主动用 ```mermaid 代码块画示意图
 *     （flowchart / sequenceDiagram），浏览器端由 client 半边原位渲染。
 *  2. 注册 /dsh-diagram/mermaid.min.js 路由，从本插件依赖树内的 mermaid
 *     发行包（dist IIFE 全量包）按需分发渲染脚本——client 半边首次遇到
 *     mermaid 代码块时以 <script> 方式加载，本地闭环、不走 CDN。
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** mermaid 渲染脚本路由（同源相对路径，client 用 <script src> 加载）。 */
export const MERMAID_SCRIPT_ROUTE = '/dsh-diagram/mermaid.min.js'

/** 公告段落在工具指引区内的排序（205，排在 speech-input 的 210 之前）。 */
const SECTION_ORDER = 205

/** 插件配置。 */
export interface Config {
  /** 为 true（默认）时向每个 agent 的系统提示词注册画图规范。 */
  announceToAgent?: boolean
  /** 插件总开关（同时关掉公告与 mermaid 脚本路由）。 */
  enabled?: boolean
}

/**
 * 定位本插件依赖树内 mermaid 的 IIFE 全量发行包。
 * （链接安装场景下 lib/index.js 位于插件真实路径，node 解析会沿
 * realpath 走插件自己的 node_modules。）
 */
function mermaidDistPath(): string | null {
  try {
    const pkg = require.resolve('mermaid/package.json')
    return join(dirname(pkg), 'dist', 'mermaid.min.js')
  } catch {
    return null
  }
}

/** mermaid.min.js 的内存缓存（首次请求时读盘，之后直接回内存）。 */
let cachedScript: string | undefined

/** 仅接受回环同源请求（与 dsh-whale / dsh-speech-input 的守卫一致）。 */
function isTrustedLoopback(request: IncomingMessage): boolean {
  const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : ''
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')
}

/**
 * 挂载 mermaid 渲染脚本路由（webServer 就绪后注册，随上下文卸载）。
 */
function mountMermaidRoute(host: any): () => void {
  return host.webServer.register({
    kind: 'exact',
    path: MERMAID_SCRIPT_ROUTE,
    handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (!isTrustedLoopback(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      if (cachedScript === undefined) {
        const dist = mermaidDistPath()
        if (dist === null) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('mermaid package not installed for @dsh-local/dsh-diagram')
          return
        }
        try {
          cachedScript = await readFile(dist, 'utf8')
        } catch (error) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          response.end(`read mermaid.min.js failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
      response.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      response.end(request.method === 'HEAD' ? undefined : cachedScript)
    },
  })
}

export const inject = ['systemPrompt', 'webServer']

/** 面向模型的画图规范公告。 */
export const DIAGRAM_GUIDANCE = [
  '本机已安装 dsh-diagram 插件：你在回复中写的 ```mermaid 围栏代码块会被 Web 界面自动渲染成示意图，直接显示在对话里。当前支持：flowchart / graph（流程图）、sequenceDiagram（时序图）、classDiagram（类图）、stateDiagram（状态图）、erDiagram（实体关系图）、gantt（甘特图）、pie（饼图）；其他 mermaid 图型不会被渲染，只会以源码形式展示，请不要使用。',
  '适用场景：审查代码、梳理调用链、分析模块依赖与数据流、解释请求/消息时序、描述状态或分支逻辑时，在文字说明之外主动配一张简明示意图帮助理解；简单一句话能讲清的不要强行画图。',
  '可读性是硬要求（图会被缩放到消息宽度显示，过宽则文字看不清）：flowchart 默认 TB 自上而下单列延展，主链路纵向排布，不要 LR 横向铺开，不要多个 subgraph 并排占多列——确需分组时 subgraph 也要纵向堆叠；节点文字用简短中文短语（≤10 字），补充说明放下一行或直接写进正文；节点与消息总数控制在 15 个以内。',
  '语法必须正确可渲染（flowchart 用 A[节点] / A --> B / subgraph 名 … end；sequenceDiagram 用 participant A、A->>B: 消息、A-->>B: 返回；类图/状态图/实体图用标准语法）；语言标注必须是小写 mermaid；图中不要包含密钥、内网地址等敏感信息。',
  '一条消息里可有多个 mermaid 块，但按需使用；若用户明确只要文字，则不画图。',
].join('\n')

/**
 * 挂载插件：公告 + mermaid 脚本路由。
 * @param ctx - 插件上下文（loader 已注入 systemPrompt / webServer）。
 * @param config - 解析后的插件配置。
 */
export function apply(ctx: any, config?: Config): void {
  const enabled = (config?.enabled ?? true) !== false

  if (enabled) {
    ctx.inject(['webServer'], (host: any) => {
      host.effect(() => mountMermaidRoute(host), 'dsh-diagram: mermaid script route')
    })
  }

  if (enabled && (config?.announceToAgent ?? true) !== false) {
    ctx.systemPrompt.section({
      name: 'plugin:dsh-diagram',
      order: SECTION_ORDER,
      text: DIAGRAM_GUIDANCE,
    })
  }
}
