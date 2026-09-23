# 文档与维护入口

按当前问题选择资料，不需要每次全文读取所有文档。

| 当前问题 | 入口 |
| --- | --- |
| 安装、转换与用户操作 | [用户说明](../README.md) |
| v0.4.0 升级范围与发布检查 | [发布验证](validation/2026-09-22-release-0.4.0.md) |
| SQL 示例与强制更新提醒 | [提示示例验证](validation/2026-09-23-prompt-examples.md) |
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
| 表格读取、类型与差量写入 | `src/table-codec.js`、`src/table-writer.js` |
| 异步会话、初始化、消息与写队列 | `src/runtime-session.js`、`src/extension-runtime.js` |
| 宿主 API、界面 | `src/sp-adapter.js`、`src/st-adapter.js`、`src/settings-view.js`、`src/result-view.js`；宿主操作绑定在 `src/extension-runtime.js` |

根目录 `index.js` 为构建产物；历史桥夹具 `test/legacy/` 不参与构建。先按函数或关键词定位，避免读取整个生成包。

## 阅读与更新方式

按上表定位相关主题和函数；构建产物 `index.js` 不作为源码入口。验证命令和按改动选择检查范围的规则见[开发指南](development.md)。

行为或兼容范围变化时更新对应架构章节和兼容清单。具体测试结果与受测版本记录在日期验收文件，其他文档引用这些记录。
