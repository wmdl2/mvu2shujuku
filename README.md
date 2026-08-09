# MVU → 数据库 转换器（SillyTavern 原生扩展）

把 **MVU 变量角色卡**（MagVarUpdate / `[initvar]` + `stat_data`）转换为 **SP·数据库**（AutoCardUpdater / shujuku，8.9.1）角色卡，在 SillyTavern 内以原生扩展运行。

## 目录

| 路径 | 说明 |
| --- | --- |
| `扩展/mvu2db-converter/` | **可安装的 SillyTavern 原生扩展**（manifest.json + index.js + style.css） |
| `转换器/src/mvu2db.js` | 转换核心源码（纯 JS，Node 可测，浏览器可用） |
| `转换器/build-extension.js` | 构建脚本：核心内联进扩展 `index.js` |
| `转换器/test/run-tests.js` | 自动化测试（20 项，含与参考卡无关的合成卡通用性验证） |
| `输出示例/` | 用一张真实 MVU 卡跑出的转换产物示例（仅作演示，转换器本身不依赖该卡） |
| `参考资料/` | 插件源码、MVU 仓库、默认模板、参考卡（开发用，**不入库**） |

## 安装扩展

1. 前提：SillyTavern 已安装 **SP·数据库（AutoCardUpdater 8.9.1）** 插件。
2. 把整个 `扩展/mvu2db-converter` 目录复制到 SillyTavern 的 `data/<user>/extensions/`（或全局 `public/scripts/extensions/third-party/`）。
3. 刷新页面，扩展设置面板出现「MVU转数据库」。

转换器**不会自动安装数据库插件**，默认你在已有插件的情况下使用。

## 使用

1. 打开扩展设置面板。
2. 选择填表模式：
   - **双模式（推荐）**：模板同时写入 DDL 和 native/SQLite 说明，跟随插件当前模式生效；
   - **native**：AI 输出 `insertRow/updateRow/deleteRow` DSL；
   - **sqlite**：AI 输出 `INSERT/UPDATE/DELETE` SQL。
3. 选择输入：当前角色卡按钮，或文件选择器（支持 `.json` 与 `.png`）。
4. 点击转换：
   - **保存为角色卡（直接进酒馆）**：通过 `createCharacterData` 写入 SillyTavern 角色列表（自动带原头像）；
   - 或下载四个产物：
   - 修改后的角色卡（PNG 输入 → PNG 输出；否则 JSON）
   - 表格模板 JSON（可单独导入插件 / 或由卡内数据桥自动建表）
   - 转换报告（Markdown：自动转换项 / 需人工项 / 警告）
   - 数据桥脚本（tavern_helper，已内嵌到卡里，供单独查看）

转换后的卡名会自动追加 `_数据库` 后缀（可在扩展设置里关闭）。

## 转换做了什么

### 表格
- 解析 `[initvar]`（兼容官方教程的 JSON5 + `[值, "更新条件"]` 叶子、YAML 子集、`<initvar>`/``` 包裹、多条目深合并）→ 每张表一张 sheet，列顺序综合三处来源：
  1. `[mvu_update]` 里的变量结构声明（最权威，含 `历史记录` 这类对象列）；
  2. 状态栏/脚本里的成员访问（`const X = stat.组`、`Object.entries(组变量)` 等）；
  3. initvar 实际字段。
- 生成 `DDL`（拼音物理标识符 + 中文列注释 + `UNIQUE`/`CHECK`/默认值；拼音逻辑与插件内置的 pinyin-pro 一致）、初始行、note（双模式填表说明）、`initNode/updateNode/insertNode/deleteNode`。
- `[mvu_update]` 中的 `range` → `CHECK` 约束；枚举值 → `CHECK IN`；`format`/`check` 规则 → note；`_强制更新提醒` → 每表 note 的“每次回复必须维护”段。**所有范围/枚举/格式都来自卡片自身规则，代码不含任何内置数值字典。**
- 空字典组 → 空行表；顶层数组（`$` 前缀的任意组名）→ 数组表；嵌套字典 → 子行表。

### 数据桥（卡内 tavern_helper 脚本）
- 内嵌模板 base64；表格为空时自动 `importTemplateFromData({scope:'chat'})` 建表。
- 提供 `getAllVariables()` shim：把数据库表格重建回 `stat_data` 嵌套形状——**状态栏 HTML 不用改**，继续读 `stat_data` 即可。
- `[值, "更新条件"]` 叶子在重建时还原为 `[值, 条件]`，规范卡片里的 `字段[0]` 读取照常工作；同时提供 `display_data` 镜像。
- 提供 `Mvu.getMvuData / Mvu.replaceMvuData` 兼容层：旧脚本写入的 `stat_data` 变更会 diff 后写回数据库（`updateCell/insertRow/deleteRow`）。
- 运行时解析消息/开场白里的 `<UpdateVariable>` / `<json_patch>` 块（`_.set/_.add/_.remove/_.assign`、JSON Patch 的 replace/delta/insert/remove），按路径写回数据库——对应 MVU 的更新指令语义。
- `registerTableUpdateCallback` + 广播 `shujuku-table-updated` 事件；状态栏原有的 `Mvu.events.VARIABLE_UPDATE_ENDED` 监听会被自动改写。

### 清理与保留
- 移除解析 `<UpdateVariable>`/`format_message_variable` 的 MVU 专属正则与 MVU/ZOD 脚本；**非 MVU 的正则（状态栏、data_block 显示等）逐字节保留**；
- **删除** `[initvar]`、`[mvu_update]` 系列世界书条目（其数据/规则已迁移到数据库模板）；
- `getwi` 等非 MVU 语法原样保留；依赖 `Mvu` API 的脚本保留并走兼容层，报告中标记需人工检查。

### EJS 条件重写
`<% if (getvar('stat_data.组.字段') >= 50) { %>…<% } %>` → `<if cell="组表/组/字段 >= 50">…</if>`；
`<% if (getvar("stat_data").组["字段"][0] >= 50) { %>…<% } %>` 同理；`Object.keys(getvar('stat_data.组')).length > 3` → `<if db="组表.count() > 3">`（仅 SQLite）；组合条件 → `<if cond>`。无法自动转换的保留原样并列入报告。

## 已知限制

- 不迁移旧聊天，只转换角色卡本身。
- `[mvu_update]` 的 `check` 长规则会以“字段维护规则”段落写入 note（超长截断并提示），复杂自定义规则建议人工复核。
- `else if` 链、复杂 EJS 循环不自动转换，报告会标记。
- 卡内自定义脚本若绕过 `Mvu` 直接操作 `window` 变量，需要人工改为数据库 API。

## 开发

```bash
node 转换器/test/run-tests.js   # 跑测试
node 转换器/build-extension.js  # 重新装配扩展
```

说明：
- `转换器/src/pinyin-data.js` 由 [pinyin-pro](https://github.com/zh-lx/pinyin-pro)（MIT）字典生成，仅提取汉字→拼音映射。
- 测试依赖的参考卡 fixture（`转换器/test/fixtures/`）与 `参考资料/`、`输出示例/` 属于开发/演示用内容，已加入 `.gitignore` **不上传 GitHub**；缺失时相关测试自动跳过，通用性测试照常运行。
- 本项目以 MIT 协议发布（见 `LICENSE`）；不包含 SP·数据库 插件源码与任何角色卡内容。
