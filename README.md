# MVU转数据库（SillyTavern 扩展）

把 **MVU 变量角色卡**（MagVarUpdate / `[InitVar]` + `stat_data`）转换为 **SP·数据库** 角色卡的 SillyTavern 原生扩展。

转换器是**通用**的：所有结构推导与规则转换都来自 MVU 框架本身，不依赖任何特定角色卡；转换产物包括：

- 新的角色卡（卡名自动追加 `_数据库` 后缀；可直接保存进酒馆，或下载 JSON/PNG）
- 表格模板 JSON（开局自动建表，不需要手动导入）
- 转换报告（Markdown：自动转换项 / 需人工项 / 警告）

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
   - 或下载 角色卡 + 表格模板 + 转换报告 + 数据桥脚本。

> 如果卡片没有 `[InitVar]` 世界书条目（不是 MVU 变量卡，或 initvar 缺失），转换会**明确中止**并提示原因，不会产出残缺的转换结果。

> 模板统一按双模式生成（DDL 与 SQL 示例同时写入）。AI 填表时实际输出
> `insertRow/updateRow/deleteRow` DSL 还是 SQL，由 SP·数据库 插件自身的填表模式设置决定，
> 转换器不需要也不提供单独的 native/sqlite 选择。

### 合并数据库现有表格模板
转换完成后，可在扩展面板选择 SP·数据库 插件里的模板来源（当前聊天模板 / 全局模板 /
全局预设），加载出表列表后勾选要并入的表，点「合并到转换结果」：
选中表会并入转换生成的模板并重新转换（角色卡内嵌模板、数据桥、报告同步更新）；
重名表自动跳过；合并后可用「保存角色卡和模板到sillytavern」保存。

## 转换逻辑

### 表格生成
- 解析 `[InitVar]`：官方 JSON5 + `[值, "更新条件"]` 叶子、YAML 子集、`<initvar>`/代码块包裹、多条目深合并。
- 顶层键 → 组；按结构推导表种类：组自身有直接标量字段=单例表、全对象条目字典=行表
  （条目字段为列；条目内的嵌套对象转 JSON 列，不再为每条目拆重复子表）、数组=数组表、
  单例组内的嵌套字典=子行表。
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
- 运行时解析 `<UpdateVariable>` / `<json_patch>` 块（`_.set/add/remove/assign`、JSON Patch）写库。
- **问候语 `<UpdateVariable>` 覆盖初始值**：MVU 允许额外问候语里的更新语句覆盖 `[InitVar]`；
  转换后桥脚本在开局建表完成后再应用开场白里的更新块，等效于 MVU 的覆盖行为。
- **命令与显示兼容**：`_.set`（双参/三参 `old,new` 两种格式）、`_.assign`（对象合并/按键赋值）、
  `_.remove/unset/delete`、`_.add`（数值加法带精度处理、日期字符串按毫秒推进转 ISO）；
  `display_data` 在会话内保存 `旧->新(原因)` 镜像（与 MVU 的 display 字符串同格式）。
- 与 MVU 原版一致，写库后广播 `Mvu.events.VARIABLE_UPDATE_ENDED`（`mag_variable_update_ended`，携带更新前后完整变量），前端原有 `eventOn` 监听直接生效。
- 数据桥同时提供 `TavernHelper.getVariables()` shim，兼容教程中「纯文本状态栏」的读取写法。

### 卡片清理
- **删除** `[InitVar]` / `[MvuUpdate]` 系列世界书，以及 content 含 MVU 专属宏
  （`status_current_variable` / `get_message_variable` / `format_message_variable` 等）的变量输出条目；
  仅移除解析 MVU 语法的正则与 MVU/ZOD 脚本。
- **误标保护**：带 `[mvu_update]` 标记但内容实为剧情/设定文本的条目（如部分“技能化”卡）
  会保留——删除判定看内容是否为变量管道（更新规则/变量列表/MVU 宏），而非只看标记。
- `[mvu_plot]` 剧情条目全部保留，内部 `{{get_message_variable::…}}` 宏改写为数据库表引用。
- **非 MVU 内容逐字节保留**（状态栏、data_block 显示、普通世界书等）；
  开场白保持原样（不注入任何脚本，纯文字开场白同样可用）。
- **世界书独立**：内嵌世界书名称与外部世界书引用会追加 `_数据库` 后缀，避免导入转换卡时同名覆盖原卡世界书。

### EJS 条件重写
**EJS 整体保留，只改数据读取位置**：提示词先经 st-prompt-template 渲染 EJS、再由
数据库插件解析 `<if>`。因此世界书里的 EJS（`<% if %>`、`<%_ if %>`、else-if 链、
循环、函数调用、`<%- %>` 输出等）原样保留，只把 MVU 的数据读取
`getvar('stat_data.路径')` / `getvar("stat_data").组.字段` / `_.has(getvar("stat_data"), …)`
改写为 `mvu2shujukuGetAllVariables().stat_data.路径`。扩展启动时把该函数注册进
st-prompt-template 的模板上下文（`EjsTemplate.defines`，实测可行），并用卡内布局 +
插件表格**惰性重建** stat_data（每次调用实时读表，数据只存一份、无冗余同步、不依赖卡内桥）。
唯一名字避免撞名；状态栏用的 `window.getAllVariables` 也由扩展提供。
仅在 EJS 条件中出现、不在 `[InitVar]` 里的字段（如分段阈值）也会补进列定义。

## 目录

| 路径 | 说明 |
| --- | --- |
| `manifest.json` / `index.js` / `style.css` | 扩展本体（仓库根目录即扩展，可直接安装） |
| `src/mvu2shujuku.js` | 转换核心源码 |
| `src/pinyin-data.js` | 拼音字典（由 pinyin-pro 生成，MIT） |
| `build-extension.js` | 重新构建扩展文件 |
| `test/run-tests.js` | 自动化测试（无测试卡片时自动跳过卡片相关用例） |

## 开发

```bash
node test/run-tests.js   # 跑测试
node build-extension.js  # 重新构建扩展文件
```

## 许可

MIT（见 `LICENSE`）。`src/pinyin-data.js` 派生自 [pinyin-pro](https://github.com/zh-lx/pinyin-pro)（MIT）。本仓库不包含 SP·数据库 插件源码与任何角色卡内容。
