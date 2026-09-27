# 下划线列名与只读提示验证（2026-09-23）

受测转换器为 0.4.0，根目录构建 `index.js` SHA-256 为 `7cbb0088c193d95901222faab523ba71f6b9ae85fcc45a0f592c4954219f2194`。

- 新模板仅在列标识符生成处保留原字段开头的下划线：`_状态` → `_zhuangtai`、`_扩展数据` → `_kuozhanshuju`。表名和普通列规则不变，大小写不敏感的重名仍追加序号。
- `hiddenPhysicalColumns` 引用新 DDL 的 `_kuozhanshuju`。表头、初始值和 layout 路径仍用原字段名；三种模式的只读提示统一举 `_扩展数据` 作为逻辑字段例子。
- 旧转换模板按已保存的 DDL、隐藏列名和 layout 读写；不迁移旧聊天。冻结旧模板的 `kuozhanshuju` 写入在公开 API 形状的测试替身中使用逻辑表头 `_扩展数据`，读回保留新增字段。

验证：

- `node test/run-tests.js --grep 'VWD动态说明|VWD动态提示|下划线|扩展数据|DDL|列名|表格协议'`：66 通过、0 失败。旧冻结对照只调整预期的物理列名、隐藏列名和只读例子，其他模板数据与 DDL 继续完整比较，未重生成冻结文件。
- 公开小样本生成的 DDL 在内存 SQLite 建表，并以 `_zhuangtai`、`_zhuangtai_2`、`_kuozhanshuju` 插入和查询：通过。
- `node build-extension.js`、`node --check index.js`、`git diff --check`：通过。

本批未启动隔离宿主；SQL 验证覆盖实际 SQLite DDL/数据读回，旧模板兼容覆盖仓库内公开冻结模板的读写。
