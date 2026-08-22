# MVU 转换与兼容清单

> 适用于 MVU转数据库 v0.3.1。本文用于说明哪些 MVU 内容可以转换、哪些运行时行为由兼容层接管，以及当前无法等价模拟的边界。

这不是对任意 MVU 角色卡“零风险完全兼容”的承诺。转换器会尽可能保留无法静态确认的业务脚本，并在转换报告中列出需要人工核对的项目。依赖 MVU 私有内部状态、未知外部脚本或复杂动态 EJS 的卡，转换后仍应实际测试。

## 兼容等级

| 标记 | 含义 |
| --- | --- |
| 支持 | 可自动转换或由数据库兼容层接管，并有自动化测试覆盖 |
| 部分等价 | 主要使用方式可用，但数据库模型与原 MVU 存在明确语义差异 |
| 不模拟 | 不会伪造等价行为，需要改卡或人工处理 |

## 1. 初始化数据

**支持：**

- `[InitVar]` 世界书条目
- 问候语中的 `<initvar>` 数据
- 多开场白分支独立初始化
- YAML、JSON、JSON5
- YAML merge key、块标量、注释
- `[值, 描述]` 类型
- 对象、数组、嵌套对象、动态字典
- 空对象、空数组、`null`
- 布尔值、数字、字符串
- SillyTavern 宏，例如 `<user>`
- 初始化数据中的动态键名
- 初始化宏替换后的键名冲突检测

## 2. 数据结构转表

**支持：**

- 单例对象 → 单例表
- 动态字典 → 行表
- 标量字典 → 键值行表
- 数组 → 有序子表
- 嵌套数组 → 关联子表
- 嵌套动态字典 → 关联子表
- 固定嵌套对象 → 展平为列
- 无法可靠展开的任意对象 → 整组 JSON 表
- 未声明的动态字段 → `_扩展数据`
- 关系子表通过 `实体名_键名` 关联原表
- 多层关系子表保留完整祖先键链，并以联合键隔离不同上级中的同名子项
- 表名、列名拼音转换与重名消歧

## 3. MVU 结构声明与约束

**支持**从 `[mvu_update]`、`[MvuUpdate]` 等条目提取：

- YAML 式 `type` / `format` / `check` / `enum` 声明
- 嵌套 `z.object({...})` 中的组名和字段路径
- `z.number().min(...).max(...)` 数值范围
- `z.enum([...])` 枚举值
- `.describe(...)` 字段描述
- Zod/TS 替代写法中 `/** check: ... */` 的规则注释
- 组级规则
- 组级 `note` 及其中可安全惰性求值的 `{{getvar::...}}` / EJS 宏；引用原 EJS 局部变量的动态输出值不用于静态 Schema/枚举推导
- 通配路径结构提示

可转换为：

- SQLite 字段类型
- `NOT NULL`
- `DEFAULT`
- `CHECK`
- `BETWEEN`
- 枚举 `IN`
- `json_valid`
- 表格填写提示词

Zod/TS 替代写法的字段基础类型不作为唯一建表依据；实际表结构仍综合 `[InitVar]`、规则和前端字段使用推导。同名字段在整份 Schema 中类型唯一时，可作为压缩/对象复用 Schema 的安全类型兜底；存在类型冲突时不猜测。

**部分等价：**兼容层按 MVU 源码顺序派发 Zod 专用阶段事件，因此保留的 `registerMvuSchema(...)` 业务脚本可继续过滤命令并修正更新结果。数据库不保存 MVU 原生 `schema` 树，未通过更新周期的直接表格编辑仍不等价于 MVU Schema 自动调和。

## 4. MVU 更新命令

**支持**裸命令以及位于 `<UpdateVariable>` 中的命令：

- `_.set(path, value)`
- `_.set(path, oldValue, newValue)`
- `_.add(path, delta)`
- `_.insert(path, value)`
- `_.insert(path, keyOrIndex, value)`
- `_.assign(...)`
- `_.delete(path)`
- `_.delete(path, keyOrIndexOrValue)`
- `_.remove(...)`
- `_.unset(...)`

`move` 当前用于 JSON Patch，不作为 `_.move(...)` 文本命令解析。

其中包括：

- 数值增减
- 日期毫秒增减
- 数组追加
- 数组按下标插入、删除
- 数组按值删除
- 对象合并
- 对象按键插入、删除
- 对象按顺序序号删除
- VWD `[值, 描述]` 更新
- 数值字段类型转换
- 更新原因记录
- 命令执行前的 `substitudeMacros`

## 5. JSON Patch

**支持** `<JSONPatch>`、`<json_patch>`，也支持嵌套在 `<UpdateVariable>` 中：

- `replace`
- `add`
- `insert`
- `remove`
- `move`
- `delta`

同时提供 JSON 修复容错。

开场分支中同楼的 `<initvar>` 与 `<UpdateVariable>/<JSONPatch>` 会按 MVU 原顺序合并后一次性写入最终初始化快照；没有 `<initvar>`、只含 JSON Patch 的开场同样支持。整体替换对象时会保留其中下划线开头的业务键（如 `_基础`）；直接把更新路径指向 `_` 字段仍按兼容层的内部字段保护策略跳过。重进已有 checkpoint 不会重放历史更新块。

## 5.1 表格提示词中的酒馆宏与世界书正则

**支持：**

- `[mvu_update]` 规则中的只读 SillyTavern 宏在每次生成请求时动态解析，例如 `{{getvar::...}}`、`{{user}}`、`{{random...}}`。
- 作用于 `WORLD_INFO` 的 `promptOnly` 正则（是否执行按生成时的启用状态决定）。
- 静态查找式对应的正则启用/禁用状态在运行时读取，因此卡内脚本动态切换正则仍可生效。
- replacement 中的捕获组与酒馆宏；原正则继续保留，不影响未迁移的世界书内容。

**需人工核对：**查找式本身依赖运行时宏、使用 `trimStrings`，或无法编译的 WORLD_INFO 正则。

## 6. Mvu 公共接口

**支持：**

- `Mvu.events`
- `Mvu.getMvuData`
- `Mvu.replaceMvuData`
- `Mvu.parseMessage`
- `Mvu.setMvuVariable`
- `Mvu.getMvuVariable`
- `Mvu.getRecordFromMvuData`
- `Mvu.getCurrentMvuData`
- `Mvu.replaceCurrentMvuData`
- `Mvu.reloadInitVar`
- `Mvu.isDuringExtraAnalysis`

**部分等价项：**

- `reloadInitVar` 从转换后的初始数据库模板恢复。
- `isDuringExtraAnalysis()` 当前固定返回 `false`。
- MVU 的 `MvuData.stat_data` 在转换卡中映射到当前聊天数据库；TavernHelper 的
  `chat` / `character` / `global` / `preset` / `script` / `extension` 作用域仍是彼此独立的原生存储。

## 7. MVU 事件

**支持：**

- `VARIABLE_INITIALIZED`
- `VARIABLE_UPDATE_STARTED`
- `COMMAND_PARSED`
- `SINGLE_VARIABLE_UPDATED`
- `VARIABLE_UPDATE_ENDED`
- `BEFORE_MESSAGE_UPDATE`
- `COMMAND_PARSED + "_for_zod"`
- `COMMAND_PARSED + "_ended_for_zod"`
- `VARIABLE_UPDATE_ENDED + "_for_zod"`
- 对外事件 `mag_invoke_mvu`
- 对外事件 `mag_update_variable`

兼容内容包括：

- 官方参数顺序
- 异步监听器
- `COMMAND_PARSED` 中修改命令路径和值
- 删除原命令
- 追加新命令
- `VARIABLE_UPDATE_ENDED` 中继续修正变量
- 初始化事件的 `swipe_id`
- 避免同一总线重复广播
- 按 MVU 源码顺序让普通命令监听先于 Zod 过滤阶段执行
- 在数据库就绪前先发布 `Mvu` 全局外观
- 调用 TavernHelper `initializeGlobal('Mvu', ...)` 并发送 `global_Mvu_initialized`
- 仅对 `waitGlobalInitialized('Mvu')` 返回已就绪的兼容对象；其他全局名称仍由 TavernHelper 原函数处理，切换非转换卡时恢复

**部分等价：**`BEFORE_MESSAGE_UPDATE` 对 `context.variables` 的修改会落库，但对 `context.message_content` 的修改暂不反写聊天正文，避免在消息事件内再写楼层导致递归。

## 8. 前端和 EJS

**支持改写或兼容：**

- `getvar(...)`
- `getVariables(...)`
- `getAllVariables()`
- `TavernHelper.getVariables(...)`
- `getMessageVar('stat_data.…', { defaults: … })`
- `setMessageVar('stat_data.…', value)`
- EJS 裸上下文 `variables.stat_data`
- `setvar('stat_data.…', value, { outscope: 'message' })`（仅默认写入/返回语义）
- `Mvu.getMvuData(...)`
- `stat_data` 直接访问
- `_.get`
- `_.has`
- 点号路径
- 方括号路径
- `[0]` VWD 取值
- `if / else if / else`
- `Object.keys`
- 动态字典遍历
- 状态栏数据读取
- `<StatusPlaceHolderImpl/>`
- `VARIABLE_UPDATE_ENDED` 驱动刷新
- SP 自动填表回调转发为 `VARIABLE_UPDATE_ENDED`（含晚加载和聊天切换后重注册）
- 对未监听 `VARIABLE_UPDATE_ENDED` 但提供“刷新数据”控件的同源状态栏，SP 自动填表提交后触发其原生重读，不重载整个前端或楼层
- 前端在 SP 回调后立即重读时，短暂使用回调的已提交快照，避免 replay/物化窗口内又读到旧运行时
- 对未监听 MVU 更新事件的旧式 `body.load(...)` 整页前端，保留可重载入口；可从魔法棒菜单点击“刷新转换卡前端”手动重读，表格写入不再自动重载整页
- EJS 中数据库数据读取
- 世界书 `getwi` 等非 MVU 逻辑保留

**部分等价：**静态简单条件可选转为数据库条件；复杂 EJS 保留代码，只替换能安全识别的数据来源。`getMessageVar/setMessageVar` 只在首参数明确为 `stat_data` 字面路径时切到数据库；通用 `setvar` 还必须明确且仅指定 `{ outscope: 'message' }`。动态路径、其他作用域及带 `flags/results/withMsg` 等额外语义的调用保持酒馆助手原行为并提示核对，不按字段名猜测改写。

## 9. 酒馆助手脚本

**支持：**

- 保留调用 `Mvu.*` 的用户业务脚本
- 保留普通 JavaScript 脚本
- 保留未知外部 `import`
- 纯外部 Schema import 仅在脚本名、Schema URL 和“只含 import”三重信号同时成立时删除；带业务代码的混合模块保留
- 为缺失类型的正常脚本补 `type: "script"`
- 删除确认属于 MVU 引擎本体的脚本
- 删除纯 `registerMvuSchema(...)` Schema 注册脚本
- 不因文件名或 URL 中简单出现 `mvu` 就删除
- 混合了剧情/EJS 与 `<UpdateVariable>`/`<JSONPatch>` 的世界书条目完整保留，更新块仍由数据桥执行
- 仅删除可确认属于初始化或纯 MVU 变量输出管线的世界书条目

TavernHelper 变量作用域不会被统一改成数据库：仅默认/消息作用域的 `stat_data` 由数据库接管；动态正则使用的 `chat` 变量、脚本/扩展/角色/全局变量均保留原生读写。消息变量中与 `stat_data` 并存的辅助键也会保留。

已知可识别引擎包括：

- `MagicalAstrogy/MagVarUpdate`
- `NLKASHEI/MVU-offline`

未知 MVU 镜像默认保留，并在转换报告中提示核对。“保留”表示转换器不会误删脚本，不代表无法读取源码的外部脚本已被自动验证兼容。

## 10. 数据库读写与持久化

**支持：**

- `stat_data` 从数据库表实时重建
- 单元格更新
- 同行多字段合并 `updateRow`
- 新行插入
- 行删除
- 数组顺序重写
- JSON 对象整列写回
- 动态字段写入 `_扩展数据`
- 写后立即读一致
- 首楼替换/删除后的开局连续性保护
- 多分支开场重新注入
- V2 checkpoint 与 mutation log 正常持久化
- 避免无差异回声写循环
- 避免每个字段单独产生一次昂贵持久化

## 11. 当前不做等价模拟的部分

**不模拟：**

- 原 MVU `schema` 树在数据库中的持久化，以及对手工表格编辑的 Schema 自动调和
- 额外模型分析轮次
- 四套独立的 message/chat/character/global 变量存储
- `BEFORE_MESSAGE_UPDATE` 对正文的反写
- 无法静态读取源码的外部脚本内部行为
- 依赖 MVU 引擎内部未公开状态或私有函数的脚本

## 转换后建议验证

对复杂角色卡，建议至少检查：

1. 新建聊天后表格是否按当前开场分支正确初始化。
2. 状态栏、EJS 世界书和用户业务脚本是否能读到数据。
3. AI 回复中的 `<UpdateVariable>` / JSON Patch 是否正确落表。
4. 切换开场白、重生成、删除/替换首楼和刷新聊天后，数据是否仍一致。
5. 转换报告的“需人工处理”和“警告”是否已逐项核对。
