# TauriTavern 2.3.0 运行兼容性审查

日期：2026-10-03。本轮检查扩展加载、角色卡与世界书、聊天历史、楼层写入/回放、变量 API、事件、iframe 生命周期、状态栏和滚动。结果是发现运行时兼容缺陷与宿主交互风险，**没有取得整套 TauriTavern 实机兼容验收**；初次审查对象为 v0.4.8；随后继续修复已确认的四项接口缺陷，v0.4.9 的结果见本文末尾。

## 版本与证据边界

| 组件 | 本轮依据 | 证明范围 |
| --- | --- | --- |
| 转换器 | v0.4.8，提交 `f614dfea69b418cf38edcf110eb48b6f7fce1cb9`；构建 SHA-256 `0ceab8748dc13cdb621d2e09ca2f85a0c20f0c4139a1009159ff7bc851f542a3` | 当前源码、完整浏览器装配包及相关回归 |
| TauriTavern | 2.3.0，`a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375` | 本地只读参考源码、实际 iframe-slot/scroll 模块、部分契约检查；未运行 Rust 后端和正式 WebView |
| 酒馆助手 | 4.11.2，`519599bc68247d8e759cc844a983f8f5252941a8`；工作树干净 | 该版本的 `global.ts`、`variables.ts`、`predefine.js`、消息刷新和 Tauri participant 源码；浏览器使用原函数体，非完整扩展启动 |
| 龙血玄黄·数据库 | 参考库由 `fd91407f` 安全更新到 `801d1e32aa67323fc9646b75bdcc5323ce801c45`，CLEAN；当前 package/manifest 仍为 1.0.0 | 最新参考 API/初始化/保存调用链；本轮浏览器使用替代数据库 API，未验收此提交的实际 native/SQLite 运行 |
| 用户环境 | 已知 TauriTavern 2.3.0、已转换卡，其余组件为用户所称最新版 | 未取得所有组件实际构建指纹、运行开关或原始错误上下文；不可视为与本地受检组合相同 |

数据库更新时出现了新的 `naiv1.1` 标签，但本轮读取的 HEAD manifest/package 均仍写 1.0.0；不根据标签列表推断实机版本。既有 1.0.0 / `fd91407f` 的 SillyTavern 验收仍是历史证据，不冒充当前提交或 TauriTavern 的验收。

## 已证实的插件问题（v0.4.8，后续修复见末尾）

### 1. getter-only 的 Mvu 会中断该窗口的后续接管（高）

`src/extension-runtime.js:applyWindowMvuShim` 在严格模式中直接执行 `w.Mvu = windowMvuFake`。随后才安装 `waitGlobalInitialized`、`getAllVariables` 和变量读写包装；整段由同一个 try/catch 包围，赋值异常会跳过后续操作，且日志默认不可见。

酒馆助手 `src/function/global.ts:_waitGlobalInitialized` 用 `Object.defineProperty(this, global, { get, configurable: true })` 发布全局。如果此前 `predefine.js` 已安装空 setter，重新定义 getter 会保留那个 setter，常见路径可以正常运行。**如果前置阶段没有该 setter**，例如 iframe 在父窗口 Mvu 发布前已经执行预定义，等待函数会形成 getter-only 属性。

浏览器用酒馆助手原函数生成后一种属性：等待成功、Mvu 可读取，但下一轮插件接管没有给该窗口安装 `getVariables` 包装；将 Mvu 改成可写属性的对照场景则恢复包装和数据库读视图。这是确定的条件性缺陷，不能解释为每个助手 iframe 都必然失败，也尚未单独复现用户所报的 `ReferenceError: Mvu is not defined`。

建议：按属性描述符安全发布本扩展的兼容对象；把 Mvu 发布和其他接口安装拆成独立失败边界。处理 getter 与已有真实 MVU 时须保留切卡还原契约，不能无条件删除任意全局。

### 2. 新 iframe / 冷恢复有变量读取接管空窗（高）

插件的新增 iframe 观察器可能先处理 about:blank 文档；随后 srcdoc/Blob 导航会替换全局对象，酒馆助手 `predefine.js` 又会安装自己的读取函数。`runtime-windows.js` 的 iframe load 监听只标记缓存过期；运行时创建该工厂时没有提供 `onChange`，因此 load 本身不主动完成接管。下一轮完整接管主要依赖 2 秒轮询或其他广播。

TauriTavern 的真实 `createManagedIframeSlot` 冷恢复组件测试中：重挂载后 Mvu 是对象，但助手的 `getAllVariables` 一度与父窗口数据库视图不一致；下一轮接管后读回一致。本地指定卡的真实状态栏初始化也观察到先不一致、后恢复一致，初始化未捕获异常。

这证明有短暂读视图空窗，**不证明数据库初值被写回或持久化数据丢失**。仅在初始化时渲染、之后等待事件的页面，可能在读取恢复后仍保持先前显示；本轮指定卡的另一次晚期冷恢复未观察到这种持续显示失步，不能扩大为该卡必现结论。

建议：窗口 load/文档代次变化后立即补接口与就绪通知，并保证源码预定义覆盖后再次校验。就绪通知应面向新文档，避免通过重复业务事件造成重复奖励/扣费。

### 3. 原接口缓存没有区分同一 WindowProxy 的新文档（高）

`src/runtime-globals.js:note` 按窗口保存原始函数，`hasGet/hasWait/hasGav` 一旦成立便不再采集。`runtime-windows.js` 虽会察觉 document 变化，却仍返回同一个 WindowProxy；`retainWindows` 因该窗口仍在集合中而保留原记录。

真实浏览器同一 iframe 两次 srcdoc 导航的结果：新页面原始 `getVariables` 返回 epoch=2，登记记录仍保存 epoch=1；撤销接管后新页面被还原为 epoch=1 的旧函数。该探针运行真实工厂，没有复制另一份登记算法。

影响是旧页面的函数/绑定可能被委派或还原到新页面，尤其涉及作用域、等待函数和 iframe 身份读取；本轮没有证明它已造成真实聊天跨卡写入。

建议：原接口记录同时绑定 document 代次。导航后重新采集当前文档原函数；还原只能作用于该记录实际接管的文档。

### 4. 少见的无助手事件兜底存在解绑问题（中，源码确认）

`applyWindowMvuShim` 的兜底 `eventOn` 注册一个 wrapped 回调，而 `eventOff` 用用户原 handler 调 `removeEventListener`，两者引用不同；通过 eventOff 解绑无效。返回值的 `stop()` 能正确移除 wrapped。正常助手已有 eventOn 时不进入此分支。

这可能导致恢复/重复初始化后的旧监听继续触发，但本轮未在完整宿主复现；不把它归为用户三个现象的已证实原因。建议以事件名和原 handler 管理 wrapped 对应关系，并完善撤销记录。

## 已证实的宿主/渲染交互与既有边界

### 5. 先滚到底部、后增高可以独立造成停在旧楼（高相关性）

TauriTavern `src/script.js:printMessages` 渲染后调用 `scrollChatToBottom({ waitForFrame: true })`。状态栏 iframe 此时可能尚未加载或取得最终高度。`scrollOnMediaLoad` 跟踪 img/video/audio，不覆盖 iframe；酒馆助手 `adjust_iframe_height.js` 后续直接改变 `frameElement.style.height`。

未加载转换器的浏览器页面，运行真实 Tauri scroll adapter：40 个受控楼层初始各高 100px、视口 500px，滚到底部时 scrollTop=3500；随后各楼增高为 400px，scrollTop 仍为 3500，视口首楼约为 8，末楼为 39。这是晚到高度改变与滚动不同步的机制证明，不是用户原聊天的逐步复现。另需检查实际 `auto_scroll_chat_to_bottom` 开关，关闭它时宿主本就不执行该自动滚动。

此结论针对静态聊天布局；虚拟化模式有独立测量和跟随末尾逻辑，不能沿用静态结论判定其故障。若用户所指是数据库面板选中楼层，也不能套用此滚动结论。

建议：在宿主/助手测量链中处理异步 iframe 高度和末尾跟随，并保留用户主动向上阅读的意图；不建议在插件内周期性强制 scrollTop 到底部。

### 6. iframe 冷恢复会丢页面局部状态（高相关性）

TauriTavern 默认 `embedded_runtime_profile=auto`，静态聊天由 Embedded Runtime 按可见性/预算管理 iframe；`chat_virtualization_enabled` 默认 false，开启后走 ChatSurface participant。两个配置是独立维度。

真实 `managed-iframe-slot.js:dehydrate/hydrate` 组件测试：输入框从 selected 回到 initial，页面脚本重新执行一次。本地指定卡选择另一选项卡后冷恢复，显示内容也变化为新页面状态。软停车源码明确说明跨 DOM 移动能否保留浏览上下文取决于平台，不能把保留 iframe 元素当成保留页面状态。

因此“选项卡、展开、滚动等状态恢复默认”可以由宿主重建引起，不要求数据库被重置。持久化业务数值回退则需要另查保存/回放证据。

### 7. 插件补占位符可能触发助手重建消息（高相关性，调用链确认）

`extension-runtime.js:ensureWindowStatusPlaceholder` 仅在最新 AI 消息缺少 `<StatusPlaceHolderImpl/>` 时，调用 `setChatMessages(..., { refresh: 'affected' })`。它在进入聊天和收到回复后的延迟阶段运行；不是每次收到消息都无条件重载。

助手 4.11.2 静态路径：`chat_message.ts:setChatMessages` → `refreshMessages` → `displayed_message.ts:refreshOneMessage`，后者直接对 `.mes_text` 使用 `.empty().append(...)`。这会移除原状态栏；Tauri 自己的内容事务虽有 wrapper 保留机制，该助手路径没有调用它。开启虚拟化时助手改走 `refreshManagedChatSurface/redisplayChat`，需要独立检查 participant 的复用结果。

该链能放大高度变化与页面局部状态重置；目前只确认源码路径，未在正式 WebView 中复现“每次发送跳上一层”。建议协调正文占位符追加与宿主渲染事务，避免在状态栏源码不变时销毁页面。

### 8. 导入、直接创建与世界书冲突仍是不同路径（既有边界）

下载文件已有 v3 包装；Tauri 支持卡内世界书导入。直接创建 API 按 world 名查本地书，缺同名书时可能记录错误后继续保存，打开卡时还可手动导入内嵌书。不能据创建阶段日志判定保存最终失败。

数据库写入本地可读状态表会与仅含初始模板的卡内世界书形成真实内容差异，因此可能反复提示世界书冲突。它不自动证明聊天表格丢失；两种选择仍会影响世界书的其他条目。既有实测和边界见[文件导入记录](2026-09-27-tauritavern-card.md)。本轮角色 GET 和冲突路由契约检查通过，不把它们当真实导入的重验收。

## 全面检查覆盖表

| 范围 | 结论 / 本轮覆盖 | 仍有边界 |
| --- | --- | --- |
| 扩展加载 / 同源 API | TT 使用标准 third-party 同源资源与 module 装载；插件整体 bundle 在 Chromium 组件页加载成功 | 正式安装发现、WebView 平台资源/CDN、完整助手启动未运行 |
| 角色浅加载 / 身份 | TT 浅对象会删 converter 扩展和世界书；插件通过角色 GET 补完整卡，按头像和会话代次校验；角色 GET 契约通过 | 加载延迟和实际开关会影响提前发布时序，不能默认完整卡 |
| JSON/PNG / 世界书 / 保存 | 文件格式和 API 契约无新静态破坏；上述直接创建、嵌入书冲突仍适用 | 导入冲突选择后整套业务链未实机重测 |
| 聊天完整性 / 索引 | TT `getContext().chat` 为完整有序数组；chat_truncation 与虚拟化只影响 DOM，不能据 DOM 数量计算最新楼 | 不把历史分页 API 的 cursor 当消息编号 |
| 冷 swipe | 当前正文、变量、索引保留；非当前 swipe 内容可为 null；宿主读回/保存契约检查通过 | 未以原卡完整验证所有非当前 swipe 和分支替换 |
| 初始化 / 原生与 SQLite | 相关插件保护、空/半物化读取、API 就绪、候选提交测试覆盖 | 浏览器探针数据库为替代 API；最新数据库提交和实际 SQLite 实例未在 TT 中验收 |
| 写入楼层 / 删楼 / 切卡 / 重生成 | 相关回归通过；写入目标依据 canonical chat 与对象/swipe 身份，未依赖 DOM 最新节点；参考核心 API/存储接口未见本批破坏 | 不证明用户历史聊天的实际帧和选中隔离范围正确 |
| 变量 API / 全局等待 | 常见助手预定义路径成功；存在 getter-only、导航缓存和冷恢复接管空窗 | getter-only 是特定初始化顺序；精确 Mvu ReferenceError 未复现 |
| 事件 / 前端通知 | 相关回归覆盖；新页面生命周期仍有上述风险；无助手 fallback 的 eventOff 有源码缺陷 | 真实助手业务总线、所有远程脚本和动态 EJS 未全量运行 |
| 状态栏 / 滚动 / 移动布局 | 原卡初始化、冷恢复局部状态、真实 scroll adapter 已做组件检查 | Android/iOS/WebView、虚拟化及实际性能/可见性预算未实机验收 |
| 旧聊天 | 有 V2 帧的保存回放契约与相关回归覆盖；插件并不提供旧 MVU 聊天自动迁移 | 若把原 MVU 旧聊天直接配上转换卡，不能承诺变量自动继承 |

## 执行结果与复现

- 相关插件回归：`node test/run-tests.js --grep '运行|会话|桥|变量|事件|占位|前端|初始化|回放|切卡|保存|Tauri'`，128 项中 127 通过、1 失败。失败为 `test/run-tests.js` 中“INSERT 示例优先用卡内真实初始值…”的旧文案断言，期望初值被复制进 SQL 示例，与 v0.4.8 已批准策略冲突。初次审查记录该断言失配；后续已按 v0.4.8 短示例契约更新该断言。
- 公共 Chromium 组件探针：[test/tauritavern-audit.js](../../test/tauritavern-audit.js)，7 组观察，未捕获浏览器异常；包含已知缺陷的反例，**exit 0 表示探针完成，不表示兼容性全部通过**。
- 私有卡额外观察：在组件页执行卡内状态栏正文，外部依赖使用本地 jquery/助手函数，检查初始化、下一轮接管、就绪广播完成后的冷恢复，共 3 组；这不是完整卡与全部外部业务脚本的启动验收。没有复现 Mvu ReferenceError；观察到一次早期变量视图不一致和冷恢复页面状态变化。卡内容不进入公共脚本。
- TT 直接执行 7 个 Node 契约文件，共 48 项通过、0 失败：kernel 4、character-get 7、lorebook-conflict 5、payload-normalize 4、payload-jsonl 7、payload-commit 18、cold-swipes 3。初次 `node --test` 只呈现文件级摘要、未显示内部子测试，未把该摘要计作行为通过证据，随后直接执行对应文件取得上述实际用例结果。这些源码/函数/模拟传输契约检查不代替 Rust 或正式应用操作。
- 上游 manager/adapter/controller 的 Happy DOM 测试因参考树缺 `happy-dom` 未执行成功，归为测试环境依赖；相应恢复和滚动行为改由真实浏览器组件取证，不声称那些上游测试已通过。
- 没有新模型请求、成本基准或完整 SillyTavern 服务验收；浏览器与隔离回环服务均由脚本 finally 关闭。上述记录对应初次审查的 v0.4.8；后续修复构建另行记录。

公共探针需要本地参考源码、参考 SillyTavern 的 jquery/lodash 与 Playwright 浏览器，见[开发指南](../development.md)。`MVU_REFERENCE_ROOT` 指定共享参考区；`MVU_HELPER_ROOT` 可选地指定要核对的助手源码树，否则使用参考区的助手版本。输出记录实际版本，不能只按用户说的“最新版”替代指纹。

```sh
node test/tauritavern-audit.js
# 检查另一个助手源码树：
MVU_HELPER_ROOT=/path/to/JS-Slash-Runner node test/tauritavern-audit.js
```

## v0.4.9 修复与对照（2026-10-03）

用户要求继续后，已修改并重建插件；未提交或推送。本节描述最终改动，前面的缺陷机制与初次测试结果保留作归因证据。

| 修复 | 最终行为与验证 |
| --- | --- |
| Mvu 安全发布 | 实际运行调用 runtime-globals 工厂的 publishMvu；若助手只读 getter 已返回 shim，无需赋值。其他可配置属性可安全替换，撤销恢复原描述符，不覆盖后来安装的外部属性。隔离 VM 与真实助手 getter 场景通过。 |
| 原接口按文档记录 | 同一个 WindowProxy 更换 document 后重新记录，撤销旧记录不碰新文档。真实 iframe 导航得到当前/缓存/还原 epoch=2/2/2。 |
| 加载后补接管 | runtime-windows 的 onChange 通知合并为一次延迟任务，核对会话与接管状态后执行；冷恢复后的夹具首次异步读值已等于数据库视图，不必等待两秒轮询。此结果不保证 load 之前最早同步脚本的读值。 |
| 无助手事件兜底 | eventOff 按事件名和原 handler 移除 wrapped；stop 可重复调用，切卡撤销时清理监听和兜底接口。浏览器两次注册后计数为 2，eventOff 与切卡后均不再增长。 |

更新扩展并刷新宿主后，已有转换卡可使用这些运行时修复，无需为这四项重新转换。根目录 index.js 已重建为 v0.4.9，SHA-256 为 `318b502591b6379f7b348adc5265de11a8bbc5ceb3fa4852880d23c826b1f7ef`。

公开浏览器探针增加了**原 MVU 发布协议对照**：执行快照源码的 initGlobals 函数、实际助手等待/变量读取与实际 TT iframe-slot；MVU engine、store 和 watch 使用替代实现，不是完整原 MVU 卡启动。没有加载本插件时，原协议冷恢复前后均读取 sentinel=42、Mvu 为 object，但局部输入从 selected 回到 initial。因此局部页面重置机制可独立于本插件存在。无插件静态高度场景也仍停留在旧楼；这两个对照不证明用户实际错误的唯一根因。

最终 `MVU_TAURI_ASSERT_FIXED=1` 浏览器复验完成，9 组观察、浏览器异常 0，修复断言均通过。构建与探针语法检查、git diff --check 通过。插件回归按行为批次完成 645 项覆盖：合并唯一结果 644 通过、1 失败。初次全量前 372 项中 366 通过、1 实际 Zod 卡清理断言失败、5 Python 子进程超时；停止受限进程后，仅补跑这 5 项和 273 项未覆盖测试，278/278 通过。剩余断言期望实际卡的旧输出协议条目被移除，以 HEAD 的 v0.4.8 核心做同输入对照也保留该条目，表数同为 5；本轮未修改转换清理逻辑，也没有把全量记为全部通过。前面的短 INSERT 示例旧断言已按批准策略修订并通过。原始 127/128 审查结果不覆盖最终版本。

最后审阅另补旧版本 fallback 缺少清理句柄时的保护与 1 条回归，当前库存为 646。补充后的原接口模块 8/8 通过，并重建、再次检查语法和上述 9 组浏览器场景；未重复全量。前述 645 项批次对应补充前的同版构建 `42c99e1c…`，最后构建指纹见上文，不能将两次指纹混为一次全量验收。

完整 Rust/WebView、真实最新版数据库 native/SQLite、虚拟化聊天、占位符刷新与宿主恢复交互仍未取得组合验收。指定卡的精确 `ReferenceError: Mvu is not defined` 仍未复现，不能宣称修复该报错或用户三个症状已经全部解决。滚动/占位符相关代码未作产品修改；后续应使用固定宿主构建分别检查静态和虚拟化路径，并区分局部 UI、首次变量读值与持久化业务数值回退。

复验命令：

```sh
MVU_HELPER_ROOT=/path/to/JS-Slash-Runner MVU_TAURI_ASSERT_FIXED=1 node test/tauritavern-audit.js
node test/run-tests.js
```

## v0.4.10 状态栏空显示接续修复（2026-10-03）

用户进一步明确：数据库保存正常，状态栏显示为空或默认值。本批按前端读值与消息重建问题处理，没有调整数据库保存协议、表结构或原卡提示词。v0.4.9 之后增加以下修复：

- 占位符更新等待助手消息接口结束；接口拒绝被捕获，异步返回后核对会话与原消息。聊天间的去重键带会话，防止相同楼号与长度让新聊天漏补。助手仍负责落盘，setChatMessages 返回不代表延迟文件写入已经完成。
- 仅 TT 静态宿主具备所有必要 API 时使用 refresh:none 更新消息，再走 updateMessageBlock 与 CHARACTER_MESSAGE_RENDERED；显示相同时完全不重画。ST、TT 虚拟化与缺失 API 的情况继续走助手 affected 刷新。
- 全为 0、false、空容器的状态不再仅凭叶子值判定为未就绪；核对完整运行时或持久化快照与当前读视图一致后也通知初始化。未物化空壳仍不通知。

原有实际 Zod 卡失败已定位为旧断言不符合保留边界：变量处理指令集混有业务限额、日期重置和输出格式，不能视为纯输出文档整条删除。本批修正私有卡可选检查，并增加公开合成样本验证三模式下保留混合业务、删除纯输出。转换器清理实现和卡内提示词均未修改；混合条目中仍有旧协议时仍需人工核对，不能把测试通过理解为已自动拆净全部协议。

最终受测构建为 v0.4.10，SHA-256 `110d2b8232530e2c1197f89ebb8b2ebddc7d8757b47051e1af6ed9a63468fe21`；根产物、版本与源码指纹一致。

| 验证批次 | 结果 | 范围 |
| --- | --- | --- |
| 原生运行时、生命周期、占位符与相关保留边界 | 21/21，通过；另补持久化零值路径 1/1 | 执行当前产品装配实现，覆盖 ST/TT 分支、相同显示、接口拒绝、切聊天、重复事件、零值与未就绪 |
| 最终全量 Node 回归 | 650/650，通过 | 最终冻结源码与构建；直接 Node 执行，避开已证实的沙箱 Python 子进程超时，SQL 示例检查实际执行内存 SQLite |
| 最终公开浏览器组件 | 12 组，异常 0，断言通过 | 前述 9 组加 3 组占位符场景；实际助手 setChatMessages/refreshMessages/refreshOneMessage，实际 TT updateMessageBlock 和渲染事务；数据库、格式化、前端挂载与装饰器替代 |
| 指定卡已转换状态栏复验 | 10 组观察，异常 0，其中 3 组指定卡场景 | 使用既有已转换夹具、新构建、本地依赖、替代数据库；初始化与冷恢复后的读视图一致，捕获初始化错误为空；非完整原卡引擎或远程脚本验收 |

公开占位符结果：ST 仍调用助手 affected、宿主调用 0；TT 相同显示保存 none、宿主调用 0、原 iframe document 和输入 selected 均保留；TT 显示变化保存 none、宿主调用 1、wrapper/iframe 元素保留，但 iframe document 改变、输入回到 initial。这证实减少无必要重建，也证实仅保留元素仍不能承诺局部状态不重置。三场景业务表均未变化，刷新后 iframe 读视图均与数据库投影一致。

指定卡精确 Mvu is not defined 仍未复现；本批也没有复现用户实际聊天的滚动跳层。TT 静态高度交互、完整虚拟化、Rust/WebView、最新版真实数据库双模式和远程业务脚本组合仍需实际环境验收。此前的 644/645 和最后守卫 8/8 是 v0.4.9 的历史批次，不能作为最终 v0.4.10 计数；当前全量结果为 650/650。

既有转换卡更新扩展并刷新宿主即可使用本批运行时修复；未提交或推送。
