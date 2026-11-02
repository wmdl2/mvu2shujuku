# 文档与维护入口

按当前问题选择一个主题，不默认通读历史验收和所有架构文档。根目录 `index.js` 是构建产物，源码定位从 `src/` 开始。

## 当前资料

| 当前问题 | 入口 |
| --- | --- |
| 安装、转换、状态导入导出 | [用户说明](../README.md) |
| 支持的结构、宿主 API 与已知边界 | [兼容清单](../COMPATIBILITY.md) |
| 转换器职责、独立填表基线、产物与保留边界 | [转换架构](architecture.md) |
| 行表／JSON 布局、字段类型、隐藏数据与约束 | [数据映射](data-model.md)、[布局设计](design/layout-planning.md) |
| 变量 API、初始化、提交、历史与前端 | [运行时契约](runtime.md) |
| 构建、按改动选择验证、宿主排查 | [开发指南](development.md) |
| 发布变化、上游资料与许可 | [更新日志](../CHANGELOG.md)、[参考说明](../REFERENCES.md) |

## 源码定位

| 行为 | 优先文件 |
| --- | --- |
| JSON／PNG 输入、Schema 执行、布局 | `src/input-parser.js`、`src/schema-execution.js`、`src/schema-layout.js` |
| 转换协调、产物刷新与模块装配 | `src/mvu2shujuku.js` |
| 规则迁移、表格说明、正文请求分流 | `src/update-rule-migration.js`、`src/table-prompts.js`、`src/mvu2shujuku.js:getWorldbookRequestFilterFactory` |
| 前端字段引用与别名扫描 | `src/status-usage.js` |
| EJS、宏、作者脚本 API | `src/ejs-transform.js`、`src/card-bridge.js`、`src/card-api.js` |
| 变量 API、原消息数据与表格编解码／写入 | `src/variable-api.js`、`src/stat-storage.js`、`src/table-codec.js`、`src/table-writer.js` |
| 会话、窗口、历史与首次前端就绪 | `src/runtime-session.js`、`src/runtime-windows.js`、`src/runtime-globals.js`、`src/message-history.js`、`src/frontend-readiness.js` |
| 状态迁移、转换配置 | `src/state-transfer.js`、`src/conversion-profiles.js` |
| 宿主适配与界面 | `src/sp-adapter.js`、`src/st-adapter.js`、`src/settings-view.js`、`src/result-view.js` |
| 以上模块的运行时调用与宿主操作绑定 | `src/extension-runtime.js`；先按函数定位，避免全文读取 |

## 验证证据

- 本版实施接口接入：[数据库正式接口与保存冲突续查](validation/2026-11-02-merged-database-apis.md)。包含 1.3.5 来源缓存、连续写入及慢保存边界。

- 本版实施归因：[固定输入实机对照](validation/2026-11-02-fixed-host-performance.md)。区分数据库原有复制、兼容层额外回放、来源接口原型与严格比较边界。

- 本版实施复查：[读取、发送与写入性能](validation/2026-11-01-runtime-performance-followup.md)。区分插件实际优化、来源接口／回读等待原型和仍有的宿主成本。

- 本版实施运行时：[历史准备范围与缓存性能](validation/2026-11-01-history-preparation-performance.md)。包括逐层摘要、实际 SQL 保存重开及隔离宿主性能对照。

- 本版实施界面：[设置面板与转换结果工作流](validation/2026-11-01-frontend-workflow.md)。包括重转保护、选项生效一致性和真实浏览器组件验证。

- 本版实施修复：[Schema 默认值与延后初始化](validation/2026-10-31-schema-defaults-and-initialization.md)。记录默认值重复编码、初始化并发修复及受测范围，不代表已经发布。
- 最近发布：[v0.8.5 收尾](validation/2026-11-02-release-v0.8.5.md)；前版：[v0.8.4 收尾](validation/2026-10-25-release-v0.8.4.md)、[变量接口清单](validation/2026-10-25-variable-api.md)。
- 更早证据按需检索[历史验证索引](validation/README.md)及[性能测量](benchmarks/)。日期记录描述当时受测版本，不能直接当作当前待办或当前规范。

## 更新与读取

使用说明放 `README.md`，当前支持范围放 `COMPATIBILITY.md`，有效约定维护在对应架构主题；具体受测版本、命令、结果和局限放日期验收记录。导航只保留入口，避免重复维护同一结论。

行为变化时更新对应章节与兼容清单；完成的过程不追加到本入口。普通源码注释和小文案修改按开发指南选择局部验证，不因此重启完整宿主验收。

公开文档应可独立使用，不依赖本地缓存、私有角色卡或机器路径。私有数据、凭据和临时日志不进入公开记录。
