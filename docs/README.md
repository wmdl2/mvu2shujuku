# 文档与维护入口

v0.8.2 的完整改动见[更新日志](../CHANGELOG.md)，本次[精细布局与发布验证](validation/2026-10-13-fine-layout.md)记录最终包与受测范围；[v0.8.1 布局验证](validation/2026-10-12-layout-planning.md)保留前版证据；[v0.8.0 发布验证](validation/2026-10-11-release-v0.8.0.md)保留前版证据。

v0.8.2 的精细布局与明确写入边界见[布局设计](design/layout-planning.md)。

v0.8.2 的历史 SQL 只读接口接入、异步准备与缓存契约见[2026-10-13 验证](validation/2026-10-13-message-history.md)。

状态档案、完整聊天备份、四向迁移及旧布局／声明隐藏字段续修的实现和验收状态见[2026-10-11 状态迁移](validation/2026-10-11-state-transfer.md)。

H01 嵌套对象展开、扩展数据与 JSON 标量说明复核见[提示词与布局检查](validation/2026-10-11-h01-table-prompts.md)；复杂对象布局已按用户确认实施，续验状态见记录。

开放根合为一张 JSON 表的依据、数据核对和 Zod 追加校验后的元数据修复见[布局续核对](validation/2026-10-10-root-layout-review.md)。

独立新卡首次测试、Zod 回退输出与 SQLite 约束修复见[最终样本验证](validation/2026-10-10-final-holdout.md)。

历史接口之外的待办分类、发送窗口上游草案与历史写入边界见[兼容续核对](validation/2026-10-10-compatibility-follow-up.md)；草案尚未接入，不代表边界已全部消除。

社区关键流程续验、SQL 发送视图与测试集边界见[2026-10-10 记录](validation/2026-10-10-community-acceptance.md)。前版混合存储、显式根对象映射及隐藏数据归属见[2026-10-09 验证](validation/2026-10-09-hybrid-storage.md)。

动态变量入口、历史读取、缓存边界和 MIT 适配范围见[最新验证](validation/2026-10-08-variable-adapter.md)。

EJS、JavaScript 词法与 Lodash 复用的最新实现及范围见[2026-10-08 验证](validation/2026-10-08-upstream-reuse.md)。

本轮源码契约、十五张卡旧问题复核与未闭合接口见[2026-10-08 记录](validation/2026-10-08-source-contract-review.md)。

远程 Schema、多开场分支及 0.5.0 最终验收见 [验证记录](validation/2026-10-05-remote-schema-branches.md)。注册 Schema、创角档案、世界书别名及 3.2 MVU 卡缺口的前序修复见 [v0.4.11 验证](validation/2026-10-05-card-api-compatibility.md)。

按当前问题选择资料，不需要每次全文读取所有文档。

| 当前问题 | 入口 |
| --- | --- |
| 脚本JSON兜底表、频率0与手动重填/追平保护 | [手动路径核对](validation/2026-10-09-manual-fill-script-data.md) |
| 转换器职责、独立填表对标与自然语言/执行边界 | [目标与维护边界](architecture.md#转换器职责与独立填表基线) |
| 统一填表条目、源业务保留、旧格式请求副本与 EJS 上下文 | [统一适配验证](validation/2026-10-08-fill-adaptation.md) |
| 更新迁移路径边界、占位示例、只读 EJS 与动态记录（前序方案） | [补齐验证](validation/2026-10-07-update-rule-boundaries.md) |
| 社区 15 卡深层审查、完整段落分流与兼容边界（v0.8.0） | [审查记录](validation/2026-10-07-community-deep-audit.md) |
| 重转世界书冲突、覆盖/另存与可选 JSON 备份 | [v0.7.0 验证](validation/2026-10-07-worldbook-save.md) |
| MVU 更新前回调的正文写回与独立保存重试 | [v0.7.0 验证](validation/2026-10-07-mvu-message-update.md) |
| 当前变量展示保留、回复状态块清理与相邻回调边界 | [v0.7.0 验证](validation/2026-10-07-mvu-status-display.md) |
| 规则迁移、正文分流、模型只读说明与保存进度 | [v0.6.0 验证](validation/2026-10-06-rule-metadata-save.md) |
| 独立填表与新正文生成的并发边界 | [当前兼容清单](../COMPATIBILITY.md) |
| 静态／动态登记入口、回退引擎与大资源扫描 | [入口验证](validation/2026-10-06-script-entrypoints.md) |
| number／integer／布尔列映射、数组类型保留及 transform 范围 | [类型验证](validation/2026-10-05-type-mapping.md) |
| 真实 JavaScript/Zod Schema 构造、隔离执行与通用语法修复 | [执行验证](validation/2026-10-05-schema-execution.md) |
| 社区语料问题根因、可玩性边界和改造前静态解析缺口 | [根因分析](validation/2026-10-05-conversion-root-causes.md) |
| 远程 Schema、版本固定、多开场及 0.5.0 验收 | [远程与分支验证](validation/2026-10-05-remote-schema-branches.md) |
| 社区 MVU/ZOD 角色卡批次、Schema 默认初始化与同名字段类型 | [逐卡转换验证](validation/2026-10-05-community-card-conversion.md) |
| 3.2 MVU 卡的结构、创角、外部引擎与世界书转换缺口 | [卡片转换检查](validation/2026-10-05-card-32-conversion-audit.md) |
| TT 原生重新生成、重Roll脚本与表格回退时序风险 | [重新生成风险检查](validation/2026-10-05-tauritavern-regeneration-rollback.md) |
| TauriTavern 历史滚动、状态栏冷恢复与 Mvu 初始化兼容 | [运行兼容性审查](validation/2026-10-03-tauritavern-runtime-audit.md) |
| 安卓发送跳楼、DOM 虚拟化与助手流式渲染限制 | [手机与虚拟化检查](validation/2026-10-04-tauritavern-mobile-virtualization.md) |
| 字面键、根层标量、规则迁移凭证与禁用结构声明 | [通用转换契约修复](validation/2026-10-03-converter-contracts.md) |
| 变量输出格式整条移除与更新规则按迁移拆分 | [输出格式与规则拆分验证](validation/2026-10-03-output-format-ownership.md) |
| 双模式业务说明与宿主输出协议的职责分工 | [表格协议说明验证](validation/2026-10-03-table-protocol-notes.md) |
| 有限字段绑定、完整 YAML 路径、数组/关联及输出约束保留 | [复杂声明验证](validation/2026-10-03-finite-field-bindings.md) |
| 龙血玄黄·数据库改名、版本重新编号与新版宿主兼容 | [新版兼容验证](validation/2026-10-01-nailong-database.md) |
| 顶层固定对象误判、深层空字典类型与规则保留 | [声明路径验证](validation/2026-10-01-declared-container-paths.md) |
| 安装、转换与用户操作 | [用户说明](../README.md) |
| v0.4.1 更新范围与提交前检查 | [发布验收](validation/2026-09-27-release-0.4.1.md)、[更新日志](../CHANGELOG.md) |
| v0.4.0 升级范围与发布检查 | [发布验证](validation/2026-09-22-release-0.4.0.md) |
| SQL 示例与强制更新提醒 | [提示示例验证](validation/2026-09-23-prompt-examples.md) |
| SP 扩展/脚本版本识别与隐藏列兼容基线 | [版本识别验证](validation/2026-09-28-sp-version.md) |
| iframe 引用释放与过期开场快照清理 | [内存生命周期验证](validation/2026-09-27-memory-lifecycle.md) |
| TauriTavern 2.3.0 文件导入与世界书冲突 | [二创宿主兼容记录](validation/2026-09-27-tauritavern-card.md) |
| 每次调用的写入结果、重试与旧接口兼容 | [写入结果验证](validation/2026-09-26-write-results.md) |
| 表格说明、更新提醒与 SQL 示例模块 | [提示模块验证](validation/2026-09-26-table-prompts-module.md) |
| 转换配置、外部表合并与确认流程 | [配置模块验证](validation/2026-09-26-conversion-profiles.md) |
| 内部模块职责、命令处理与修复库注入 | [模块验证](validation/2026-09-26-internal-modules.md) |
| 下划线列物理名与旧模板边界 | [列名验证](validation/2026-09-23-underscore-columns.md) |
| 表格反选与兼容报告文案 | [反选与报告验证](validation/2026-09-23-selection.md) |
| 角色卡保存后脚本复核警告 | [保存复核验证](validation/2026-09-23-save-verification.md) |
| 转换报告、多选表格设置及世界书注入开关 | [前端验收](validation/2026-09-22-frontend.md) |
| 转换流程、产物刷新、桥、EJS 和脚本保留 | [转换架构](architecture.md) |
| 对象、数组、关系子表、类型与规则 | [数据映射](data-model.md) |
| 初始化、会话隔离、写入和前端通知 | [运行时契约](runtime.md) |
| 构建、测试、实机验证与故障排查 | [开发指南](development.md) |
| 支持的结构、API 与已知限制 | [兼容清单](../COMPATIBILITY.md) |
| 当前发布变化 | [更新日志](../CHANGELOG.md) |
| 旧式 pair 写入与 SQLite hydrate 修复 | [pair 写入验收](validation/2026-09-16-pair-write.md) |
| 普通脚本写入、删楼回退和首次快照成本 | [楼层归属修复](validation/2026-09-16-write-floor.md)（含修复前诊断链接） |
| 当前回复混合更新的完整提交与内存规划成本 | [批次验收](validation/2026-09-16-atomic-batch.md) |
| 动态说明渲染、原 Schema 复用与提交前校验的候选边界 | [前期能力探针](validation/2026-09-16-compatibility-probes.md)（后续 VWD 实现见下一项） |
| 动态说明的安全渲染、保存与实际请求 | [VWD 实施验收](validation/2026-09-16-vwd-prompt.md)（后续实现，范围限定） |
| 未声明容器的完整 JSON、嵌套说明与存储成本 | [完整 JSON 容器](validation/2026-09-22-full-json-containers.md) |
| 嵌套 YAML 规则、旧楼提交保护、数字/布尔动态说明 | [后续兼容验收](validation/2026-09-22-compatibility-followup.md) |
| 可空动态记录与多层关联的完整保存 | [可空记录验收](validation/2026-09-21-nullable-records.md) |
| 顶层可空对象、数组与字典的完整保存 | [整组空值验收](validation/2026-09-16-container-presence.md) |
| 上游依据与资料来源 | [参考说明](../REFERENCES.md) |
| v0.3.18 实机版本、场景和复现 | [宿主验收](validation/2026-09-11-host.md) |
| 后续首批 API、表格排序与提示词修改 | [增量验收](validation/2026-09-12-incremental.md) |
| 可空列读写及 SP 业务事件差异复现 | [可空列验收](validation/2026-09-12-nullable.md) |
| 后续语义、业务回写与窗口缓存 | [语义增量验收](validation/2026-09-13-semantics.md) |
| JSON 路径填表、固定附属对象合并与成本边界 | [JSON 与合表验收](validation/2026-09-14-json-path.md) |
| 规则条目保留、前端误补列与关联提示命名 | [规则与字段扫描验收](validation/2026-09-14-card-rules.md) |
| 字段说明保真、辅助扫描与 SQL 示例类型 | [提示词安全验收](validation/2026-09-14-prompt-safety.md) |
| 业务指令、括号限制及旧操作参数保留 | [业务规则验收](validation/2026-09-15-business-rules.md) |
| 关联定位、数组行号与两模式实机验证 | [特殊操作提示验收](validation/2026-09-15-prompt-guidance.md) |
| 旧 VWD 实验关闭、候选工厂与复审精修 | [历史复审验收](validation/2026-09-15-vwd-review.md)（新路径见上方 VWD 实施验收） |
| 恢复完整说明与新增定位提示的 token 增量 | [提示词增量](benchmarks/prompt-2026-09-15.md) |
| 差异写入性能与测量边界 | [基准记录](benchmarks/diff-2026-09-10.md) |
| 表格提示词、token 和窗口枚举成本 | [压力测量](benchmarks/prompt-2026-09-13.md) |

## 文档范围

使用说明与兼容范围见[用户说明](../README.md)、[兼容清单](../COMPATIBILITY.md)；当前架构与开发流程见本目录主题文档。[验收记录](validation/)和[性能测量](benchmarks/)保存可公开的版本证据，版本变化和上游来源分别见[更新日志](../CHANGELOG.md)、[参考说明](../REFERENCES.md)。

公开文档应能独立说明架构和核心回归。提交验证记录时不要包含私有角色卡内容、凭据、机器绝对路径或会话中的临时状态；测试运行产生的数据和日志保存在本地。

## 源码定位

| 行为 | 优先文件 |
| --- | --- |
| JSON/PNG 输入、模板布局 | `src/input-parser.js`、`src/schema-layout.js` |
| 前端字段读取、别名与作用域 | `src/status-usage.js` |
| 转换协调、产物刷新 | `src/mvu2shujuku.js` |
| EJS、卡内登记桥 | `src/ejs-transform.js`、`src/card-bridge.js` |
| 表格说明、规则措辞与增删改示例 | `src/table-prompts.js` |
| 转换配置匹配、外部表来源与合表规划 | `src/conversion-profiles.js` |
| MVU 兼容命令解析与内存计算 | `src/mvu-commands.js` |
| 表格读取、类型与差量写入 | `src/table-codec.js`、`src/table-writer.js` |
| 窗口发现、原始接口登记与释放 | `src/runtime-windows.js`、`src/runtime-globals.js` |
| 异步会话、初始化、消息与写队列 | `src/runtime-session.js`、`src/extension-runtime.js` |
| 宿主 API、界面 | `src/sp-adapter.js`、`src/st-adapter.js`、`src/settings-view.js`、`src/result-view.js`；宿主操作绑定在 `src/extension-runtime.js` |

根目录 `index.js` 为构建产物；历史桥夹具 `test/legacy/` 不参与构建。先按函数或关键词定位，避免读取整个生成包。

## 阅读与更新方式

按上表定位相关主题和函数；构建产物 `index.js` 不作为源码入口。验证命令和按改动选择检查范围的规则见[开发指南](development.md)。

行为或兼容范围变化时更新对应架构章节和兼容清单。具体测试结果与受测版本记录在日期验收文件，其他文档引用这些记录。

- [变量布局与容器存在状态](design/layout-planning.md)：本轮 JSON 回退决定及未来拆分的准入。
- [2026-10-12 布局验收](validation/2026-10-12-layout-planning.md)：公开回归、隔离宿主与开发集的不同证据范围。
