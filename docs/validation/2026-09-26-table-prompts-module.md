# 表格提示词生成模块

## 范围

`src/table-prompts.js` 提取表格 note、初始化说明、规则措辞清洗与增删改操作示例。
`src/mvu2shujuku.js` 的 `buildNote/buildInitNode/buildNodeProse` 保留为薄转发，模板生成与
VWD 插槽规划通过同一工厂执行；浏览器单文件构建内联实际模块。

提取的函数体与变更前逐字节一致。组说明、可见性/只读/关系键判定、SQL 转义、Schema 示例和
VWD token 继续使用核心注入的原函数。没有更改 DDL、数据布局、类型编码或任何提示文案，
没有删除字段说明、更新条件、安全提醒及原有 SQL 示例。

## 验证

使用 Node 22：

```sh
node test/run-tests.js --grep '提示输出冻结|表格提示工厂'
node test/run-tests.js --grep '表格协议|特殊操作提示|强制更新提醒|SQL示例保真|JSON局部更新|字段说明保真|表格提示|业务规则保真|VWD'
node test/run-tests.js
node build-extension.js
node --check index.js
git diff --check
```

- 工厂的独立 VM 与真实转换入口检查 3/3 通过；相关领域回归 87/87 通过（部分用例重叠）。
- 公开输入冻结在重构前，覆盖三种模式、拆表/完整 JSON、关联表、类型约束、可空字段、VWD
  开关及更新提醒，共 33 组。Node 的 33 项对照及完整浏览器装配 VM 的一项全组合对照均通过。
- 对照完整模板、layout、每张表的 sourceData 摘要；上述样本的提示文字、SQL、数据和布局完全一致。
- 全量回归：540 通过、0 失败。构建、产物语法与差异格式检查通过。
- 未运行隔离酒馆或 token 成本基准。本批未改变宿主协议，已有生成文本保持一致；不宣称运行提速。

版本仍为 `0.4.0`，受测 `index.js` SHA-256：
`d638d83d9c6073b58125e3bab75c5f914893cba1db46b7dc0888dfd5311d166d`。
