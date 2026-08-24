# MVU转数据库（SillyTavern 扩展）

把 **MVU 变量角色卡**（MagVarUpdate / `[InitVar]` + `stat_data`）转换为 **SP·数据库** 角色卡的 SillyTavern 原生扩展。

转换器是**通用**的：所有结构推导与规则转换都来自 MVU 框架本身，不依赖任何特定角色卡；转换产物包括：

- 新的角色卡（卡名自动追加 `_数据库` 后缀；可直接保存进酒馆，或下载 JSON/PNG）
- 表格模板 JSON（开局自动建表，不需要手动导入）
- 转换报告（Markdown：自动转换项 / 需人工项 / 警告）

本版变更见 [更新日志](CHANGELOG.md)；详细支持范围、运行时兼容接口与已知边界见 [MVU 转换与兼容清单](COMPATIBILITY.md)。

转换器只会整条删除可确认属于 `[InitVar]` 或纯 MVU 变量输出管线的世界书条目。若条目同时包含剧情、EJS 和更新块，会完整保留；其中 `stat_data` 的 `getMessageVar/setMessageVar` 调用由数据库兼容函数接管，其他消息变量仍按酒馆助手原语义运行。

## 安装

1. 前提：已安装 **SP·数据库** 插件。
2. 在 SillyTavern 的 **Extensions 面板 → Install extension** 里粘贴本仓库链接：

   `https://github.com/wmdl2/mvu2shujuku`

   后刷新页面。
3. 重启 / 刷新 SillyTavern，设置面板出现「MVU转数据库」。

转换器**不会自动安装数据库插件**，默认你在已有插件的情况下使用。

## 使用

1. 打开扩展设置面板，选择输入：当前角色卡，或文件选择器（支持 `.json` / `.png`）。
2. 点击转换：
   - **保存角色卡和模板到sillytavern**（转换完成后才出现）：把角色卡写入 SillyTavern 角色列表（自动带原头像），
     并同时把表格模板存为 SP·数据库 插件的“全局模板预设”（预设名 = 卡名 + `模板`）；
     开局进入新聊天会自动建表，无需手动切换；预设仅作备用。失败会弹窗显示日志，
     角色卡部分失败时自动回退下载；
   - 或下载 角色卡 + 表格模板 + 转换报告。另有“数据桥源码（仅供调试）” `.js` 备份；数据桥已内嵌到转换后的角卡，无需导入，该 `.js` 也不是酒馆助手的 `.json` 导入包。

 > 如果卡片既没有 `[InitVar]` 世界书条目，问候语/其它世界书条目中也没有可解析的 `<initvar>` 分支（不是 MVU 变量卡，或 initvar 缺失），转换会**明确中止**并提示原因，不会产出残缺的转换结果。无 `[InitVar]` 但问候语含 `<initvar>` 时，转换器会以首个含 `<initvar>` 的分支为结构与初始值基准继续转换。

> 模板统一按双模式生成（DDL 与 SQL 示例同时写入）。AI 填表时实际输出
> `insertRow/updateRow/deleteRow` DSL 还是 SQL，由 SP·数据库 插件自身的填表模式设置决定，
> 转换器不需要也不提供单独的 native/sqlite 选择。

### 合并数据库现有表格模板
转换完成后，可在扩展面板选择 SP·数据库 插件里的模板来源（当前聊天模板 / 全局模板 /
全局预设），加载出表列表后勾选要并入的表，点「合并到转换结果」：
选中表会并入转换生成的模板并重新转换（角色卡内嵌模板、数据桥、报告同步更新）；
重名表自动跳过；合并后可用「保存角色卡和模板到sillytavern」保存。

### 重用转换配置

新卡无需增加操作：下载转换后的角色卡/表格模板，或保存到 SillyTavern 时，扩展会以原角色卡名自动保存转换配置。只有已存在同名配置时才需选择替换或重命名。重新转换原卡或更新版卡时，可在「转换配置」下拉中主动选择旧配置。

外部表只记录来源（当前聊天/全局/指定全局预设）和表身份，不复制完整表。再次应用时会从来源读取最新版；来源被删除、表消失或表名冲突时会跳过并在摘要中说明。SP v8.9.2 没有公开读取其内部默认模板的 API，因此不把它列为可选来源。

转换器会先生成新卡的基础模板再校验所选配置。正常匹配不增加操作；当大部分表对不上、外部来源不可用或有同名冲突时才弹出摘要确认。取消后本次不应用该配置，后续下载/保存也不会覆盖它。

## 转换逻辑

### 表格生成
- 解析 `[InitVar]`：官方 JSON5 + `[值, "更新条件"]` 叶子、YAML 子集、`<initvar>`/代码块包裹、多条目深合并；按 MVU 官方源码处理对象 `$meta`、数组 `$arrayMeta`/魔法标记、`extensible`、`recursiveExtensible`、`required` 与 `template`，并在建表前清理所有保留元数据。
- 顶层键 → 组；按结构推导表种类：组自身有直接标量字段=单例表、条目字典=行表、固定嵌套对象=用 `_` 递归展开、
  动态字典=子行表（行条目内使用「具体实体_键名 + 键名」关系表）、嵌套数组=有序子表；
  动态字典 `type` 若声明 `[物品名称: string]` 之类索引签名，行表会使用“物品名称”作为业务键列名；未声明时才回退为“键名”。
  所有嵌套派生表按完整路径用 `_` 命名，如 `寻缘蝶_功法表`。
  混合字符串、数字、布尔与 `null` 的标量字典使用 JSON 标量列，读写不会把实际类型统一转成文本。
  更新规则按完整路径单一归属：能确定属于派生表的规则迁入派生表；无可靠路径的自由文本保留在来源实体表，不重复、不按关键词猜测。
  `${A|B}`（兼容 `${A/B}`）模板键下的规则会逐项展开，固定容器的整体 `check` 会传递到真正承载数据的子表。
  只有结构未知/脚本私有状态和 `_扩展数据` 保留 JSON 逃生舱。
- 列来源：`[MvuUpdate]` 结构声明 > 状态栏/脚本成员访问扫描 > initvar 实际字段。
- 中文组名/字段名 → **拼音标识符**（内嵌 pinyin-pro 字典，与插件内部一致），DDL 注释保留中文。
- `[MvuUpdate]` 中的 `range` → `CHECK`、枚举 → `CHECK IN`、`format`/`check` → note、`_强制更新提醒` → “每次回复必须维护”。所有范围/枚举/格式均来自卡片自身规则。

### 数据桥（写入卡内 tavern_helper 脚本）
- **开局自动建表（对应 MVU 的 init 时机 → SP·数据库 的初始化）**：转换时把模板以 base64
  写入世界书条目 `__ACU_TEMPLATE_DATA__`，不改动开场白（纯文字开场白也能用）。
  扩展本体与卡内数据桥在进入聊天/首条消息时，若按模板表名检测到缺表，就调用
  `initGameSession({ injectTemplate:true, loadPreset:false, templateData })` 建表并写入初始行；
  已有表格的聊天不会被重置。若卡的开场白脚本会切换/重写首楼（如“重塑仙缘”类开局流程）
  而打断插件初始化，会自动轮询重试（约 1 分钟内）直到建表成功。
- 保存角色卡时仍会顺带把模板存为插件“全局模板预设”，可在插件模板面板手动切换备用。

### MVU 更新规则 → 填表提示词
`[MvuUpdate]` 的规则会写入模板 note（即插件注入给填表 AI 的提示内容）：
`range` → CHECK 约束与【强制约束】、枚举 → CHECK IN、`format`/`check` → 【强制约束】、
`_强制更新提醒` → “每次回复必须维护”。填表 AI 会按这些规则决定何时增改删。
- `getAllVariables()` shim：数据库表格 → `stat_data` 嵌套形状（含 `[值,条件]` 还原、`display_data` 镜像）——**状态栏 HTML 不用改**。
- `Mvu.getMvuData / Mvu.replaceMvuData` 兼容层：旧脚本 diff 写库。
- 运行时解析 `<UpdateVariable>` / `<json_patch>` 块（`_.set/add/remove/assign`、JSON Patch）写库；开场同楼的 initvar 与更新块按 MVU 顺序合并为最终初始化快照。
- **问候语 `<UpdateVariable>` 覆盖初始值**：MVU 允许额外问候语里的更新语句覆盖 `[InitVar]`；
  转换后桥脚本在开局建表完成后再应用开场白里的更新块，等效于 MVU 的覆盖行为。
- **命令与显示兼容**：`_.set`（双参/三参 `old,new` 两种格式）、`_.assign`（对象合并/按键赋值）、
  `_.remove/unset/delete`、`_.add`（数值加法带精度处理、日期字符串按毫秒推进转 ISO）；
  `display_data` 在会话内保存 `旧->新(原因)` 镜像（与 MVU 的 display 字符串同格式）。
- 公开 MVU 更新事件链由兼容层接管；`COMMAND_PARSED` 监听器可改写或追加命令，`VARIABLE_UPDATE_ENDED` 携带更新前后的完整 `MvuData`。具体参数语义和边界见兼容清单。
- 数据桥同时提供 `TavernHelper.getVariables()` shim，兼容教程中「纯文本状态栏」的读取写法。
- 对只在首次挂载时调用一次 `getVariables({type:'message'})` 的内联开场前端，转换器会等待数据库变量 shim 就绪后再启动，避免选项列表在异步建表窗口读空。

### 卡片清理
- **删除** `[InitVar]`、可确认已迁移的结构更新规则，以及明确包含 `<UpdateVariable>`、`<JSONPatch>`、写入命令或纯状态快照的变量输出条目；
  仅移除解析 MVU 语法的正则与 MVU/ZOD 脚本。
- **误标保护**：带 `[mvu_update]` 标记但内容实为剧情/设定文本的条目（如部分“技能化”卡）
  会保留——`format_message_variable`、`get_message_variable` 和 `getvar(stat_data...)` 都只是读取变量，不作为整条删除证据；删除判定要求明确的写入/输出管道。
- `[mvu_plot]` 剧情条目全部保留，内部 `{{get_message_variable::…}}` 宏改写为数据库表引用。
- EJS 的完整 `getvar('stat_data.组.字段')` 使用安全数据库路径读取；缺少任意中间组时返回 `undefined`，原有 `{ defaults: ... }` 继续生效。
- **非 MVU 内容逐字节保留**（状态栏、data_block 显示、普通世界书等）；
  开场白保持原样（不注入任何脚本，纯文字开场白同样可用）。
- **世界书独立**：内嵌世界书名称与外部世界书引用会追加 `_数据库` 后缀，避免导入转换卡时同名覆盖原卡世界书。

### EJS 条件重写
**EJS 整体保留，只改数据读取位置**：提示词先经 st-prompt-template 渲染 EJS、再由
数据库插件解析 `<if>`。因此世界书里的 EJS（`<% if %>`、`<%_ if %>`、else-if 链、
循环、函数调用、`<%- %>` 输出等）原样保留，只把 MVU 的数据读取
`getvar('stat_data.路径')` / `getvar("stat_data").组.字段` / `_.has(getvar("stat_data"), …)`
改写为 `mvu2shujukuGetAllVariables().stat_data.路径`。转换器同时识别常见的
`getAllVariables().stat_data`、`allVariables().stat_data`、`all_variables.stat_data` 与
`TavernHelper.getVariables().stat_data`。扩展和卡内数据桥都会把该函数注册进
st-prompt-template 的模板上下文（`EjsTemplate.defines`），因此只导入转换卡时也可读取，并用卡内布局 +
插件表格**惰性重建** stat_data（每次调用实时读表，数据只存一份、无冗余同步、不依赖卡内桥）。
唯一名字避免撞名；状态栏用的 `window.getAllVariables` 也由扩展提供。
仅在 EJS 条件中出现、不在 `[InitVar]` 里的字段（如分段阈值）也会补进列定义。
无法安全识别的动态读取会列入转换报告的「需人工处理」，不会静默误改。

设置面板可选开启“安全的简单 EJS 条件翻译”：仅将无 `else`、无嵌套、静态字段与
字面量比较的简单 `<% if %>` 转为数据库 `<if db>`；复杂分支、循环和函数仍保留 EJS。
该选项默认关闭，兼容层仍是主路径。

初始数据中的 `<user>`、`{{user}}`、`<char>` 等宏会在进入当前聊天后调用
SillyTavern 原生 `substituteParams` 解析；表名和固定列名不支持运行时宏。
表格提示词中的 `{{getvar::...}}` 等只读宏也会在每次生成请求时解析；作用于
`WORLD_INFO` 的 promptOnly 静态查找正则会迁移到表格提示链，并保留原正则的运行时启用状态。

## 目录

| 路径 | 说明 |
| --- | --- |
| `manifest.json` / `index.js` / `style.css` | 扩展本体（仓库根目录即扩展，可直接安装） |
| `src/mvu2shujuku.js` | 转换核心源码 |
| `src/pinyin-data.js` | 拼音字典（由 pinyin-pro 生成，MIT） |
| `build-extension.js` | 重新构建扩展文件 |
| `test/run-tests.js` | 自动化测试（无测试卡片时自动跳过卡片相关用例） |
| `CHANGELOG.md` | 面向用户的版本更新日志 |
| `COMPATIBILITY.md` | MVU 转换范围、运行时兼容能力与已知边界 |

## 开发

```bash
node test/run-tests.js                    # 全量测试：默认只输出数量和汇总
node test/run-tests.js --grep "桥|扩展"  # 只跑相关用例
node test/run-tests.js --verbose          # 诊断时显示每条用例和完整桥日志
node build-extension.js  # 重新构建扩展文件
```

默认模式会抑制通过用例的 VM/数据桥日志；用例失败时自动回放最后 20 条截断日志。也可使用 `TEST_VERBOSE=1` 开启详细模式。

## 许可

MIT（见 `LICENSE`）。`src/pinyin-data.js` 派生自 [pinyin-pro](https://github.com/zh-lx/pinyin-pro)（MIT）。本仓库不包含 SP·数据库 插件源码与任何角色卡内容。
