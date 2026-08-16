# MVU 转换与兼容清单

> 适用于 MVU转数据库 v0.2.9。本文用于说明哪些 MVU 内容可以转换、哪些运行时行为由兼容层接管，以及当前无法等价模拟的边界。

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

Zod/TS 替代写法的字段基础类型不作为唯一建表依据；实际表结构仍综合 `[InitVar]`、规则和前端字段使用推导。

**不模拟：**MVU Zod 的运行时 Schema 调和及 `_for_zod` 私有事件。转换后由 SQLite 约束、表格提示词和写库校验承担相应职责，但不与原 Schema 调和机制完全等价。

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
- `message` / `chat` / `character` / `global` 作用域统一映射到当前聊天数据库，不是四套相互隔离的变量存储。

## 7. MVU 事件

**支持：**

- `VARIABLE_INITIALIZED`
- `VARIABLE_UPDATE_STARTED`
- `COMMAND_PARSED`
- `SINGLE_VARIABLE_UPDATED`
- `VARIABLE_UPDATE_ENDED`
- `BEFORE_MESSAGE_UPDATE`

兼容内容包括：

- 官方参数顺序
- 异步监听器
- `COMMAND_PARSED` 中修改命令路径和值
- 删除原命令
- 追加新命令
- `VARIABLE_UPDATE_ENDED` 中继续修正变量
- 初始化事件的 `swipe_id`
- 避免同一总线重复广播

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
- EJS 中数据库数据读取
- 世界书 `getwi` 等非 MVU 逻辑保留

**部分等价：**静态简单条件可选转为数据库条件；复杂 EJS 保留代码，只替换能安全识别的数据来源。`getMessageVar/setMessageVar` 只在首参数明确为 `stat_data` 字面路径时切到数据库；通用 `setvar` 还必须明确且仅指定 `{ outscope: 'message' }`。动态路径、其他作用域及带 `flags/results/withMsg` 等额外语义的调用保持酒馆助手原行为并提示核对，不按字段名猜测改写。

## 9. 酒馆助手脚本

**支持：**

- 保留调用 `Mvu.*` 的用户业务脚本
- 保留普通 JavaScript 脚本
- 保留未知外部 `import`
- 为缺失类型的正常脚本补 `type: "script"`
- 删除确认属于 MVU 引擎本体的脚本
- 删除纯 `registerMvuSchema(...)` Schema 注册脚本
- 不因文件名或 URL 中简单出现 `mvu` 就删除
- 混合了剧情/EJS 与 `<UpdateVariable>`/`<JSONPatch>` 的世界书条目完整保留，更新块仍由数据桥执行
- 仅删除可确认属于初始化或纯 MVU 变量输出管线的世界书条目

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

- MVU Zod 私有事件
- 原 MVU Schema 的运行时自动调和
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
