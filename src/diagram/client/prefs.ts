/**
 * 图表渲染偏好（浏览器侧，localStorage 持久化）。
 *
 * 目前只有「自动渲染聊天中的 mermaid 代码块」一个开关，默认开启。
 * 键与默认值保持独立于宿主设置面，保持浏览器侧自包含。
 */

/** localStorage 键。 */
export const AUTO_RENDER_KEY = 'dsh.diagram.autoRender.v1'

/** 读取自动渲染开关（损坏或缺失时回退开启）。 */
export function autoRenderEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_RENDER_KEY) !== 'false'
  } catch {
    return true
  }
}

/** 写入自动渲染开关。 */
export function setAutoRenderEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_RENDER_KEY, enabled ? 'true' : 'false')
  } catch {
    // 隐私模式等异常静默忽略
  }
}
