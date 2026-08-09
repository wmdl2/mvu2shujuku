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

   或把整个仓库目录放入 `data/<user>/extensions/` 后刷新页面。
3. 重启 / 刷新 SillyTavern，设置面板出现「MVU转数据库」。

转换器**不会自动安装数据库插件**，默认你在已有插件的情况下使用。

## 使用

1. 打开扩展设置面板，选择填表模式：
   - **双模式（推荐）**：模板同时写入 DDL 与 native/SQLite 说明，跟随插件当前模式；
   - **native**：AI 输出 `insertRow/updateRow/deleteRow` DSL；
   - **sqlite**：AI 输出 `INSERT/UPDATE/DELETE` SQL。
2. 选择输入：当前角色卡，或文件选择器（支持 `.json` / `.png`）。
3. 点击转换：
   - **保存角色卡和模板**：把角色卡写入 SillyTavern 角色列表（自动带原头像），
     并同时把表格模板存为 SP·数据库 插件的“全局模板预设”（预设名 = 卡名 + `模板`）；
     开局进入新聊天会自动建表，无需手动切换；预设仅作备用。失败会弹窗显示日志，
     角色卡部分失败时自动回退下载；
   - 或下载 角色卡 + 表格模板 + 转换报告 + 数据桥脚本。

> 如果卡片没有 `[InitVar]` 世界书条目（不是 MVU 变量卡，或 initvar 缺失），转换会**明确中止**并提示原因，不会产出残缺的转换结果。

## 转换逻辑

### 表格生成
- 解析 `[InitVar]`：官方 JSON5 + `[值, "更新条件"]` 叶子、YAML 子集、`<initvar>`/代码块包裹、多条目深合并。
- 顶层键 → 组；按结构推导表种类：全叶子=单例表、条目字典=行表、数组=数组表、嵌套字典=子行表。
- 列来源：`[MvuUpdate]` 结构声明 > 状态栏/脚本成员访问扫描 > initvar 实际字段。
- 中文组名/字段名 → **拼音标识符**（内嵌 pinyin-pro 字典，与插件内部一致），DDL 注释保留中文。
- `[MvuUpdate]` 中的 `range` → `CHECK`、枚举 → `CHECK IN`、`format`/`check` → note、`_强制更新提醒` → “每次回复必须维护”。所有范围/枚举/格式均来自卡片自身规则。

### 数据桥（写入卡内 tavern_helper 脚本）
- **开局自动建表（对应 MVU 的 init 时机）**：转换时把模板以 base64 写入世界书条目
  `__ACU_TEMPLATE_DATA__`，并在开场白里注入初始化脚本——首次进入/首次回复前若表格为空，
  自动 `importTemplateFromData({scope:'chat'})` 建表，无需手动切换模板；
  已有表格的聊天不会被重置。
- 保存角色卡时仍会顺带把模板存为插件“全局模板预设”，可在插件模板面板手动切换备用。

### MVU 更新规则 → 填表提示词
`[MvuUpdate]` 的规则会写入模板 note（即插件注入给填表 AI 的提示内容）：
`range` → CHECK 约束与【强制约束】、枚举 → CHECK IN、`format`/`check` → 【强制约束】、
`_强制更新提醒` → “每次回复必须维护”。填表 AI 会按这些规则决定何时增改删。
- `getAllVariables()` shim：数据库表格 → `stat_data` 嵌套形状（含 `[值,条件]` 还原、`display_data` 镜像）——**状态栏 HTML 不用改**。
- `Mvu.getMvuData / Mvu.replaceMvuData` 兼容层：旧脚本 diff 写库。
- 运行时解析 `<UpdateVariable>` / `<json_patch>` 块（`_.set/add/remove/assign`、JSON Patch）写库。
- 广播 `shujuku-table-updated` 事件；状态栏原 `Mvu.events.VARIABLE_UPDATE_ENDED` 监听自动改写。

### 卡片清理
- **删除** `[InitVar]` / `[MvuUpdate]` 系列世界书；仅移除解析 MVU 语法的正则与 MVU/ZOD 脚本。
- **非 MVU 内容逐字节保留**（状态栏、data_block 显示、普通世界书等）；
  开场白仅追加开局建表脚本，其余内容不动。
- **世界书独立**：内嵌世界书名称与外部世界书引用会追加 `_数据库` 后缀，避免导入转换卡时同名覆盖原卡世界书。

### EJS 条件重写
`getvar('stat_data.组.字段')`、`getvar("stat_data").组["字段"][0]`、`_.has(...)` → `<if cell/cond/db>`；无法自动转换的保留原样并列入报告。

## 目录

| 路径 | 说明 |
| --- | --- |
| `manifest.json` / `index.js` / `style.css` | 扩展本体（仓库根目录即扩展，可直接安装） |
| `src/mvu2db.js` | 转换核心源码 |
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
