# H01 表格与提示词复核

2026-10-11，0.8.0 未发布，未提交／推送。沿用 H01 冻结原卡；PNG SHA-256 为 `29cb8e7a0b1210798874888212453f006fd73b22eeec38c752f764f3d3dba19b`，与本次指定文件一致。第一批只检查转换产物及 SQLite 示例；第二批实施用户确认的布局规则并补验，见文末。未新增完整剧情验收结论。

## 首批发现

- 当前四张表：两个完整 JSON 容器与两张角色行表。其中较复杂的角色行表有 49 列，一个嵌套对象被递归展开为 30 列；包含动态字典与未知变换输出。建议按结构决定边界，复杂对象完整 JSON、纯固定标量对象保留展开能力。该表方案为 20 列；随后用户已批准并实施，见续验。
- 普通行表统一带可写“扩展数据” JSON 列，note 已说明用于记录未单独展开的字段。两张角色行表初始为空；列的存在不是已经漏掉已声明字段的证据。它与旧隐藏 `_扩展数据` 不同。
- 原业务要求条目完整保留，填表适配条目说明输出协议替换。原文本中的未引号宏令严格 YAML 解析失败，回退结构提取；不因此删除原业务要求。自动提取不等于全面结构化理解自然语言。
- 原 `number.transform(...)` 的任意函数输出不能仅按输入 number 推断。真实 Schema 执行器将这类输出保留为 unknown／完整 JSON；实际运行时 Schema 不变。问题是生成说明错误地限定为对象/数组，而不是底层 JSON 编码本身错误。

## 已完成的提示修复

用户明确要求删除的 SQL 示例共用提示整句移除；其他 JSON 指导去掉双模式条件措辞。未知类型说明改为完整 JSON 值，数字／布尔／null 不加 JSON 引号，字符串保留 JSON 双引号；标量整体更新，只有对象/数组才使用内部路径。对象/数组列继续保留其原说明。

实际实现入口：`schema-layout.optionalJsonContainerColumn` → `table-prompts.buildNote/jsonUpdateGuide` → `mvu2shujuku.generateTemplate`。存储类型、Schema、列和读写协议未改。

## 验证

- 相关 17/0：`node test/run-tests.js --grep '表格提示工厂|SQL转换|提示输出冻结'`，日志 `/tmp/m2sjk-h01-prompt-check-final.log`。覆盖真实注册 Schema 转换与无 Node 作用域的浏览器内联提示工厂。首轮 16/1 是新增夹具未导入注册接口，走了旧静态入口；补齐明确导入后通过，没有据夹具失败修改产品语义。
- SQLite 示例回归 5/0：`node test/run-tests.js --grep 'SQL示例保真'`，日志 `/tmp/m2sjk-h01-sql-example-check.log`。
- 11 个公开提示样本的 layout 摘要全部保持原值；仅更新提示输出摘要。
- H01 四张表逐字比较 content 与 DDL，修改前后相同；全部 DDL／种子行及 8 条生成 SQL 示例实际 SQLite 执行通过。原业务条目与作者原文相同。私有产物保存在 `.tools/h01-layout-2026-10-11/`。
- 根包已重建并通过语法检查。纯提示修正不重复完整回归或完整宿主。

当前指纹：schema-layout `e0940eeff4335c7f533b98db871dfd7271d8a7f0c1e90b13addbb5f78a7e2952`；table-prompts `e797b7a3d36c123b0a4cfc6465a6322d404d546ea9b6471f3b8a5eea655bc15a`；mvu2shujuku `f845ef2aaf1d277872280dd3c73c3564516d33898c9fe0d0525490f55736ee23`；根包 `d2524ae645fb31ea58715b0accea7dcf60464638eff234f10d94880e2fa022c0`。

## 用户确认的复杂对象布局与扩展数据说明

嵌套对象含动态字典、数组、可缺失/可空容器、隐藏 `$` 字段或未知变换输出时，保留整个对象为 JSON；纯固定标量对象仍可展开。H01 女性角色表由 49 列变为 20 列，“亲密状态”作为完整 JSON，角色仍按行保存。固定路径上的原范围、枚举继续生成适用的 JSON CHECK；不从未知变换反推输出约束。

入口为 `schema-layout.flattenFixedObjectColumns` 的结构判断；`buildSchema` 对过滤前的原记录仅检查隐藏字段存在，行表检查所有记录，不把隐藏值复制进 DEFAULT 或提示示例。`attachFieldRules` 对普通 JSON 列复用已有 JSON CHECK 生成，`stat-storage.plan` 的列名仍为“扩展数据”。

用户确认该列说明：“保存本记录中没有对应独立列的字段；没有明确更新依据时保持原样。”不加入数据还原的实现说明，不宣称前端维护，不假定额外字段都有作者更新规则。不改变原模型可见性，不新增以数据生产者为依据的写入权限。

原 MVU 源码中，`set` 要求目标路径已存在，但整体替换已有对象可以带入新的子键；`insert` 另按 Schema extensibility 判断。不能笼统地声称所有新增键都被原 MVU 禁止；本批没有增加根据 SQL 最终结果猜测原操作的拦截器。模板说明属于模型提示，不是数据库权限限制。

### 续验状态

- 结构与提示相关 33/0，包含真实 SQLite 约束和示例执行：`/tmp/m2sjk-h01-final-related.log`。
- 提示冻结、无 require 浏览器装配和结构相关 32/0：`/tmp/m2sjk-h01-final-output.log`。此后补齐无 Schema 行表的隐藏字段边界，新增真实转换回归，相关21/0：`/tmp/m2sjk-h01-hidden-boundary.log`。
- 宿主前 Node 夹具检查实际列类型、完整初值往返、隐藏值不进 DDL/提示，通过；这一步发现无 Schema 行表原记录定位遗漏，先修复再启动宿主，没有修改受测源码。
- 当前 H01 四表初值读回在布局修改前后相同，8 条 SQL 示例实际 SQLite 执行通过。原 InitVar 与模板读回还存在原有 Schema 声明的空日历容器差异，本批没有新增或删除该差异。私有最终转换产物在 `.tools/h01-layout-2026-10-11/final-*.json`；与旧提示批次产物分开保存。
- 隔离宿主 `node test/real-host.js --only=stat-storage` 通过：实际 SQLite 模式，新布局 JSON 局部写入保留同记录其他公开/隐藏字段，作者写入、刷新、数组所有权、数据库清空和完整恢复通过，pageerror 为零。日志 `/tmp/m2sjk-h01-complex-host.log`。实际宿主 ST1.18.0／TH4.11.3／EJS1.17.9／数据库 naiv1.2.9，浅加载开启；数据库包 SHA-256 `6bb1874681a7b6fc44913f01a8d899995e734a01c36167b400a6f7aee2d096ad`，不是参考库 HEAD。宿主启动包含外部文件 I/O 等待，不能据此归为插件写库耗时。
- 根与隔离扩展包均为 `39df6e772d56fdfc1bebe498a58185e939980f07b662867a53cfe922b4d54cbc`。进程33831身份确认后由夹具关闭，回读进程不存在且18173端口释放。辅助路径 manifest 的404在日志单列，不等同 pageerror 或功能失败。
- 完整公开回归执行944项，初轮939通过、5项旧预期失败；三项仍要求已删除的双模式提示，两项仍要求旧的整根JSON布局。保留SQL执行、类型、字段规则和完整读写断言，按已确认结果调整这些预期后，受影响批次24通过、1项同测试中的第二处旧提示断言失败；仅补该断言和JSON相关路径4/0。所有944项已覆盖通过，未重复全套。日志 `/tmp/m2sjk-h01-final-full.log`、`/tmp/m2sjk-h01-final-failed-paths.log`、`/tmp/m2sjk-h01-json-prompt-recheck.log`。
- 最终真实生成的列名/说明、根和隔离manifest均0.8.0、根包语法及 `git diff --check` 通过。产品源码在实机和完整回归期间未改；后续仅调整旧测试预期及文档。未提交、未推送。

最终源码指纹：schema-layout `df4cdcf5d67baaadd32e13cd6fbe17a9dfa53a5d30663aa74a6c66033bcb0f85`；stat-storage `ca0784e1b02243887df2ea10741b9e6a425650e8d294b72207a2df8857556aa8`；table-prompts `e797b7a3d36c123b0a4cfc6465a6322d404d546ea9b6471f3b8a5eea655bc15a`；mvu2shujuku `605b071260480ff0790d2c009f0c46e1f598d9586a759f2e1576c38f47851b17`。

## JSON 说明重复清理

用户确认按两类清理：完整 JSON 表的重复存储说明，以及 JSON 列追加的“读取时还原”实现说明。`table-prompts.buildNote` 对已在开头说明完整变量/记录的列跳过重复可空对象说明；对明确来源为 `full-json-container` 的列，仅移除匹配生成器固定前缀的两行，不改作者描述。普通 JSON 列仍保留必要的类型/编码说明。通用列规则不再附加“对象以 JSON 存储，读取时还原”。原 `desc`、约束、数据和读写协议不变。

- 相关18/0，包含11公开提示样本、实际转换和无require浏览器装配：`/tmp/m2sjk-json-note-dedup-tests.log`；11个layout摘要全部不变。
- H01四表DDL/content和完整Schema元数据与前批相同，重复生成句已移除，作者规则的现有渲染覆盖保持不变。检查原始描述时三行不能逐字命中，但清理前同样不能命中（既有路径适配），未当作本批删除。私有新产物 `dedup-*.json` 与前批实机产物分开。
- 根包重建/语法和 `git diff --check` 通过；只有提示渲染变化，不重复完整回归或隔离宿主。最新 `table-prompts` 为 `b343aa12f37b7d4cdbc4e1291979c52c6225690b7e627b587cba6258a15d4137`，根包 `0e17751d14d739581de5f2d744cb57c2c5bf018ba14d791c9c6f4a39cb624381`。前批实机受测仍是39df6e77，不能声称新包重跑了宿主。
- 同日通过GitHub接口重新核对 [历史读取PR31](https://github.com/AlbusKen/shujuku/pull/31)：open、merged=false、head仍412182b4。历史接入仍待上游接口；发送窗口保持用户明确延期，历史写入/非选中swipe/旧聊天自动迁移维持现有支持边界。第十张卡冷启动时序仅保留验收限制，没有新增已复现且可安全修复的问题。
