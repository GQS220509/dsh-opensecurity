/**
 * 「图表」应用设置分区（设置窗口左侧导航的 settings.section 席位）。
 *
 * 静态介绍 + 一个「自动渲染 mermaid 代码块」开关（localStorage
 * dsh.diagram.autoRender.v1，渲染器每次扫描时读取，切换后对后续消息生效）。
 *
 * 注册契约（0.1.2-rc.1，与 dsh-speech-input 的设置分区同形）：
 * `settings.section` 是 list 槽，第二参为 React 组件，宿主负责渲染；
 * label 提供导航标题。注意 list 槽组件由宿主按条目渲染，不要传入
 * vanilla {render} 对象（宿主不识别，页面会空白）。
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AUTO_RENDER_KEY, setAutoRenderEnabled } from './prefs.ts'

/**
 * 本插件对插槽合同的类型声明：宿主 GUI 在运行时声明了 `settings.section`
 * （list，导航分区），这里按 speech-input / dsh-plugin-desktop 的同形注册面
 * 声明，以便 register 做编译期校验。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      owner: unknown
    }
  }
}

const fieldTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
}

const hintStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-tertiary)',
  marginTop: 6,
}

const codeStyle: CSSProperties = {
  padding: '1px 5px',
  borderRadius: 5,
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-surface-raised)',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11.5,
}

const featureRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  fontSize: 13,
  lineHeight: 1.7,
  color: 'var(--dsw-alias-label-primary)',
}

const bulletStyle: CSSProperties = {
  flexShrink: 0,
  color: 'var(--dsw-alias-label-tertiary)',
}

/** mermaid 渲染器加载状态（首次渲染图表时才按需加载脚本）。 */
function mermaidStatusText(): string {
  const w = window as unknown as { mermaid?: unknown }
  return w.mermaid !== undefined
    ? 'mermaid 渲染器：已加载 ✓'
    : 'mermaid 渲染器：未加载（首次出现图表时自动从本地按需加载）'
}

/**
 * 「图表」设置分区页面：插件介绍 + 自动渲染开关 + 使用说明。
 */
export function DiagramSettingsSection(_props: Record<string, never>): ReactNode {
  const [autoRender, setAutoRender] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_RENDER_KEY) !== 'false'
    } catch {
      return true
    }
  })

  const applyAutoRender = (enabled: boolean): void => {
    setAutoRender(enabled)
    setAutoRenderEnabled(enabled)
    // 通知渲染器立刻重扫（开启后无需等下一次 DOM 变更）。
    const rescan = (window as unknown as Record<string, unknown>)['__dshDiagramRescan']
    if (typeof rescan === 'function') rescan()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, marginBottom: 6 }}>图表（dsh-diagram）</h2>
        <div style={hintStyle}>
          让 DSH 在审查代码、梳理调用链、分析架构与数据流、解释请求时序时，直接在回复里写 mermaid
          代码块，并由本插件在对话中原位渲染成 SVG 示意图（配色跟随界面明暗主题）。
        </div>
      </div>

      <div>
        <div style={fieldTitleStyle}>支持的图型</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={featureRowStyle}><span style={bulletStyle}>•</span><span><code style={codeStyle}>flowchart</code> / <code style={codeStyle}>graph</code>：流程图（模块依赖、数据流、分支逻辑）</span></div>
          <div style={featureRowStyle}><span style={bulletStyle}>•</span><span><code style={codeStyle}>sequenceDiagram</code>：时序图（请求 / 消息时序）</span></div>
          <div style={featureRowStyle}><span style={bulletStyle}>•</span><span><code style={codeStyle}>classDiagram</code> / <code style={codeStyle}>stateDiagram</code> / <code style={codeStyle}>erDiagram</code>：类图 / 状态图 / 实体关系图</span></div>
          <div style={featureRowStyle}><span style={bulletStyle}>•</span><span><code style={codeStyle}>gantt</code> / <code style={codeStyle}>pie</code>：甘特图 / 饼图</span></div>
          <div style={featureRowStyle}><span style={bulletStyle}>•</span><span>其他 mermaid 图型不会被渲染，仅显示源码</span></div>
        </div>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={autoRender}
            onChange={(event) => applyAutoRender(event.target.checked)}
          />
          自动渲染聊天中的 mermaid 代码块
        </label>
        <div style={hintStyle}>
          关闭后新消息里的 mermaid 块保持源码显示（已渲染的图不受影响）。图卡片右上角有
          「放大 / 查看源码 / 复制源码 / 复制 PNG / 下载 SVG」工具条；放大后可拖拽平移、双击复位；
          渲染失败时保留源码并显示错误原因。
        </div>
      </div>

      <div style={hintStyle}>
        {mermaidStatusText()}。渲染引擎随插件本地分发，不走外网 CDN。
      </div>
    </div>
  )
}
