# 运行时、会话与持久化

[文档索引](README.md) · [开发验证](development.md)

本文描述当前有效实现；兼容承诺以[兼容清单](../COMPATIBILITY.md)为准。文中的仓库路径均相对仓库根目录。

## 扩展运行时

Node 核心惰性 require `table-codec.js`；`assembleExtension` 将同一工厂内联在核心之前，浏览器核心从构建时注册的工厂创建实例。模块不执行宿主读写或缓存选择，参数为 layout 与表快照；JSON 修复通过注入函数调用原有解析库。每次投影建立表名索引，重复表名仍取首次匹配；只读 content，不擅自把 seedRows 当已物化数据。任何模块修改都必须重新构建根目录 index.js。

差异规划与 CRUD 适配由 `table-writer.js` 承担，也通过工厂内联。主核心的 `writeStatDiffToDb` 和 `lastStatWriteFailed` 作为兼容入口委派给一个写入实例；日志、JSON 解析及缓存模板读取由主核心注入。模块本身不访问 window、不安装事件、不选聊天，也不发起宿主保存。调用方仍负责会话核验与串行写队列；失败状态按实例保存，不能跨并发批次把最后状态当逐次返回结果。JSON 组接受对象、数组及标量变化，不再凭空对象变标量推断默认回声；与数据库内容相同的重复值不再提交。兼容 API 没有可靠的用户操作/渲染来源标记，不能声称能自动区分两者。

扩展检测当前卡的 layout，安装完整 Mvu shim，处理：

- 当前开场分支的 `<initvar>` 与同楼 `<UpdateVariable>/<JSONPatch>` 按 MVU 顺序在内存合并，再以初始化快照落表。
- 后续 AI 楼层的更新块顺序执行并按聊天、来源消息对象、swipe、内容指纹去重；重进已有 checkpoint 只建立历史基线，不重放旧更新。

- 运行时表格读写。
- 聊天/角色卡切换隔离。
- 开局整表初始化和普通差量更新。
- MVU 标准事件与 TavernHelper 事件总线兼容。
- 首楼替换时的开局连续性。
- 前端 iframe 和 `body.load(...)` 页面的重挂载。

## MVU 兼容层

具体已支持接口及边界以[兼容清单](../COMPATIBILITY.md)为准。新卡仅使用扩展 shim；维护时验证轻量桥登记和历史桥退出交接，不再向历史桥复制新运行时逻辑。

核心原则：

- `Mvu.getMvuData` 返回包含 `stat_data`、`display_data`、`delta_data`、`initialized_lorebooks` 的 MvuData 形状。
- `Mvu.replaceMvuData` 是完整目标快照写入，在短窗口内合并后落库。
- `Mvu.setMvuVariable` 保持原版“路径不存在返回 false”的语义，不默认创建未知 schema 键。
- `reloadInitVar` 恢复转换模板的初始快照。
- `eventOn` 兜底遵循 TavernHelper 契约，返回带 `.stop()` 的监听句柄对象。
- 事件优先通过 TavernHelper `eventEmit` 总线发送，缺失时才回退 CustomEvent / SillyTavern eventSource，避免同一总线重复放大。
- `VARIABLE_INITIALIZED` 用于新聊天/完整初始化；`VARIABLE_UPDATE_ENDED` 只在数据实际改变后广播。
- SP 表更新回调是所有 CRUD、SQL、自动填表和回放变化的主通知入口。回调撞上批量写抑制窗口时必须保留最后快照并延迟重试，不能直接丢弃。
- `MESSAGE_DELETED/SWIPED/SENT/RECEIVED/UPDATED/EDITED` 与生成收尾是聊天历史变化的兼容兜底：记录事件前完整运行时指纹，等待事件后完整快照确实变化再广播；用聊天、角色和代次守卫取消跨聊天任务。不得在消息事件到达时立即读取仍未回放的旧表。
- 已确认的表变化统一广播 `VARIABLE_UPDATE_ENDED` 和 `shujuku-table-updated`，并驱动事件型前端、安全内联重读入口与精确刷新控件。自动路径不得调用 `body.load` 或 iframe reload；硬重载只允许魔法棒手动刷新。
- `parseMessage` / AI 更新周期的事件顺序以对应版本 MVU 上游 `src/function/update_variables.ts` 为基线，包含 Zod 专用的 `*_for_zod` 阶段。
- 接管 MVU `exported_events` 的 `mag_invoke_mvu` 和 `mag_update_variable`，不要只维护 `Mvu.*` 对象方法。
- 转换标记可确认时先发布 `Mvu` 外观；读写方法内部再等待 layout 与数据库 API，避免大卡前端的短超时检测误判。

## 初始化与运行时写入

### 初始化

- 开场快照经 MVU 事件链处理后可能恢复为旧式 `[值, 描述]` 叶子。在构造 `templateData` 时，只根据 layout 中 `col[1] === 'pair'` 的完整路径拆包；不得对所有长度为 2 的数组做启发式处理，否则会破坏真实数组/JSON 字段。

- 普通进卡由模板和 `initGameSession` 建立聊天数据库。
- 新聊天先在内存中把标准 `[InitVar]` 模板、当前开场分支的 `<initvar>` 及首楼 `UpdateVariable/JSONPatch` 合成为最终模板。缺表时只调用一次 `initGameSession`；表已存在时通过 `importTableAsJson` 提交一次持久化 `data_replace`，不再二次重载聊天。
- 内存模板适配器也必须实现数组原子导入；追平当前状态和应用新开场任一步失败都中止候选构造，不能将部分修改或旧快照交给真实持久化。
- 整页开局 UI 在短聊天中提交完整多组快照时走同一整表事务，不拆成数十次 CRUD。
- 整表提交后不比较原始稀疏 MVU JSON。候选模板与运行时表格必须先经同一 layout 反向投影成规范化 `stat_data`，再做确定性比较；数据库补默认值不应被误判为写入失败。
- 整表提交的成功以短稳定期内的运行时与 V2 持久化快照同时匹配为准；卡内重载使任一侧回退时，整份快照重试，不提前广播完成。`importTableAsJson` / `initGameSession` 已由 SP 严格保存，扩展外层不再重复调用宿主保存。
- `initGameSession` 后的已有聊天整表 `importTableAsJson` 不直接复用内嵌模板的 `sheet_*` key。候选快照先按显示表名重绑到 SP 当前运行时 key，保证 V2 checkpoint、指导表和后续 SQL 操作始终使用同一表身份。
- 转换后数据库 Schema 是唯一落库约束 owner。普通 `COMMAND_PARSED` 业务监听仍可改写命令；旧 `*_for_zod` 监听器仍按 MVU 顺序收到事件，但只操作隔离快照，不能删除已映射到数据库的命令或回滚落库结果。删除纯 `registerMvuSchema(...)` 内联声明；外部 import 只在“脚本名明确是 MVU Zod/Schema、URL 明确是 data/variable/mvu schema、整个脚本只有 import”三个信号同时成立时删除，带任何其他业务代码时保留。
- 删除纯 `registerMvuSchema(...)` 前，静态读取注册对象的安全 Zod 子集：`object/record/array`、基础类型、字面量默认值、枚举、描述和标准 `_.clamp`。解析器只解释 DSL，不 eval/import 卡内代码；自定义 transform/refine 或未知组合按完整字段路径进入人工检查。`clamp` 只提供范围提示与可选 DDL CHECK，不介入 SP 自动填表的写入/重填流程。
- 首份完整开场快照会开启初始化阶段；后续完整快照仍使用整表路径，直到兼容层真正开始处理首个 AI 输出。不使用任意墙钟超时，也不把开场流程预先创建的用户楼误判为阶段结束。
- 同一聊天最多接收 4 份不同完整快照作为异常循环保险；相同快照不重复初始化。聊天超出开场范围、开始处理 AI 输出或超过保险上限后，写入转入普通差量路径。

### 普通写入

1. `replaceMvuData` / `updateVariablesWith` 进入短防抖合并窗口。
2. 读取当前表格快照作为 `prev`。
3. 用 layout 过滤非当前卡组，并合并部分目标对象。
4. `writeStatDiffToDb` 计算差异，调用插件原生 CRUD；多步数组计划使用一次原子导入，详见下文。
5. 批量期间抑制每个 CRUD 的中间广播，整批成功落定后只发一次 MVU 更新事件。删除失败或插入返回失败值时停止后续写入；失败重试耗尽也不能广播成功或提交初始化指纹。
6. 无实际差异时不写库、不广播，防止前端回声循环。

TavernHelper 变量接口按作用域分流：默认/消息作用域中的 `stat_data` 映射到数据库；同一消息中的其他辅助键与数据库视图合并读写；`chat` / `character` / `global` / `preset` / `script` / `extension` 继续委派给 TavernHelper 原生存储。不得用数据库 `stat_data` 覆盖这些独立作用域。

持久化、checkpoint 和 V2 replay 由 SP·数据库插件管线负责。转换器不应重新引入手工物化、自制 checkpoint 或用旧快照覆盖运行时的逻辑。
写入批次按 Promise 队列串行执行，同表同行的单元格更新一次分组。核心返回值保留计划操作数量，是否失败须同时检查 `lastStatWriteFailed`，不能用数量当成功证明。CRUD 无事务回滚保证，部分失败后按实际表格重新计算差异重试。

消息更新块的任务同时绑定聊天代次、来源消息对象、索引和更新块指纹。事件处理、合并窗口、重试以及 API 调用前后都核验来源；删楼、编辑或切换 swipe 后取消旧任务。已经进入宿主的调用无法撤回，后续操作和成功广播必须停止。

已执行标记按消息对象、swipe 和更新块内容去重，不按楼层索引去重。同内容重生成是新回复，仍须执行；删去前面楼层引起索引移动，不应重复执行现有回复。重新加载聊天时以已有持久化历史重新建立基线。

SP 9.2.5 的手动 CRUD 追加到最近已有表帧的 AI 楼。消息中的 `UpdateVariable/JSONPatch` 使用一次 `importTableAsJson`，将最终快照持久化到最新 AI 回复，避免删除或重生成回复后旧更新仍留在首楼。构造候选期间数据库快照变化时重新规划；导入失败不降级为手动 CRUD，也不反向覆盖可能已经提交的帧。前端普通写入仍使用差量路径。

SP 9.2.5 的 native 模式不暴露 SQL getter。CRUD 写入以实际表格就绪和插件自身 provider/事务校验为准，不等待 `querySql` 或 `executeSqlQuery` 出现。

有序数组按位置规划更新、尾部追加和倒序尾删，保留未变行的标识、其他父级数据及未知列。一个数组操作使用原生 CRUD；多个数组操作合并到一次 `importTableAsJson`，调用前核对参与表的表头和内容仍与规划快照一致。缺少批量导入能力时在数组写入前失败，不降级为逐行破坏性替换。导入失败后不补偿回写旧全库快照：上游可能已经持久化而仅运行时恢复失败，应重新读取实际数据后重试。这个保证仅覆盖合并的数组计划，不代表混合标量 CRUD 的整个写批次具备事务性。

`node test/benchmark-diff.js` 衡量 100/1000/10000 行变更的 CPU 和 API 次数。规划阶段按表与键列缓存行索引；执行阶段仍以实际表定位，避免删除导致旧行号失效。

## 切卡、首楼替换与前端

- 插件切换聊天时异步加载运行时表；空窗期可能短暂看到上一张卡。读写必须核对当前 layout 与表名集合，不得把跨卡数据写入当前聊天。
- 异步任务捕获角色身份、群组、聊天及会话代次；准备、CRUD、保存的 await 边界和重试都核验原会话。旧 Mvu 方法引用不能向新会话写入。聊天状态集合使用角色与聊天的组合键。
- 写入入口与 CHAT_CHANGED 共用 `discardPendingStatWrite`：通知迟到也主动结算旧 Promise 为失败、取消防抖并清理共享读投影。迟到旧重试不得取消当前会话的有效批次；同会话仍共用防抖 Promise。
- 桥注册核对完整卡名/原名、布局、转换标识与当前卡模板；两个明确不同的头像不得仅因同名互认。旧桥缺转换标识时必须有当前卡模板佐证。
- 一些卡会替换或删除首楼。开局连续性必须在首楼变更前后保留已初始化数据，不得依赖“第一条消息永不变”。
- `body.load(...)` 前端使用 body 内 DOM 标记判断是否已挂载。body 被首楼重渲染清空后，下次正则执行应重新加载。
- 前端 HTML 会按数据读取信号标记为 event/direct/control/reload；刷新优先级为直接入口、MVU 事件、明确控件，最后才是用户主动操作时重载带标准标记的非主/宿主 iframe。普通 HTML 不标记，数据库写入不自动重载页面。
- 魔法棒手动刷新按 direct → event → control → reload 顺序处理：先调用直接入口并广播 MVU 事件，再点击未被占用窗口的精确刷新控件，最后才重载带标准标记的非主/宿主 iframe。
- 重生成会先删除旧 AI 楼层与状态栏 iframe，生成后 EJS/MVU 变量事件可能早于新 iframe 的 `eventOn` 注册。运行时保留最近一次更新载荷 10 秒，只在新 iframe 出现时补发一次，补发前先清除 pending 以防循环。
- 读侧判定 V2 replay 运行时就绪时，必须核对 layout 的全部表，并确认每张单例/JSON 表存在数据行。不得因任意一张表已有行就信任半物化快照。
- SP 自动填表完成后通过 `registerTableUpdateCallback` 通知扩展，扩展再广播 MVU 的 `mag_variable_update_ended`。回调必须在扩展晚加载、聊天切换和 SP 运行时重建后重申注册，且使用稳定函数引用交给 SP 去重。事件载荷必须优先由 SP 回调传入的已提交快照重建，不得在 replay/物化过渡窗口内丢弃快照、只同步重读运行时。
- SP 回调后立即刷新的前端，其 `getVariables()` 也必须在短窗口内读到同一份已提交快照。不能事件携带新 `after`，但前端紧接着又从尚未物化的 `exportTableAsJson()` 读回旧值。短窗口过期后应自动回归运行时/持久化重建。
- 旧式整页前端仅在用户从魔法棒菜单选择“刷新转换卡前端”时主动重载；数据库每次写入不得触发整页重载。

数组比较按位置进行，不是基于元素身份的最短编辑序列。导入承载完整运行时表快照；减少 API 调用不等于保证端到端耗时同比降低。性能证据集中记录于[差异基准](benchmarks/diff-2026-09-10.md)。
