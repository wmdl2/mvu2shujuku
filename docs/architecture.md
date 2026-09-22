# 转换架构与产物

[文档索引](README.md) · [开发验证](development.md)

本文描述当前有效实现；兼容承诺以[兼容清单](../COMPATIBILITY.md)为准。文中的仓库路径均相对仓库根目录。

## 项目目标

本项目是 SillyTavern 原生扩展，将使用 MVU（MagVarUpdate）的角色卡转换为 SP·数据库角色卡。

转换内容包括：

- 解析 `[InitVar]` 世界书和问候语中的 `<initvar>`。
- 将 `stat_data` 转换为单例表、动态行表、关系子表、数组表或 JSON 逃生列。
- 把 `[mvu_update]`、Zod 和其他可识别规则迁移为表格 note、列约束和提示词。
- 保留用户业务脚本，移除可确认已被数据库取代的 MVU 引擎或纯 Schema 启动块。
- 提供 `Mvu.*`、`getVariables`、`updateVariablesWith`、`getAllVariables` 等运行时兼容接口。
- 让原卡前端、EJS、多开场和卡内业务脚本在数据库卡中继续工作。



正则仅删除替换体整体为纯旧快照宏的规则，匹配目标、MVU API 与控件不作为删除证据；保留前端的格式化宏接入数据库入口。世界书删除要求完整静态规则文档或明确的输出专名/纯快照形态；业务 EJS、非专名混合内容及解析失败的规则保留并报告。`protectFrontendEjsLiterals` 只处理 script 内已知的 EJS 标签检测正则；转换时处理卡内正则，扩展在每次 `prompt_template_prepare` 的 render 上下文注册临时 HTML 正则以处理动态加载内容。回调检查当前转换卡和聊天身份，普通卡、生成阶段及过期会话不处理；不修改楼层原文或远端资源。

## 转换时

模板生成按逻辑父子关系组织阅读顺序，保留物理表和 layout 身份。隐藏内部物理列由目标 SP 版本
门控；无法确认版本时报告降级。可空字段的表示由 schema/layout 明确声明，codec 与 writer 共用
该编码契约。运行时以来源明确的业务提交和只读前端通知分别处理同名事件，窗口发现由
`runtime-windows.js` 管理缓存与失效，细节见[运行时契约](runtime.md)。

`convert` 完成输入解析与 `transformCard` 分析，`packageConversion` 负责 JSON/PNG、模板、报告和桥文件装配。核心用 WeakMap 保存每个结果对应的原始输入快照、规则选项、桥配置与模板/提示词指纹，不写入角色卡或扩展设置。

UI 应用配置、合并模板和刷新下载调用 `refreshConversion`：转换规则一致时复用 schema 和已转换卡，更新模板条目、桥、templateUid 与文件；仅新增/变更的 sourceData 迁移提示词。原模板表对象引用保持不变，避免刷新后编辑器写入失效；卡片产物另行复制。模板和格式未变时复用整个结果；仅格式/报告变化只重新打包文件。规则选项变化从原始快照完整转换，不能把已转换卡当输入再次转换。

基准入口：`node test/benchmark-refresh.js [原卡.json或.png]`。默认30表合成卡，预热2轮后统计9轮中位数；比较完整转换、参数刷新和无改动刷新，不把 Node 耗时当作浏览器帧耗时保证。

`convert()` 读取角色卡、世界书、问候语、正则脚本和酒馆助手脚本，然后生成：

1. SP·数据库模板（`mate + sheet_*`）。
2. `extensions.mvu2shujuku.layout` 布局元数据。
3. 轻量卡内登记桥及扩展安装 Mvu shim 所需的元数据。
4. 内联的 `__ACU_TEMPLATE_DATA__` 模板数据。
5. 改写后的 EJS/前端数据入口。
6. 转换报告和需人工处理清单。

数据库结构名与 MVU 逻辑路径分层处理：表名中的 `{{user}}` / `<user>` 在转换时静态规范化为 `user`，但 layout 持久化时保留原 MVU 逻辑路径。运行时必须克隆 layout，再使用 SillyTavern `substituteParams` 解析逻辑组名、列路径、写路径和镜像路径；不得改写物理表名，也不得将解析结果回写到卡内 layout。

UI 层的转换配置只保存用户决策，不保存整份生成模板：同名表的 `updateConfig` 参数、`exportConfig.injectIntoWorldbook` 布尔值，以及外部表的来源值、来源内 UID、表名和结构指纹。应用配置时先从新卡重新生成基础模板，再从原来源读取外部表最新版，最后再次覆盖表格设置。旧配置缺少注入字段时不覆盖新模板的原值。不得用旧转换模板覆盖新卡结构，也不得把单表 UID 当作跨来源的全局身份。

`result-view.js` 是由真实运行时调用并内联进构建的结果视图工厂：优先显示结构化报告的人工项/警告，完整文本保留；表格列表按 UID 选择，可对所选或全部表应用参数和世界书注入设置。修改只写本次模板，通过既有刷新路径进入下载卡/模板/桥，不调用活动聊天的写库 API。报告和表名使用文本节点，不能执行作者提供的 HTML。

卡内 `extensions.mvu2shujuku.layout` 和模板定义转换时的物理结构及逻辑路径，薄桥仅登记，扩展中的 codec/writer 执行读写。`bridgeVersion` 是转换来源标记，并非自动 schema 迁移协议；新扩展保留已识别旧布局的处理分支，以继续运行已有转换卡。结构升级仍需重新转换原卡、使用匹配模板建立新聊天，旧聊天不自动迁移。

世界书整条删除必须有明确的初始化、结构规则或写入/输出管道证据。变量读取宏
`format_message_variable`、`get_message_variable` 与 `getvar(stat_data...)` 只触发数据源改写，不能作为
删除证据；comment 中的 `[mvu_update]` 也不能单独证明正文可删。

规则解析与完整文档判定共用同一份 YAML 预处理。`check` 中完整单行的自然语言操作说明
（如 `本轮减1（op: delta, value: -1）`）按字符串解析，避免其中的冒号被误当嵌套映射；
业务正文保持原样。已引用字符串、块文本、带续行的内容和其他 YAML 错误不作猜测修复，
有其他解析错误或混合 EJS 时仍保留原条目并报告。

前端字段补充扫描由 `src/status-usage.js` 独立负责，构建时内联同一工厂。先提取 HTML/Markdown
前端中的脚本或 EJS，再按来源、可识别的词法作用域和声明追踪数据别名；兄弟函数、其他脚本、
参数及局部声明不继承碰巧同名的别名。普通字符串、注释、CSS 与展示文字不作为 JS 字段访问证据。
`get/list/val` 辅助读取与 `Object.entries` 回调也使用同一绑定表，只绑定实际声明的条目参数，
不把名字恰为 `data` 的无关变量当作条目；回调闭包、参数遮蔽、重新赋值和嵌套对象遵守相同边界。
这是静态补充扫描，不执行任意前端代码或外部 import；无法推导的动态结构继续依赖声明、初始数据
及既有扩展数据读写机制，不按字段名黑名单或压缩代码体积过滤。

## 卡内数据桥

转换卡自带的 TavernHelper 脚本在正常环境中只作为卡级注册桥：携带模板、layout、卡标识和能力需求，通过 `window.__mvu2shujukuRuntime.registerCard(...)` 交给扩展。扩展确认接管后，桥立即退出，不再安装自己的 Mvu、事件或写库状态机。

新生成脚本不再携带旧运行时。扩展未加载时每秒重试登记，约十秒后显示安装或启用扩展的提示；登记异常显示失败提示并重试，拒绝登记则停止。iframe 卸载及重复执行会清理旧定时器和提示。登记成功表示 payload 已接收，不代表初始化与持久化已经完成。转换卡需要 MVU转数据库扩展运行。

历史桥兼容用例使用冻结的 `test/legacy/bridge-v0.3.17.js`，新桥用例直接执行本次转换产物。表格投影和写入仅由扩展的共用 codec/writer 执行。

历史 v0.3.15–v0.3.17 桥通过 `createBridgeLifecycle` 管理定时器、自己的事件订阅及 API 调用，向宿主登记退出控制器。扩展创建注册表时同步停止这些桥，取消尚未提交的快照并结算 false，清理监听与全局入口；等待已发出的 API 和写批次 finally 结束后才执行 main。等待期间新薄桥仍可登记 payload，不启动兼容状态机。支持 unregister 的 SP 回调会解绑，不支持解绑的旧宿主回调通过停止守卫失效。这些历史桥在未被接管时仍有旧兼容事件流程；扩展接管后仅扩展运行时活动。此前已生成的桥没有退出协议，需要重新转换，不能宣称旧脚本能被自动排空。已发出的调用不回滚；若宿主调用一直不结束，扩展接管会等待，不超时强行并发启动。

卡内桥随角色卡嵌入，无需另行导入酒馆助手脚本包。

## 脚本保留与删除边界

只自动删除：

- 已知、路径可确认的 MagVarUpdate / MVU-offline 引擎 bundle。
- 整段可证明仅含允许的 import、Schema 声明和注册调用的 `registerMvuSchema(...)` 脚本。出现定时器或其他顶层业务时保留整段；未知大 bundle 不按体积删除。

必须保留：

- 调用 `Mvu.*`、`getVariables`、`updateVariablesWith` 的用户业务脚本。
- 用户自己的定时器、开局、倒计时、前端和事件处理脚本。
- 保存到 SillyTavern 后，酒馆助手可能在角色创建事件后回写旧脚本面板快照。保存流程必须先刷新角色列表，再用 `extensions.mvu2shujuku.convertedAt` 精确确认新卡，通过 ST 官方 `writeExtensionField(characterId, 'tavern_helper', value)` 重申最终脚本。不得只按角色名覆盖，也不直接修改其他角色。
- 无法离线证明是引擎的未知 import。
- 仅负责隐藏 `<UpdateVariable>` / `<initvar>` 的空替换正则。
- 仅名称含“完整变量”等字样、内容没有 MVU 输出证据的普通正则。

未知脚本应进入转换报告，不能为了“接管完整”冒险删除。
输入按内容识别 PNG 与 UTF-8 JSON（含 BOM）。转换结果保存源格式和源角色头像；刷新、合并和保存保留该身份。保存前刷新失败直接中止；进入异步保存后使用捕获的结果，避免 UI 切换导致卡、模板和头像串用。数据桥下载读取 JS 文件产物。

正则仅删除替换体整体为纯旧快照宏的规则，匹配目标、MVU API 与控件不作为删除证据；保留前端的格式化宏接入数据库入口。世界书删除要求完整静态规则文档或明确的输出专名/纯快照形态；业务 EJS、非专名混合内容及解析失败的规则保留并报告。`protectFrontendEjsLiterals` 只处理 script 内已知的 EJS 标签检测正则；转换时处理卡内正则，扩展在每次 `prompt_template_prepare` 的 render 上下文注册临时 HTML 正则以处理动态加载内容。回调检查当前转换卡和聊天身份，普通卡、生成阶段及过期会话不处理；不修改楼层原文或远端资源。


## EJS 与宏

- SillyTavern 宏（如 `<user>`、`{{user}}`）必须调用当前上下文的原生宏替换接口，不把原始宏字面量写入表格。
- MVU/TH `{{format_message_variable::路径}}` 必须改为 EJS 惰性数据库读取：标量输出本值，对象/数组输出 YAML，递归排除 `$` 前缀键。此规则同时用于世界书正文与表格 `note/check`。
- EJS/宏读取顺序必须与前端一致：待写快照 > SP 已提交回调 > 完整运行时表 > 持久化帧 > 结构骨架。不得无条件优先使用 checkpoint；持久化帧缓存键必须包含内容指纹，不能只用 JSON 长度。
- 表格 `sourceData` 不经过普通世界书处理链。规则中的只读宏需改为 EJS 惰性调用；`promptOnly + WORLD_INFO` 静态查找正则需迁移成运行时 helper，并继续读取原正则的启用状态。
- 正则 replacement 中的 `{{random...}}`、`{{getvar...}}` 等仍在每次生成请求时调用原生 `substituteParams`，不得在转换时求值并冻结。
- 只替换初始值字符串和动态业务键，不改写固定 schema 组名/列名。
- EJS 默认保留 JavaScript 控制流，只将可识别的 MVU `stat_data` 读取改为 `mvu2shujukuGetAllVariables().stat_data`。
- 调用改写先遮蔽字符串、注释与正则字面量；模板字符串只改写 `${...}` 内的真实代码，保留静态文本。
- 旧前端若直读 `getChatMessages(...)[0].data.stat_data`，运行时在消息浅副本上投影数据库当前状态。不修改宿主消息对象，同步/异步 `getChatMessages` 均须兼容，切卡时必须还原原函数。
- 消息副本同时投影 `stat_data` 与 `display_data`：很多旧状态栏优先使用 `display_data || stat_data`，而空对象也是 truthy。对只在 DOMContentLoaded 执行一次 `await getChatMessages` 的内联状态栏，转换时在首次读取前等待带转换器标记的投影 shim。
- EJS 输出标量（如 `<%- data.字段 || '默认值' %>`）只在原世界书渲染时有意义，不得参与静态 `enum` / `range` / DDL / 表格 note 推导。否则 JS 局部变量会离开原 EJS 作用域并在填表阶段报错。
- 完整字面路径 `getvar('stat_data.组.字段', options)` 必须迁移为 `mvu2shujukuGetMessageVar` 安全取值并保留 `defaults`；不得展开成连续属性访问，因为 InitVar 不一定包含规则或旧世界书引用的所有顶层组。
- `mvu2shujukuGetAllVariables` 与 `mvu2shujukuFormatMessageVariable` 通过 `EjsTemplate.defines` 注册；不依赖页面全局变量自动穿透严格 EJS 沙箱。
- 填表插件会对组装后的整份提示单独调用 `evalTemplate`；任意 EJS 错误都会使它回退到整份原文。因此转换器 helper 既要注册到同源窗口的 `defines`，也要在 `prompt_template_prepare` 事件中注入实际上下文；对包含转换器 helper 但未传 context 的直接调用，还要通过受限的 `evalTemplate` 桥显式执行 `prepareContext`。不含转换器 helper 的模板必须原样委派。
- 只有开启实验选项且能证明为单字段简单条件时，才翻译为数据库 `<if db>`。动态路径、循环、异步、副作用和复合分支一律保留 EJS。

完整 JSON 容器选项在规则推导后由 `schema-layout.js:preserveJsonContainers` 合并同一顶层容器的表；
它复用已有完整 JSON 布局/编解码，不增加另一套状态存储。界面显式选择，Node `jsonContainers` 可
按顶层组名限定范围。逻辑数据和原路径规则保留，物理子表及其关联定位提示不再生成。
