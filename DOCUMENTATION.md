# MVU转数据库 项目文档

> 面向后续维护者的索引、架构说明与踩坑记录。持续补充。

## 1. 这是什么

把旧式 MVU（MagVarUpdate）角色卡转换成 SP·数据库角色卡的 SillyTavern 扩展。

- 自动把 MVU 的 `[InitVar]` / `<initvar>` 初始变量解析为表格模板（单例表/行表/JSON 表/数组表）
- 把 `[mvu_update]` 更新规则迁移成表格 note / SQL 约束
- 安装 Mvu 兼容层（shim），前端与卡内脚本调 `Mvu.*` / `getVariables` / `updateVariablesWith` 时改走数据库表格
- 转换后的卡与世界书加 `_数据库` 后缀，避免与原始卡冲突

## 2. 构建与测试

```bash
node build-extension.js   # src/ → 根目录 index.js + manifest.json + style.css
node test/run-tests.js    # 全量回归（当前 88 通过 / 0 失败）
```

- 源码唯一入口：`src/mvu2shujuku.js`（构建时内联 pinyin、vendor 库、jsonrepair）
- 构建产物必须提交（用户安装的是根目录 index.js）
- 测试卡：`test/fixtures/道渊-MVU.json`（缺失时相关用例自动跳过）
- 测试直接读 `src/` 并 `assembleExtension` 组出可执行扩展，在 `vm` 沙箱里跑桥/写库

## 3. 文件索引

| 路径 | 作用 |
| --- | --- |
| `src/mvu2shujuku.js` | 全部源码：转换器 + 卡内桥生成 + 扩展运行时 |
| `src/pinyin-data.js` | 中文表名 → sheet key 的拼音表 |
| `src/vendor/mvu-yaml-libs.js` | 与 MVU 官方同款 YAML/JSON5 解析（webpack target:web 内联） |
| `src/vendor/jsonrepair-lite.js` | JSON 容错解析（AI JSONPatch / 表数据） |
| `test/run-tests.js` | 回归测试（转换、解析、桥、写库、checkpoint） |
| `test/fixtures/` | 测试角色卡 |
| `build-extension.js` | 构建脚本 |
| `输出示例/` | 参考输出：转换报告、数据桥、模板、日志 |
| `参考资料/`（仓库外） | SP·数据库插件源码 `8.9.1.js`、MVU 官方源码 `MagVarUpdate/`、参考角色卡 |

## 4. 架构与关键机制

### 4.1 三层结构

1. **转换器（转换时一次性）**：解析 MVU 卡 → 生成模板 JSON（`mate` + `sheet_*`）、布局（`extensions.mvu2shujuku.layout`）、数据桥脚本（tavern_helper）、世界书模板条目（`__ACU_TEMPLATE_DATA__` base64）。
2. **卡内数据桥（tavern_helper 脚本）**：`__MVU2SHUJUKU_TEMPLATE_BASE64` + Mvu shim（桥内版本）+ 状态栏占位符。
3. **扩展本体（扩展面板加载）**：检测转换卡（`extensions.mvu2shujuku.converter === 'mvu2shujuku'`）、开局自动建表、安装"接管式" Mvu shim（覆盖桥内 shim）、维护状态栏、写库主路径。

### 4.2 写入路径（重要）

前端/脚本写入统一走 `scheduleWindowStatOverlay`（150ms 合并窗口），然后：

1. 写库前确保 full checkpoint 存在（`ensureCheckpointBeforeWrite`；缺失则 `initGameSession` 重建锚点）。
2. 读取基线 `prev`（`getAllVariables` → 运行时表）。
3. `effectiveTarget = prev + target`（**浅合并：target 的顶层组整体覆盖 prev 同名组**）。
4. `isFirstWrite = !initializedViaGameSession.has(chatKey) && !hasCp`：
   - 首次：`initGameSession(applyTargetToTemplate(...))`（**按表名**合并，插件一次性建表+写 anchor）。
   - 非首次：`importTableAsJson(mergeSnapshotIntoTemplate(tplCached, snap))`。
5. `importTableAsJson` 返回真值即视为成功；失败回退差异写入（`writeStatDiffToDb` → updateCell/insertRow）。

### 4.3 表 key 的两个世界（核心坑）

SP·数据库对"无数据的新聊天"会执行 `rekeyTemplateForPristineChat_ACU`：**按表名重建所有 sheet key**（表名"系统表" → 稳定 key `sheet_xi_tong_biao`）。

- 转换器模板 key：`sheet_xitongbiao`（拼音连写）
- 插件运行时/checkpoint key：`sheet_xi_tong_biao`（插件从表名生成的 slug）

两者**永远不一致**。因此：

- 一切按 key 精确匹配模板与运行时的代码都会静默失败（典型症状：写入"成功"但值没进去）。
- **正确的稳定身份是表名**（`name`），不是 key。合并/查找请先按 key、再按表名兜底。
- `applyTargetToTemplate`、`buildTableSnapshotFromStat` 的 `tplRowOf` 已是按表名；`mergeSnapshotIntoTemplate` 必须保持"key 精确 + 表名兜底"。

### 4.4 checkpoint（持久化）

- 聊天消息上的 `TavernDB_ACU_IsolatedData`（字符串或对象）内含 `storageFrame.version=2 + checkpoint.kind='full' + data`。
- 另有 `TavernDB_ACU_InternalSheetGuide`、`TavernDB_ACU_ScopedConfig`：插件 UI 靠它们判定"已初始化"。
- 多份 full checkpoint 并存时（首楼替换/重锚历史残留），**取数据体积最大的一份**（`readFullCheckpointData`），旧锚可能只含模板默认值。
- SQLite 模式下重进聊天，插件可能不把 checkpoint 恢复进运行时（内存表停在模板默认）——扩展需自校验：运行时与 checkpoint 不一致时用 `importTableAsJson(cpData, {persist:false, mode:'restore'})` 物化。

### 4.5 Mvu 兼容层

- `Mvu.getMvuData`：有待写快照返回待写快照，否则读 `getAllVariables`（运行时表重建 stat_data）。
- `Mvu.setMvuVariable`：**官方语义：路径不存在返回 false，不自动创建**（前端 `setIfChanged` 拿不到 true 就静默丢弃改动）。若前端读到的 stat_data 残缺，改动会丢。
- `Mvu.replaceMvuData`：进入合并写库。
- 裸全局 `getVariables` / `updateVariablesWith`：部分前端/脚本直接调用，桥与扩展都要装。

## 5. 已知坑清单

1. **sheet key 双世界**（见 4.3）：新功能若按 key 匹配模板/运行时，先想清楚用哪个 key 空间。
2. **前端写库丢值**：读侧残缺（布局门禁、运行时未物化）→ `setMvuVariable` 返回 false → 改动静默丢弃。先查 `getAllVariables` 是否完整。
3. **SQLite 重进不恢复运行时**：checkpoint 有值、内存表是默认。靠"运行时与 checkpoint 校验 + 物化"兜底；写库前也要做，不能只在切聊天时做。
4. **导入/导出 API 的"假成功"**：`importTableAsJson` 返回真 ≠ 数据生效。SQLite 模式下曾出现提交成功但运行时不变。诊断需看 checkpoint 里是否真有目标值（any-needle 校验会误报，要用值比对）。
5. **初始化只跑一次**：`autoInitState.done === key` 与 `initializedViaGameSession` 决定是否重建；刷新后前者清空、后者不清，语义不同，改动时注意区分。
6. **切卡残留**：`activeLayout` / 模板缓存 / Mvu shim / getAllVariables 必须按卡名归属（`layoutBelongsToCurrentCard`：头像可能不一致，卡名兜底）。
7. **checkpoint 挂在首楼**：道渊类卡开场会替换/删除首楼，checkpoint 可能被带到新消息或被清掉；重锚机制与"取最大 checkpoint"为此存在。
8. **下划线字段**：`_` 前缀 = 脚本只读状态，不进填表规则；`_扩展数据` 是内部溢出列。

## 6. 排查指南

- 扩展设置开 debug（`extensionSettings.mvu2shujuku.debug`），日志前缀 `[mvu2shujuku][debug]`。
- 探针（F12 控制台）：
  - `window.getAllVariables()` → 读侧是否完整；
  - `Mvu.getMvuData()` → 前端视角 stat_data；
  - `AutoCardUpdaterAPI.exportTableAsJson()` → 运行时表；
  - `chat[i].TavernDB_ACU_IsolatedData` → checkpoint 里实际有什么（值比对，别用 any-needle）。
- 关键日志行：
  - `[锚点自检] exportRows=N` → 运行时数据行数（模板满行 vs 空行的参照）；
  - `[快照提交] target.… | 原始snap… | 提交快照…` → 值在哪一步丢；
  - `[重进恢复]` → 重进时是否按 checkpoint 物化。

## 7. 关键历史提交（按时间）

| 提交 | 时间 | 作用 |
| --- | --- | --- |
| `79c2b4d` | 08-10 12:13 | 写路径改为差异写入（对齐参考卡），importTableAsJson 仅兜底 |
| `374e3e6` | 08-10 19:23 | 写路径改回 importTableAsJson 快照优先（差异写入依赖 saveChat，易被环境拦截） |
| `fdc3dcf` | 08-10 22:07 | 自动建表不再覆盖已有 checkpoint；运行时物化只允许稳定 key（**当时实测正常，即"治好了"版本**） |
| `500b093` | 08-11 01:48 | Mvu 兼容层按官方对齐：setMvuVariable 路径存在校验、parseMessage 副本等 |
| `5495df2` | 08-11 02:06 | `_` 前缀字段不进填表规则；`_` 前缀空字典改 JSON 列 |
| `fb095fc` | 08-11 12:36 | activeLayoutCardKey 布局归属门禁（严格按 卡名|头像） |
| `08e010a` | 08-11 13:26 | 写库以 checkpoint 为基线、`isFirstWrite` 加 `&& !hasCp`（修刷新覆盖；**暴露 key 合并缺陷，前端写库丢值回归**） |
| `9439c49` | 08-11 15:00 | `mergeSnapshotIntoTemplate` 按表名兜底（修复丢值回归） |
| `10c39ef` | 08-11 15:10 | 重进按 checkpoint 恢复运行时；`readFullCheckpointData` 取最大一份 |

> 教训：改"是否首次写库"这类门控时，必须同时验证它路由到的路径的 key 假设（initGameSession 按表名 vs merge 按 key）。
