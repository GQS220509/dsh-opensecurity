window.__ModuleLoader__.load({
	id: "dsh-opensecurity",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/prefs.ts
		/**
		* 图表渲染偏好（浏览器侧，localStorage 持久化）。
		*
		* 目前只有「自动渲染聊天中的 mermaid 代码块」一个开关，默认开启。
		* 键与默认值保持独立于宿主设置面，保持浏览器侧自包含。
		*/
		/** localStorage 键。 */
		const AUTO_RENDER_KEY = "dsh.diagram.autoRender.v1";
		/** 读取自动渲染开关（损坏或缺失时回退开启）。 */
		function autoRenderEnabled() {
			try {
				return localStorage.getItem(AUTO_RENDER_KEY) !== "false";
			} catch {
				return true;
			}
		}
		/** 写入自动渲染开关。 */
		function setAutoRenderEnabled(enabled) {
			try {
				localStorage.setItem(AUTO_RENDER_KEY, enabled ? "true" : "false");
			} catch {}
		}
		//#endregion
		//#region src/client/SettingsSection.tsx
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
		const fieldTitleStyle = {
			fontSize: 13,
			fontWeight: 600,
			marginBottom: 6
		};
		const hintStyle = {
			fontSize: 12,
			lineHeight: 1.6,
			color: "var(--dsw-alias-label-tertiary)",
			marginTop: 6
		};
		const codeStyle = {
			padding: "1px 5px",
			borderRadius: 5,
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-surface-raised)",
			fontFamily: "ui-monospace, monospace",
			fontSize: 11.5
		};
		const featureRowStyle = {
			display: "flex",
			gap: 8,
			fontSize: 13,
			lineHeight: 1.7,
			color: "var(--dsw-alias-label-primary)"
		};
		const bulletStyle = {
			flexShrink: 0,
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** mermaid 渲染器加载状态（首次渲染图表时才按需加载脚本）。 */
		function mermaidStatusText() {
			return window.mermaid !== void 0 ? "mermaid 渲染器：已加载 ✓" : "mermaid 渲染器：未加载（首次出现图表时自动从本地按需加载）";
		}
		/**
		* 「图表」设置分区页面：插件介绍 + 自动渲染开关 + 使用说明。
		*/
		function DiagramSettingsSection(_props) {
			const [autoRender, setAutoRender] = (0, react.useState)(() => {
				try {
					return localStorage.getItem(AUTO_RENDER_KEY) !== "false";
				} catch {
					return true;
				}
			});
			const applyAutoRender = (enabled) => {
				setAutoRender(enabled);
				setAutoRenderEnabled(enabled);
				const rescan = window["__dshDiagramRescan"];
				if (typeof rescan === "function") rescan();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 16,
					maxWidth: 560
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							fontSize: 15,
							fontWeight: 700,
							margin: 0,
							marginBottom: 6
						},
						children: "图表（dsh-diagram）"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: hintStyle,
						children: "让 DSH 在审查代码、梳理调用链、分析架构与数据流、解释请求时序时，直接在回复里写 mermaid 代码块，并由本插件在对话中原位渲染成 SVG 示意图（配色跟随界面明暗主题）。"
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: fieldTitleStyle,
						children: "支持的图型"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 2
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: featureRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: bulletStyle,
									children: "•"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: codeStyle,
										children: "flowchart"
									}),
									" / ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: codeStyle,
										children: "graph"
									}),
									"：流程图（模块依赖、数据流、分支逻辑）"
								] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: featureRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: bulletStyle,
									children: "•"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									style: codeStyle,
									children: "sequenceDiagram"
								}), "：时序图（请求 / 消息时序）"] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: featureRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: bulletStyle,
									children: "•"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: codeStyle,
										children: "classDiagram"
									}),
									" / ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: codeStyle,
										children: "stateDiagram"
									}),
									" / ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: codeStyle,
										children: "erDiagram"
									}),
									"：类图 / 状态图 / 实体关系图"
								] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: featureRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: bulletStyle,
									children: "•"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: codeStyle,
										children: "gantt"
									}),
									" / ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: codeStyle,
										children: "pie"
									}),
									"：甘特图 / 饼图"
								] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: featureRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: bulletStyle,
									children: "•"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "其他 mermaid 图型不会被渲染，仅显示源码" })]
							})
						]
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							cursor: "pointer",
							fontSize: 13
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: autoRender,
							onChange: (event) => applyAutoRender(event.target.checked)
						}), "自动渲染聊天中的 mermaid 代码块"]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: hintStyle,
						children: "关闭后新消息里的 mermaid 块保持源码显示（已渲染的图不受影响）。图卡片右上角有 「放大 / 查看源码 / 复制源码 / 复制 PNG / 下载 SVG」工具条；放大后可拖拽平移、双击复位； 渲染失败时保留源码并显示错误原因。"
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: hintStyle,
						children: [mermaidStatusText(), "。渲染引擎随插件本地分发，不走外网 CDN。"]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-diagram 浏览器侧（Client half）。
		*
		* 扫描聊天消息里的 mermaid 围栏代码块，原位渲染成 SVG 示意图；并在
		* 应用设置里注册「图表」分区（介绍 + 自动渲染开关，见 SettingsSection.tsx）。
		*
		* 关键事实（来自 dsh-web-frontend 的 md 渲染管线，index-ClqxG24t.js）：
		*  - 完整代码块渲染为 `<div class="md-code-block">` 容器：banner（含复制按钮）
		*    + 一个 dangerouslySetInnerHTML 的 div（Shiki 产物 `<pre><code>…</code></pre>`）；
		*    类名除 `md-code-block` 外都是 CSS-module 哈希名，不可依赖。
		*  - 流式期间若内容为空则是裸 `<pre><code class="language-…">` 占位，无容器。
		*  - 因此目标识别不靠语言类名，而靠块首行关键字命中 `SUBSET_RE`（当前含
		*    flowchart / graph / sequenceDiagram / classDiagram / stateDiagram /
		*    erDiagram / gantt / pie 八种声明），其余 mermaid 图型保持源码展示
		*    ——与宿主公告的能力范围一致；扩展图型时同步 SUBSET_RE 与公告即可。
		*
		* 渲染策略：
		*  - MutationObserver 触发扫描（250ms 合并）；每个块在源码停止变化 700ms
		*    后才渲染，流式输出期间不会反复重绘。
		*  - 示意图节点挂在 md-code-block 容器下（Shiki div 的兄弟节点），React
		*    重建 innerHTML 不影响它；`<pre>` 以内联样式隐藏，源码可随时切回。
		*  - mermaid 本体不打包进 client.js：首次遇到 mermaid 块时按需
		*    `<script src="/dsh-diagram/mermaid.min.js">`（宿主路由，本地闭环）。
		*  - 可读性（参照 WorkBuddy 的观感）：base 主题 + 自定义 themeVariables
		*    （18px 字号、圆角浅底节点、清爽子图），优先 mermaid v11 的 neo 外观，
		*    渲染失败自动降级 classic；工具条提供「放大」弹层按原始尺寸看图。
		*/
		/** mermaid 渲染脚本路由（宿主 src/index.ts 的 MERMAID_SCRIPT_ROUTE）。 */
		const MERMAID_SRC = "/dsh-opensecurity/mermaid.min.js";
		/** 视图节点根类名。 */
		const VIEW_CLASS = "dsh-diagram-view";
		/** 只接管的图型子集：块首行匹配才渲染（与宿主公告的能力范围保持一致）。 */
		const SUBSET_RE = /^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v\d)?|erDiagram|gantt|pie)\b/;
		/** 每个块在源码稳定该毫秒数后才渲染（流式防抖）。 */
		const RENDER_DEBOUNCE_MS = 700;
		/** MutationObserver 合并窗口。 */
		const SCAN_DEBOUNCE_MS = 250;
		const blockStates = /* @__PURE__ */ new WeakMap();
		const pendingRenders = /* @__PURE__ */ new Map();
		let mermaidPromise = null;
		/** 当前生效的主题（用于视图卡片与主题切换检测）。 */
		let activeTheme = "default";
		/** neo 外观渲染失败后的降级标记（true = 用 classic 外观）。 */
		let degradeClassic = false;
		/** 当前界面主题（dark / default），按 html 属性与系统偏好推断。 */
		function detectTheme() {
			const root = document.documentElement;
			const hinted = `${root.getAttribute("data-theme") ?? ""} ${root.className} ${document.body?.className ?? ""}`;
			if (/dark/i.test(hinted) && !/light/i.test(hinted)) return "dark";
			if (/light/i.test(hinted)) return "default";
			return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "default";
		}
		/** mermaid 初始化配置：base 主题 + 可读性优先的变量与间距。 */
		function mermaidConfig(theme) {
			return {
				startOnLoad: false,
				securityLevel: "strict",
				theme: "base",
				look: degradeClassic ? "classic" : "neo-default",
				fontFamily: "inherit",
				themeVariables: theme === "dark" ? {
					fontSize: "18px",
					primaryColor: "#2b3040",
					primaryTextColor: "#e8eaf0",
					primaryBorderColor: "#5b6478",
					lineColor: "#8b93a5",
					clusterBkg: "#262a33",
					clusterBorder: "#3a4050",
					edgeLabelBackground: "#22252b",
					titleColor: "#e8eaf0",
					actorBkg: "#2b3040",
					actorBorder: "#5b6478",
					actorTextColor: "#e8eaf0",
					signalColor: "#c3c8d4",
					signalTextColor: "#e8eaf0",
					noteBkgColor: "#3a3f2e",
					noteBorderColor: "#6b7245",
					noteTextColor: "#e8eaf0",
					loopTextColor: "#c3c8d4"
				} : {
					fontSize: "18px",
					primaryColor: "#eef1fb",
					primaryTextColor: "#1f2328",
					primaryBorderColor: "#8891b8",
					lineColor: "#9aa1b5",
					clusterBkg: "#f6f7fa",
					clusterBorder: "#dfe3ec",
					edgeLabelBackground: "#ffffff",
					titleColor: "#1f2328",
					actorBkg: "#eef1fb",
					actorBorder: "#8891b8",
					actorTextColor: "#1f2328",
					signalColor: "#5b6270",
					signalTextColor: "#1f2328",
					noteBkgColor: "#fdf6dd",
					noteBorderColor: "#e3d79a",
					noteTextColor: "#1f2328",
					loopTextColor: "#5b6270"
				},
				flowchart: {
					useMaxWidth: true,
					diagramPadding: 10,
					nodeSpacing: 55,
					rankSpacing: 62,
					padding: 12,
					curve: "basis",
					htmlLabels: false
				},
				sequence: {
					useMaxWidth: true,
					actorMargin: 50,
					messageMargin: 36,
					boxMargin: 10,
					mirrorActors: false,
					actorFontSize: 18,
					actorFontWeight: 600,
					messageFontSize: 16,
					noteFontSize: 15
				}
			};
		}
		function initMermaid(mermaid, theme) {
			activeTheme = theme;
			mermaid.initialize(mermaidConfig(theme));
		}
		/** 按需加载 mermaid；主题变化时重新 initialize。 */
		function loadMermaid() {
			if (mermaidPromise === null) mermaidPromise = new Promise((resolve, reject) => {
				const w = window;
				if (w.mermaid !== void 0) {
					resolve(w.mermaid);
					return;
				}
				const script = document.createElement("script");
				script.src = MERMAID_SRC;
				script.async = true;
				script.onload = () => {
					if (w.mermaid !== void 0) resolve(w.mermaid);
					else reject(/* @__PURE__ */ new Error("mermaid.min.js 已加载但 window.mermaid 缺失"));
				};
				script.onerror = () => reject(/* @__PURE__ */ new Error(`mermaid.min.js 加载失败（${MERMAID_SRC}）`));
				document.head.appendChild(script);
			}).then((mermaid) => {
				initMermaid(mermaid, detectTheme());
				return mermaid;
			});
			return mermaidPromise.then((mermaid) => {
				const theme = detectTheme();
				if (theme !== activeTheme) initMermaid(mermaid, theme);
				return mermaid;
			});
		}
		let renderSeq = 0;
		function escapeHtml(text) {
			return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
		}
		/** 在容器下找（或建）视图节点：工具条 + 画布，紧随 Shiki div 之后。 */
		function ensureView(block) {
			let view = block.querySelector(`:scope > .${VIEW_CLASS}`);
			if (view === null) {
				view = document.createElement("div");
				view.className = VIEW_CLASS;
				view.dataset["mode"] = "diagram";
				view.dataset["theme"] = activeTheme;
				view.innerHTML = "<div class=\"dsh-diagram-toolbar\"><button type=\"button\" data-act=\"zoom\">放大</button><button type=\"button\" data-act=\"source\">查看源码</button><button type=\"button\" data-act=\"copy\">复制源码</button><button type=\"button\" data-act=\"copypng\">复制 PNG</button><button type=\"button\" data-act=\"download\">下载 SVG</button></div><div class=\"dsh-diagram-canvas\"></div>";
				view.addEventListener("click", onViewClick);
				block.appendChild(view);
			}
			const canvas = view.querySelector(".dsh-diagram-canvas") ?? view;
			return {
				view,
				canvas
			};
		}
		/** 移除视图节点并恢复源码显示（源码变化后不再是 mermaid 时调用）。 */
		function removeView(block) {
			block.querySelector(`:scope > .${VIEW_CLASS}`)?.remove();
			const pre = block.querySelector("pre");
			if (pre !== null) pre.style.display = "";
		}
		function showCode(block) {
			const pre = block.querySelector("pre");
			if (pre !== null) pre.style.display = "";
			const view = block.querySelector(`:scope > .${VIEW_CLASS}`);
			if (view !== null) view.dataset["mode"] = "source";
		}
		function showDiagram(block) {
			const pre = block.querySelector("pre");
			if (pre !== null) pre.style.display = "none";
			const view = block.querySelector(`:scope > .${VIEW_CLASS}`);
			if (view !== null) view.dataset["mode"] = "diagram";
		}
		/** 工具条事件委托：放大 / 源码切换 / 复制源码 / 下载 SVG。 */
		function onViewClick(event) {
			const button = event.target?.closest("button[data-act]");
			if (button == null) return;
			const view = button.closest(`.${VIEW_CLASS}`);
			const block = view?.parentElement;
			if (view == null || block == null) return;
			const pre = block.querySelector("pre");
			const canvas = view.querySelector(".dsh-diagram-canvas");
			const act = button.dataset["act"];
			if (act === "zoom") {
				openLightbox(view);
				return;
			}
			if (act === "source") {
				if (view.dataset["mode"] === "source") {
					showDiagram(block);
					button.textContent = "查看源码";
				} else {
					showCode(block);
					button.textContent = "查看图表";
				}
				return;
			}
			if (act === "copy" && pre !== null) {
				navigator.clipboard?.writeText(pre.textContent ?? "").then(() => {
					button.textContent = "已复制";
					window.setTimeout(() => {
						button.textContent = "复制源码";
					}, 1e3);
				});
				return;
			}
			if (act === "copypng" && canvas !== null && canvas.querySelector("svg") !== null) {
				exportPng(view, button);
				return;
			}
			if (act === "download" && canvas !== null && canvas.querySelector("svg") !== null) {
				const blob = new Blob([canvas.innerHTML], { type: "image/svg+xml;charset=utf-8" });
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = "diagram.svg";
				link.click();
				window.setTimeout(() => URL.revokeObjectURL(url), 5e3);
			}
		}
		/**
		* 把当前 SVG 栅格化为 2x PNG 并写入剪贴板；剪贴板不可用时退化为下载 PNG。
		* （flowchart 已配置 htmlLabels:false，纯 SVG 标签可安全绘制到 canvas。）
		*/
		async function exportPng(view, button) {
			const svg = view.querySelector("svg");
			if (svg === null) return;
			const viewBox = svg.viewBox.baseVal;
			const width = Math.max(1, Math.round(viewBox.width || svg.clientWidth || 800));
			const height = Math.max(1, Math.round(viewBox.height || svg.clientHeight || 600));
			const scale = 2;
			const clone = svg.cloneNode(true);
			clone.setAttribute("width", String(width));
			clone.setAttribute("height", String(height));
			const xml = new XMLSerializer().serializeToString(clone);
			try {
				const image = new Image();
				await new Promise((resolve, reject) => {
					image.onload = () => resolve();
					image.onerror = () => reject(/* @__PURE__ */ new Error("PNG 转换失败"));
					image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
				});
				const out = document.createElement("canvas");
				out.width = width * scale;
				out.height = height * scale;
				const ctx = out.getContext("2d");
				if (ctx === null) throw new Error("canvas 不可用");
				const card = view.closest(`.${VIEW_CLASS}`);
				ctx.fillStyle = card !== null ? getComputedStyle(card).backgroundColor : "#ffffff";
				ctx.fillRect(0, 0, out.width, out.height);
				ctx.drawImage(image, 0, 0, out.width, out.height);
				const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
				if (blob === null) throw new Error("PNG 编码失败");
				const done = () => {
					if (button !== void 0) {
						button.textContent = "已复制";
						window.setTimeout(() => {
							button.textContent = "复制 PNG";
						}, 1e3);
					}
				};
				if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write !== void 0) try {
					await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
					done();
					return;
				} catch {}
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = "diagram.png";
				link.click();
				window.setTimeout(() => URL.revokeObjectURL(url), 5e3);
				if (button !== void 0) {
					button.textContent = "已下载";
					window.setTimeout(() => {
						button.textContent = "复制 PNG";
					}, 1e3);
				}
			} catch (error) {
				if (button !== void 0) {
					button.textContent = "失败";
					window.setTimeout(() => {
						button.textContent = "复制 PNG";
					}, 1e3);
				}
				console.warn("[dsh-diagram] PNG 导出失败", error);
			}
		}
		/** 放大弹层：克隆当前 SVG，按原始尺寸在可滚动卡片里展示。 */
		function ensureLightbox() {
			let overlay = document.getElementById("dsh-diagram-lightbox");
			if (overlay === null) {
				overlay = document.createElement("div");
				overlay.id = "dsh-diagram-lightbox";
				overlay.innerHTML = "<div class=\"dsh-diagram-lightbox-card\"><button type=\"button\" class=\"dsh-diagram-lightbox-close\" title=\"关闭 (Esc)\">✕</button><div class=\"dsh-diagram-lightbox-body\"><div class=\"dsh-diagram-lightbox-pan\"></div></div></div>";
				overlay.addEventListener("click", (event) => {
					const target = event.target;
					if (target === overlay || target.closest(".dsh-diagram-lightbox-close") !== null) overlay.dataset["open"] = "false";
				});
				document.addEventListener("keydown", (event) => {
					if (event.key === "Escape") overlay.dataset["open"] = "false";
				});
				attachPanHandlers(overlay);
				document.body.appendChild(overlay);
			}
			return overlay;
		}
		/** 弹层内拖拽平移：左键按住拖动，双击复位。 */
		function attachPanHandlers(overlay) {
			const body = overlay.querySelector(".dsh-diagram-lightbox-body");
			const pan = overlay.querySelector(".dsh-diagram-lightbox-pan");
			if (body === null || pan === null) return;
			let panning = false;
			let startX = 0;
			let startY = 0;
			let originX = 0;
			let originY = 0;
			body.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) return;
				if (event.target.closest("button") !== null) return;
				panning = true;
				startX = event.clientX;
				startY = event.clientY;
				body.setPointerCapture(event.pointerId);
				body.classList.add("dsh-diagram-panning");
			});
			body.addEventListener("pointermove", (event) => {
				if (!panning) return;
				pan.style.transform = `translate(${originX + event.clientX - startX}px, ${originY + event.clientY - startY}px)`;
			});
			const stop = (event) => {
				if (!panning) return;
				panning = false;
				originX += event.clientX - startX;
				originY += event.clientY - startY;
				body.classList.remove("dsh-diagram-panning");
			};
			body.addEventListener("pointerup", stop);
			body.addEventListener("pointercancel", stop);
			body.addEventListener("dblclick", () => {
				panning = false;
				originX = 0;
				originY = 0;
				pan.style.transform = "";
			});
		}
		function openLightbox(view) {
			const svg = view.querySelector(".dsh-diagram-canvas svg");
			if (svg === null) return;
			const overlay = ensureLightbox();
			const body = overlay.querySelector(".dsh-diagram-lightbox-pan");
			if (body === null) return;
			body.innerHTML = "";
			body.appendChild(svg.cloneNode(true));
			body.style.transform = "";
			overlay.dataset["theme"] = activeTheme;
			overlay.dataset["open"] = "true";
		}
		/** 渲染单个块（源码稳定后调用；失败保留源码并显示错误条）。 */
		async function renderBlock(block, source) {
			if (!block.isConnected) return;
			const state = blockStates.get(block);
			if (state !== void 0 && state.source === source) return;
			blockStates.set(block, { source });
			if (!SUBSET_RE.test(source)) {
				removeView(block);
				return;
			}
			const { view, canvas } = ensureView(block);
			view.classList.remove("dsh-diagram-error");
			view.dataset["theme"] = activeTheme;
			const sourceButton = view.querySelector("button[data-act=\"source\"]");
			if (sourceButton !== null) sourceButton.textContent = "查看源码";
			try {
				let mermaid = await loadMermaid();
				if (!block.isConnected) return;
				const current = blockStates.get(block);
				if (current === void 0 || current.source !== source) return;
				let svg;
				try {
					svg = (await mermaid.render(`dsh-diagram-svg-${++renderSeq}`, source)).svg;
				} catch (error) {
					if (degradeClassic) throw error;
					degradeClassic = true;
					initMermaid(mermaid, detectTheme());
					mermaid = await loadMermaid();
					svg = (await mermaid.render(`dsh-diagram-svg-${++renderSeq}`, source)).svg;
				}
				if (!block.isConnected) return;
				if (blockStates.get(block)?.source !== source) return;
				canvas.innerHTML = svg;
				view.dataset["mode"] = "diagram";
				view.dataset["theme"] = activeTheme;
				const pre = block.querySelector("pre");
				if (pre !== null) pre.style.display = "none";
			} catch (error) {
				document.querySelectorAll("[id^=\"dsh-diagram-svg\"]").forEach((el) => el.remove());
				const message = error instanceof Error ? error.message : String(error);
				view.classList.add("dsh-diagram-error");
				canvas.innerHTML = `<div class="dsh-diagram-error-msg">mermaid 渲染失败：${escapeHtml(message)}</div>`;
				view.dataset["mode"] = "source";
				const pre = block.querySelector("pre");
				if (pre !== null) pre.style.display = "";
			}
		}
		/** 调度一个块的渲染：距上次源码变化 700ms 后执行。 */
		function scheduleRender(block, source) {
			const existing = pendingRenders.get(block);
			if (existing !== void 0) window.clearTimeout(existing);
			pendingRenders.set(block, window.setTimeout(() => {
				pendingRenders.delete(block);
				renderBlock(block, source);
			}, RENDER_DEBOUNCE_MS));
		}
		/** 扫描全部代码块容器，找出 mermaid 目标并调度渲染。 */
		function scan() {
			if (!autoRenderEnabled()) return;
			const blocks = document.querySelectorAll(".md-code-block");
			for (const block of blocks) {
				if (!block.isConnected) continue;
				const pre = block.querySelector("pre");
				if (pre === null) continue;
				const source = (pre.textContent ?? "").replace(/\n+$/, "");
				if (source === "") continue;
				const state = blockStates.get(block);
				if (state !== void 0 && state.source === source) continue;
				if (!SUBSET_RE.test(source)) {
					if (state === void 0) blockStates.set(block, { source });
					continue;
				}
				scheduleRender(block, source);
			}
		}
		/** 样式：视图卡片化（WorkBuddy 观感）+ 放大弹层。 */
		const CSS = `
.${VIEW_CLASS} {
  margin: 4px 0 12px; padding: 6px 12px 10px;
  background: #fbfbfd; border: 1px solid rgba(31,35,40,0.08); border-radius: 12px;
}
.${VIEW_CLASS}[data-theme='dark'] {
  background: #22252b; border-color: rgba(255,255,255,0.10);
}
.${VIEW_CLASS} .dsh-diagram-toolbar { display: flex; gap: 2px; justify-content: flex-end; padding: 2px 0 6px; }
.${VIEW_CLASS} .dsh-diagram-toolbar button {
  font-size: 12px; line-height: 1.7; padding: 1px 8px; color: inherit; opacity: 0.62;
  background: none; border: none; border-radius: 6px; cursor: pointer;
}
.${VIEW_CLASS} .dsh-diagram-toolbar button:hover { opacity: 1; background: rgba(128,128,128,0.14); }
.${VIEW_CLASS} .dsh-diagram-canvas { overflow-x: auto; text-align: center; padding: 4px 2px 2px; }
.${VIEW_CLASS} .dsh-diagram-canvas svg { max-width: 100%; height: auto; }
.${VIEW_CLASS}[data-mode='source'] .dsh-diagram-canvas { display: none; }
.${VIEW_CLASS}.dsh-diagram-error .dsh-diagram-error-msg {
  font-size: 12px; color: #d5504e; text-align: left; padding: 4px 6px; white-space: pre-wrap;
}
.${VIEW_CLASS}[data-theme='dark'].dsh-diagram-error .dsh-diagram-error-msg { color: #ff8a8d; }
#dsh-diagram-lightbox {
  position: fixed; inset: 0; z-index: 2147483000; display: none;
  align-items: center; justify-content: center;
  background: rgba(15,17,21,0.62); backdrop-filter: blur(2px);
}
#dsh-diagram-lightbox[data-open='true'] { display: flex; }
#dsh-diagram-lightbox .dsh-diagram-lightbox-card {
  position: relative; max-width: min(94vw, 1500px); max-height: 90vh; overflow: auto;
  background: #ffffff; border-radius: 14px; padding: 20px 24px;
}
#dsh-diagram-lightbox[data-theme='dark'] .dsh-diagram-lightbox-card { background: #22252b; }
#dsh-diagram-lightbox .dsh-diagram-lightbox-body svg {
  /* mermaid SVG 无固有尺寸，width:auto 会塌缩；给固定大宽度，卡片内滚动查看 */
  width: min(1300px, 88vw) !important;
  max-width: none !important;
  height: auto !important;
}
#dsh-diagram-lightbox .dsh-diagram-lightbox-close {
  position: sticky; top: 0; float: right; margin: -8px -10px 0 0;
  font-size: 14px; line-height: 1; padding: 6px 8px; color: #6b7280;
  background: none; border: none; border-radius: 6px; cursor: pointer;
}
#dsh-diagram-lightbox .dsh-diagram-lightbox-close:hover { background: rgba(128,128,128,0.14); color: inherit; }
#dsh-diagram-lightbox .dsh-diagram-lightbox-body { cursor: grab; }
#dsh-diagram-lightbox .dsh-diagram-lightbox-body.dsh-diagram-panning { cursor: grabbing; user-select: none; }
#dsh-diagram-lightbox .dsh-diagram-lightbox-pan { will-change: transform; }
/* 设置导航图标：隐藏 fallback 齿轮，用流程图 glyph（跟随 currentColor） */
[data-dsh-diagram-settings-nav] > svg:first-child { display: none; }
[data-dsh-diagram-settings-nav]::before {
  content: ''; flex: none; width: 16px; height: 16px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='7' height='7' rx='1.5'/%3E%3Crect x='14' y='14' width='7' height='7' rx='1.5'/%3E%3Cpath d='M6.5 10v5a4 4 0 0 0 4 4h3.5'/%3E%3C/svg%3E") no-repeat center / contain;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='7' height='7' rx='1.5'/%3E%3Crect x='14' y='14' width='7' height='7' rx='1.5'/%3E%3Cpath d='M6.5 10v5a4 4 0 0 0 4 4h3.5'/%3E%3C/svg%3E") no-repeat center / contain;
}
`;
		/** 是否已挂载（factory 可能被多次 materialize，防重复观察）。 */
		const MOUNT_FLAG = "__dshDiagramMounted";
		/** 设置导航行标记（供 CSS 把 fallback 齿轮换成流程图图标）。 */
		const NAV_MARKER = "data-dsh-diagram-settings-nav";
		/**
		* 给设置导航里本插件的行打标记（同 dsh-better-sidebar 的做法：宿主 0.1.x
		* 从 settings.section 注册只投影 id/order/label，图标由 shell 按内置 id 硬编码，
		* 席位无图标字段，只能在对话框挂载后按 label 文本定位自己的行）。
		* @returns 清理函数（移除本插件拥有的标记）。
		*/
		function registerSettingsNavMarker() {
			const sync = () => {
				const buttons = document.querySelectorAll("[role=\"dialog\"] nav button");
				for (const button of buttons) if (button.textContent?.trim() === "图表") button.setAttribute(NAV_MARKER, "");
				else button.removeAttribute(NAV_MARKER);
			};
			sync();
			const observer = new MutationObserver(sync);
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				characterData: true
			});
			return () => {
				observer.disconnect();
				document.querySelectorAll(`[${NAV_MARKER}]`).forEach((el) => el.removeAttribute(NAV_MARKER));
			};
		}
		/** 挂载渲染器本体：注入样式 + MutationObserver + 首扫（幂等）。 */
		function mountRenderer() {
			const w = window;
			if (w[MOUNT_FLAG] === true) return;
			w[MOUNT_FLAG] = true;
			const style = document.createElement("style");
			style.id = "dsh-diagram-style";
			style.textContent = CSS;
			document.head.appendChild(style);
			registerSettingsNavMarker();
			let scanTimer;
			new MutationObserver(() => {
				if (scanTimer !== void 0) return;
				scanTimer = window.setTimeout(() => {
					scanTimer = void 0;
					scan();
				}, SCAN_DEBOUNCE_MS);
			}).observe(document.body, {
				childList: true,
				subtree: true
			});
			scan();
			w["__dshDiagramRescan"] = () => scan();
		}
		/**
		* 挂载插件：渲染器本体 + 应用设置的「图表」分区。
		* @param ctx - 浏览器端根上下文（slots 注册面）。
		*/
		function apply(ctx) {
			mountRenderer();
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-diagram",
				order: 65,
				label: () => "图表"
			}, DiagramSettingsSection));
		}
		/** 依赖的运行时服务：slots 注册面（settings.section 席位）。 */
		const inject = ["slots"];
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map