# dsh-diagram

DSH 图表插件：让 DSH 在审查代码、分析架构时直接在回复里写 mermaid 代码块，Web 界面将其**原位渲染成示意图**（流程图 / 时序图 / 类图 / 状态图 / ER 图 / 甘特图 / 饼图），辅助理解。

## 工作方式

- **Agent 侧**：宿主半边向每个 agent 的系统提示词注入「画图规范」——审查代码 / 梳理调用链 / 解释数据流与请求时序时，主动用 ` ```mermaid ` 代码块画图，并约束纵向单列布局保证可读性。
- **浏览器侧**：client 半边用 MutationObserver 扫描聊天里的 `.md-code-block` 代码块，块首行匹配 `flowchart` / `graph` / `sequenceDiagram` / `classDiagram` / `stateDiagram` / `erDiagram` / `gantt` / `pie` 的，在源码稳定 700ms 后渲染成 SVG 原位替换；工具条支持 **放大（拖拽平移、双击复位）⇄ 查看源码切换 / 复制源码 / 复制 PNG（2x，剪贴板失败退化为下载） / 下载 SVG**。
- **mermaid 运行时**：不打包进 client.js（体积 ~3.5MB），由宿主路由 `/dsh-diagram/mermaid.min.js` 从插件依赖树内按需分发，首次遇到 mermaid 块时 `<script>` 加载，本地闭环不走 CDN。
- 渲染失败不吞内容：保留源码并显示错误条，模型可自行修正语法；跟随界面明暗主题；flowchart 使用纯 SVG 文本标签（`htmlLabels:false`）保证 PNG 导出可靠。

## 安装

```powershell
dsh plugin --profile web add github:zhangTELL/dsh-diagram
# 重启 dsh web / DSH Desktop 后生效
```

从源码构建：

```powershell
git clone https://github.com/zhangTELL/dsh-diagram.git
cd dsh-diagram
pnpm install
pnpm build
dsh plugin --profile web add link:"$PWD"
```

## 结构

```
src/index.ts              宿主：systemPrompt 公告 + mermaid.min.js 路由
src/client/index.ts       浏览器：代码块扫描 / 渲染 / 工具条 / 主题 / 放大弹层
src/client/SettingsSection.tsx  应用设置「图表」分区（介绍 + 自动渲染开关）
src/client/prefs.ts       浏览器侧偏好（自动渲染开关，localStorage）
lib/                      tsdown 产物（index.js 宿主 / client.js 浏览器闭包）
```

应用「设置 → 图表」栏目提供插件介绍、支持的图型说明和「自动渲染聊天中的 mermaid 代码块」开关（关闭后新消息的 mermaid 块保持源码显示）。

其他 mermaid 图型（mindmap / timeline 等）当前不支持渲染，只显示源码；如需扩展，把图型关键字加进 `src/client/index.ts` 的 `SUBSET_RE` 并同步更新宿主公告。
