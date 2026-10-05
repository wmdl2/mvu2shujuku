# TauriTavern 手机发送滚动与 DOM 虚拟化检查

日期：2026-10-04。接续[运行兼容性审查](2026-10-03-tauritavern-runtime-audit.md)。用户实测此前的 Mvu 报错已消失；目前在安卓 TT 应用、关闭 DOM 虚拟化时，用户消息刚发送、AI 尚未开始回复，视口跳回前一两楼，最新用户消息不可见，需要手动向下滚动。

本轮没有发现新的插件运行缺陷，没有修改插件运行代码、卡片提示词或数据库保存协议。增加了可复用的组件检查。结论是：虚拟化的所测插件接口路径可工作；静态高度变化和手机视口变化都能在没有插件时失去末尾跟随。随后用户实机发现提示词模板显示渲染会触发虚拟化归属错误，关闭该功能后恢复；实际模板渲染函数的对照也复现了同类冲突，详见本文末尾。不能据最初 16 组组件结果宣布三个扩展的整个组合兼容。**尚未在用户安卓实机复现同一次发送，也没有修复安卓发送跳楼。**

## 受测版本与范围

| 对象 | 固定版本 | 使用方式 |
| --- | --- | --- |
| 本插件 | v0.4.10，提交 `d98a3d7` | 当前根目录实际 `index.js`，SHA-256 `110d2b8232530e2c1197f89ebb8b2ebddc7d8757b47051e1af6ed9a63468fe21` |
| TT | 2.3.0，`a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375` | 实际发送、结构事务、滚动、ChatSurface composition/controller、DOM adapter、bounded surface 与样式 |
| 酒馆助手 | 4.11.2，`519599bc68247d8e759cc844a983f8f5252941a8` | 实际 global/predefine、iframe 高度测量、消息更新和虚拟化 participant |
| TanStack virtual-core | 3.17.7 | 与 TT package.json 一致，使用原包 ESM；浏览器构建的 NODE_ENV 常量在夹具内等价提供 |

Chromium 模拟 Android UA、触摸和 390×844 屏幕，70 楼完整聊天。高度变化用实际助手 ResizeObserver 测量；视口高度改为 544 再恢复 844，**这是键盘影响的几何模拟，不是 Android 原生 IME 测试**。

使用公开合成卡和替代数据库 API；消息格式化、Vue iframe 挂载、UI 装饰器及模型生成也是夹具。静态 iframe 挂载没有启动完整 Embedded Runtime manager，虚拟化使用实际助手 participant 与 TT 管理链。没有运行 Rust 后端、正式 WebView、真实数据库 native/SQLite 组合、完整 MVU 引擎或用户远程卡脚本。不报告手机性能或真实模型质量。

## 滚动对照

每种模式分别运行加载插件与不加载插件的页面。未加载插件的 Mvu 发布只是满足助手等待的替代对象，不是完整原 MVU 对照。

| 场景 | 静态聊天，插件有／无 | DOM 虚拟化，插件有／无 |
| --- | --- | --- |
| 调用实际 TT sendMessageAsUser，AI 未回复 | 均到达底部，71 条完整消息 | 均到达底部，71 条完整消息，挂载 9 楼 |
| 发送后状态栏从 160 增高至 460px | scrollTop 不变，均离底部 300px；末尾用户楼 70 不再可见 | 均自动补偿至底部，底部间距为 0 |
| 随后视口高度缩小 300px | 底部间距从 300 增至 600px | 底部间距从 0 增至 300px；最新用户楼不再可见 |
| 恢复视口高度 | 回到原有 300px 间距 | 回到底部 |

静态路径加载与不加载插件时，发送后的 scrollTop 都为 11576；状态栏增高后仍为 11576。虚拟化路径都从 12476 补偿至 12776。该夹具下结果一致，没有插件额外写滚动位置的证据；插件 runtime 也没有直接 scrollTop/scrollTo 写入。

源码链：

- TT `sendMessageAsUser` → `withChatSurfaceStructureMutation` → `MESSAGE_SENT` → `addOneMessage` → `scrollChatToBottom({waitForFrame:true})`。发送滚动发生时，iframe 不一定已经取得最终高度。
- 助手 `adjust_iframe_height.js` 在 ResizeObserver 中改变 frameElement.style.height；TT 静态 `scrollOnMediaLoad` 只观察 img/video/audio，没有覆盖 iframe。
- 安卓 `android-ime-layout-host.js` 和 `mobile-geometry-firewall.js` 用键盘 offset spacer 缩小聊天区域。ChatSurface install 的 window resize 布局刷新只在宽度变化时触发；virtual-core 会收到高度变化，但本次对照中没有维持末尾跟随。
- TT 虚拟化的测量、末尾跟随和管理预算独立于静态路径；高度变化对照通过，不等于安卓键盘路径也已解决。

用户实机已确认最新消息消失，可以排除“键盘关闭后仅显示更多旧楼、最新消息仍在底部”的解释。余下仍需实际 Android WebView 中的 scrollTop/scrollHeight/clientHeight、键盘 inset 和 iframe 高度变化时间线，才能区分上述机制及其他宿主因素。若修复宿主，应在相关测量/布局事务里保留末尾跟随，同时尊重用户主动上翻；不在本插件加入周期性强制滚到底部。

## 虚拟化接口覆盖与限制

本轮实际 TT 管理链和助手 participant 检查通过：

- 历史 70／71 楼保留完整 chat 数组，DOM 只挂载部分消息；插件不根据 DOM 楼数计算最新消息。
- 跳到早期楼使状态栏卸载，再跳回重新挂载，实际助手 waitGlobalInitialized 和插件变量接口可用；iframe 读取与顶层数据库视图一致。
- 实际助手 setChatMessages 切换第 68 楼 swipe、调用 refreshManagedChatSurface → TT redisplayChat 后，数据读视图一致，完整聊天数量不变，表格未被修改。
- 新 AI 楼没有占位符时，插件经实际助手 managed 刷新补入占位符；最新状态栏读值正确，表格未被修改，没有直接改写虚拟化 DOM 归属。
- 开启助手前端渲染并同时启用助手 allow_streaming 时，实际助手 settings 抛出 `JS-Slash-Runner streaming rendering is not supported by managed ChatSurface`。这是上游的明确限制。

使用建议：开启 DOM 虚拟化时关闭**酒馆助手的流式前端渲染**；该限制不等同于 TT 模型回答本身不能流式输出。切换虚拟化后重新加载／重启 TT，因为 TT 和助手都在页面生命周期内固定模式。它可以改善本次状态栏增高场景，但不能承诺解决安卓发送跳楼。

虚拟化卸载重挂载仍可重建 iframe document，页面内输入、选项卡等局部状态并非数据库状态，本轮不承诺保留这些内容。所有真实角色卡、第三方扩展及性能预算的组合不在本批完整验收范围内。

## 验证与复用

公开入口：[test/tauritavern-mobile.js](../../test/tauritavern-mobile.js)。需本地 TT 2.3.0、支持 participant 的助手 4.11.2 参考源、Playwright、TypeScript、jQuery/lodash 以及固定 virtual-core 3.17.7 包。可通过 MVU_REFERENCE_ROOT、MVU_HELPER_ROOT 和 MVU_TAURI_VIRTUAL_CORE_ROOT 指定；脚本不自行联网安装依赖，也不访问个人聊天服务。

```sh
MVU_HELPER_ROOT=/path/to/JS-Slash-Runner \
MVU_TAURI_VIRTUAL_CORE_ROOT=/path/to/@tanstack/virtual-core \
MVU_TAURI_AUDIT_OUTPUT=/path/to/audit-output \
node test/tauritavern-mobile.js
```

首批 16 组观察完成，全部断言通过，页面异常 0；**包含预期宿主缺陷的观察项，因此不表示滚动缺陷已修复**。接续提示词模板的 6 组对照后，最终固定测试源码统一执行 22 组，全部断言通过，页面异常 0。脚本产出 browser-results.json，记录各组几何值和实际文件 SHA-256。浏览器、页面及回环服务由 finally 关闭，本轮所有运行已退出。

前置夹具失败已归为环境／夹具：原始 ESM 缺浏览器构建常量、抽取发送函数缺真实枚举、缺少 TT spacer 防收缩样式；模板接续补齐实际函数收尾的保存和 token 显示回调。常量和 bounded CSS 直接读取实际参考文件，没有据此修改产品。未重复运行旧产品全量 650 项，因为产品源码和构建指纹保持原验收版本。新增脚本语法与文档差异检查通过。

## 接续：提示词模板使历史滚动停止

用户实机：同一指定转换卡，只开提示词模板、酒馆助手及本插件；助手流式前端渲染已关闭，开启虚拟化会自动重载。向上浏览时出现 `ChatSurface message 102 runtime source ownership diverged`。关闭整个提示词模板后恢复；仅关闭“先处理原始内容”仍报错；再关闭“渲染楼层时执行 EJS”后恢复。

TT `message-residency.js:assertActiveRuntimeSources` 的条件是登记的 source 不再 isConnected，或已不属于原消息 contentElement。这是归属保护触发，不是禁止查看历史，也不表示聊天记录被删除。报错本身不标明修改者；上述实机开关对照与后续函数复现支持将本次故障定位到提示词模板显示渲染和 TT 虚拟化的兼容冲突。

本地提示词模板参考为 manifest 1.17.9、提交 `d6f520d149aba146305b0b781ddd691d449c28d2`。`handleMessageRender` 中：

1. 默认 code_blocks_enabled=false 时，escapePreContent 将 `<pre>` 包成 EJS 的原样输出语句，作为 content。
2. 实际 EJS 引擎执行后，newContent 可以与原始 HTML 一样，但与包装后的 content 不同。
3. `newContent !== content` 因而触发 `container.html(newContent)`，旧 `<pre>` 断开，新的节点虽然显示相同，却未经 TT 登记。
4. 下一次 projection/reconcile 检查保留的消息时，触发同类归属错误。

接续测试运行实际模板 handleMessageRender、escape/实体处理函数和其 vendored EJS 引擎；世界书、变量环境、正则、UI/保存回调替代，永久修改原始消息的分支关闭。使用公共合成前端，旧 Vue 挂载替代限制仍保留，不是完整模板扩展实机。第 68 楼复现同一 guard，不冒称复现了用户第 102 楼的完整执行过程。

| 显示渲染配置 | 不加载本插件 | 加载本插件 |
| --- | --- | --- |
| 楼层 EJS 开、代码块 EJS 关、原始内容处理关 | HTML 相同但 source 被替换，同类 runtime source ownership 错误 | 同样结果 |
| 楼层 EJS 开、代码块 EJS 开 | 该合成样本 source 不变，没有归属错误 | 同样结果 |
| 楼层 EJS 关、代码块 EJS 关 | source 不变，没有归属错误 | 同样结果 |

每组完整聊天仍有 70 条，表格未改变。代码块 EJS 开仅是机制对照，不推荐据此为所有卡开启代码执行；它会改变代码块中的模板语义。

### 设置与影响

本地 1.17.9 settings.html 和 zh-cn 翻译对应如下，作者“渲染原始楼层”的表述按功能应对应第一项：

| 界面名 | 内部设置／控件 | 作用 |
| --- | --- | --- |
| 渲染楼层时执行 EJS | render_enabled／pt_render_enabled | 楼层显示 EJS 总开关；关闭后 render before/after 等显示处理也不执行 |
| 先处理原始内容 | raw_message_evaluation_enabled／pt_permanent_evaluation | 在上述处理内部，先永久修改原始消息；关闭仍会执行显示层处理 |
| 允许处理代码块 | code_blocks_enabled／pt_code_blocks | 是否在 `<pre>` 中执行模板；不等同于关闭楼层渲染 |

用户已验证关闭第一项能恢复历史滚动。生成提示词的 EJS 由独立设置控制，可保留；本插件的数据库读写协议不由上述 render_enabled 控制。但显示阶段的模板能调用 setvar／setMessageVar 等变量修改函数或其他 JavaScript，关闭执行就可能让业务逻辑不再发生。不能把“数据库协议没改”说成“所有变量更新都不受影响”。

该功能的用途是处理显示在聊天楼层里的 EJS：求值输出文字或 HTML、按条件显示内容、追加 render before/after 条目，以及执行代码。启用“先处理原始内容”时还会先处理并永久写回消息正文；关闭楼层总开关也会跳过这一分支。

| 依赖位置与用途 | 关闭楼层 EJS 的一般影响 |
| --- | --- |
| 世界书／预设 EJS 仅用于生成前构建提示词 | 保留生成阶段 EJS 时，该路径通常仍工作；显示阶段遗漏的变量修改仍可能间接影响后续请求 |
| 消息正文中的 EJS 求值、条件显示、格式转换 | 不再生成对应显示结果；代码可能留在界面，也可能被其他规则隐藏 |
| render before/after 世界书条目或对应 decorator | 不再注入相应状态栏、说明或其他显示内容 |
| 消息显示阶段 EJS 修改变量、计算业务数值或执行动作 | 相应更新和动作不再执行，影响可超出外观 |
| 依赖先处理原始消息以永久替换／保存输出 | 该楼层处理不再发生，保存的正文和未来提示词可能不同 |
| 正则生成 HTML iframe，JavaScript 直接读 MVU／数据库 | 通常可以继续，但其 HTML／数据准备若依赖上述 EJS 路径，仍受影响 |

不能按“是 MVU 卡”“状态栏有数字”判断是否依赖此功能；需要按实际执行阶段和数据依赖判断。仅测试页面正常不证明后续变量逻辑正常，也无需为解释开关把所有角色卡重新审查一遍。

对本地指定卡及当前转换副本，静态核对未发现启用的 render before/after 世界书条目，两条启用状态栏正则的替换体没有 EJS，开场也没有 EJS；保留世界书中仍有 EJS，需要保留生成阶段处理。该证据支持本卡关闭显示渲染的影响较小，但没有覆盖模型未来输出、新增世界书、动态脚本和手机上不同的转换版本。

同一公开脚本设置 `MVU_TAURI_OWNERSHIP=1` 仅执行上述 6 组；设为 `all` 时连同原 16 组统一执行。最终 22 组的结果与源码指纹保留在本地证据，脚本 SHA-256 为 `9a60ed1ef394cee88dafdc764aeb9547af3297e8826d823b5b2ada44d95c4323`。本次没有通过本插件拦截全局 jQuery 或关闭 TT 归属保护；正确的长期修复应由模板渲染接入宿主内容事务／处理器来维护节点归属。
