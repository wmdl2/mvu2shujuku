# 2026-09-12 首批语义与表格修改验收

基线 `d102648`，工作树中的未发布修改，源码与 manifest 仍为 `0.3.18`。范围：公共 MVU getter/VWD/路径、递归 setter 异步等待、生成模板的父子顺序和协议提示。没有重新执行上一轮历史问题的综合审查。

## 自动化与构建

Node 22.23.2：

- 定向回归 `--grep '公共 MVU API|表格归组|表格协议|SQL 示例|单例 UPDATE|数组表提示词|通配路径字段|INSERT 示例'`：17 通过，0 失败。
- 最终全量 `node test/run-tests.js`：311 通过，0 失败；其中宿主上下文总线遗漏先由失败回归复现，修复后 5 条公共 API 定向回归也全部通过。
- `node build-extension.js`、`node --check index.js` 通过；生成产物与隔离宿主安装的扩展包一致，manifest 与源码版本一致。
- 新增 10 条行为回归：`test/mvu-public-api.js`（5）、`test/table-order.js`（4）、`test/table-prompts.js`（1）。已有 SQL 示例测试改为明确的 sqlite 模式，保留其内容/列数/只读约束断言。

测试覆盖数值/布尔两元素数组与 VWD 区分、点号与方括号、引号/空键、字面键优先、缺失路径不创建、异步监听器修正完成时机；表格覆盖祖孙、同名子键、歧义父组、schema/layout/UID/行数据保持不变；模式测试覆盖 note 不编号、native/both 不混入生成 SQL 示例且 DDL 不变。

## 定向宿主场景

入口：`node test/real-host.js --only=public-api`。固定 SP `5c53f795832b194ec4baa74135e8ebd950122438`，宿主 SillyTavern `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`、TH `9481c5a34f74007a3f3211fd376f486e617654ab`、EJS `d6f520d149aba146305b0b781ddd691d449c28d2`，延用前次固定环境，只运行本轮新增场景。

测试在与 TH iframe 事件共用的宿主 eventSource 注册异步监听器，要求 setter 返回前完成第二字段修正，再提交并重载确认两个字段都保留。主窗口的 DOM eventOn 兜底不提供 async handler 等待，TH 4.9.5 也不提供主窗口 `TavernHelper.eventOn`；测试不把这两个入口误作 TH iframe API。

宿主通过：运行 `2026-09-12T12-40-18-445Z`，native 模式。普通两元素数组读回 `[10,20]`；方括号路径写入金币 41，异步监听器将生命改为 73；setter 返回时监听器已完成，提交重载后两字段仍为 41/73。浏览器错误列表为空。定向测试仅验证当前公共 API 与该总线入口，不代表 SP 自动填表提交后的参数修正契约已解决。

首次真实场景暴露：无可用 iframe eventEmit、窗口也没有 eventSource 时，扩展遗漏上下文中的共享总线。新增回归先得到 0 次发射的失败，再补 `getContext()` 兜底；已有 TH 发射器时不再向上下文重复广播。测试结束后关闭浏览器及本轮保留的隔离服务器。

## 测量与未覆盖范围

同一本地参考输入的双模式模板仍为 15 表；note 与三个触发说明合计减少 4,463 个 JavaScript 字符，initNode 与 DDL 不变。这是模板组件测量，未统计最终请求 token，未进行模型 A/B，不承诺模型质量或速度提升。

不自动迁移旧聊天的模板顺序，不改变 nullable 存储、SP 提交后业务事件回写、展示/差量视图等尚未实施契约。SP 参考库更新到 `8646e5cc` 只证明参考资料已更新，不等于完成该版本宿主验收。
