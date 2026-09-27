# TauriTavern 2.3.0 角色卡文件导入核对（2026-09-27）

## 范围与版本

目标是让下载的转换卡在 TauriTavern 文件导入后保留内嵌世界书、SP 模板元数据及酒馆助手脚本。受测宿主由用户确认与本地 `TauriTavern` 2.3.0 / `a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375` 一致。SP 参考源码为 `599e3580c3106fa234ead38fdfe8625080419143`；它是参考版本，不等同于用户实机的 SP 构建。

本轮没有在本机启动 TauriTavern；文件导入和新聊天弹窗来自用户实际操作。公开合成样本是最小数据库卡，不含第三方角色卡内容。样本及执行日志保存在忽略的 `.tools/tauritavern-2026-09-27/`，不进入提交。

## 发现与修复

原先 `packageConversion` 对旧式输入直接把顶层角色数据写成 JSON/PNG。TauriTavern 的 `Character::from_card_value` 只从 v3 `/data` 投影 `character_book`；`import_character` 的自动世界书导入据此读取 `character.data.character_book`。因此旧式输入生成的下载文件虽在顶层有世界书，TauriTavern 文件导入路径仍可能跳过它。

下载装配现对没有 `data` 的旧式输入增加 `spec: chara_card_v3`、`spec_version: 3.0` 和 `data` 外壳。JSON/PNG 共享这份文件数据，保留内嵌书、`extensions.world`、`extensions.tavern_helper` 和转换元数据。内部 `result.card` 及直接保存路径保持原结构；已有 v3 输入不重复包装。

插件的直接创建路径会把 `world` 字段交给宿主。TauriTavern 的 `materialize_create_lorebook` 在指向的本地世界书不存在时记录 `without embedding lorebook`，但继续创建角色。这解释了用户先前看到的提示；它本身既不证明书已导入，也不证明角色创建失败。文件导入调用另一条 `try_auto_import_embedded_world_info` 路径。

## 验证与当前边界

- `test/card-conversion-fixes.js` 新增旧式输入 JSON/PNG 下载和已有 v3 输入回归；`test/refresh-conversion.js` 更新两项旧下载格式断言。经过产品的 `convert` 和 PNG 编解码入口，不用复制产物构造逻辑。
- Node 22 构建 `index.js`；源码及构建语法、`git diff --check` 通过。最终全量 `node test/run-tests.js`：**557 通过，0 失败**。
- 公开样本文件 `.tools/tauritavern-2026-09-27/TT兼容验收样本_数据库-DB.json`，SHA-256 `0e2cf3fcae473d14266dd0fd44540fe24f67c8c4bf73efb3f2da69ff6d1146b7`。内嵌世界书名 `TT测试世界书_数据库`，单例状态表 `生命` 初值 10。`src/mvu2shujuku.js` SHA-256 `99fb6f7abe9f7b0339809f560b3f26e2dab5120c7ce7f90cf167d4a3be59c885`；`index.js` SHA-256 `266aa54f5593217fccf51de78260e994fa683a2e5fc856738d763cfe90ca31b8`。
- 用户在 TauriTavern 导入公开样本后反馈“其他都正常”，但新建聊天时出现“世界/知识书冲突”：本地与内嵌名称均显示 `TT测试世界书_数据库`。TauriTavern 源码实际比较内容的规范化结果，而不是仅比较名称。用户导出的本地世界书 SHA-256 为 `f8db0e6cd3fc588e406dbde6fc6cacd4163bff7ee124fae951b650ca55ff02b9`。卡内只有 `__ACU_TEMPLATE_DATA__` 一项；本地有四项，新增 `TavernDB-ACU-ReadableDataTable`、`TavernDB-ACU-WrapperStart`、`TavernDB-ACU-WrapperEnd`。模板条目的 base64 正文逐字节一致，本地可读表显示“生命”10。这三个条目与 SP·数据库本地源码的世界书注入实现一致，因此冲突来自开聊后本地世界书被 SP 更新，而非书名比较误报。导出的本地书只有 `entries`，没有导入时的 `originalData`；即使不计新增条目，比较结果也需要以 TauriTavern 实际持久化内容为准。

用户进一步确认：标准下载卡选择“保留本地”后，每次新建聊天仍出现冲突弹窗，但状态表“生命”一直为 10。仅引用本地世界书、不带 `data.character_book` 的**探针文件**在保持同名本地世界书的固定顺序复测中，新建聊天不弹窗，状态表“生命”为 10，保存并重开聊天后仍为 10。此前探针卡显示默认表时，同名本地世界书另一次导出为 `{"entries":{}}`（SHA-256 `3dc8f49758f1336b64c32ad0c3bea1b8bcd32e06e3c5563dc92204ca4508683e`）；中间存在删除与重导入操作，不能把空书归因于单纯切卡。探针依赖预先存在且带模板条目的本地世界书，单独导入它不是可迁移方案。

**当前标准下载卡可使用，但每次新建聊天会被世界书冲突弹窗打断。** 用户进一步实测，选择“保留本地”或“使用内嵌”均未改变状态表数据。SP 的表格权威记录在聊天消息字段中；世界书中的可读表和包裹条目由聊天数据派生。“使用内嵌”仍会替换本地世界书，可能移除其中的其他自定义条目或暂时影响注入给模型的内容；它不直接改写已保存的聊天表格。“暂不处理”会取消本次新建聊天。用户认为冲突没有造成实际表格问题，本轮不增加 TauriTavern 专用双文件导出。先前的无内嵌探针依赖本地世界书，不能单独作为通用下载卡。

原版 SillyTavern 本地源码（`8172dcd`）的 JSON/PNG 导入会对带 `spec` 的卡走 `readFromV2`，保留 `data.character_book` 并将主要 `data` 字段映射到宿主角色字段；旧式无 `spec` JSON/PNG 则经 v1 导入分支重建部分字段。故本次 v3 外壳也作用于原版 SillyTavern 的下载文件导入，预期改善世界书与扩展字段保留；没有为此单独做原版宿主实机导入。插件内部转换结果、直接保存路径和已有 v3 下载文件不变。

尚无完整的 TauriTavern + SP·数据库 + MVU + 酒馆助手组合验收：公开样本已覆盖初始表、重开读回和冲突行为；真实业务写入、MVU/酒馆助手脚本、删楼和 swipe 回放未在此宿主完成。源代码合同测试只证明文件导入与世界书自动绑定能力，不代替组合实机验收。测试样本的结果不能外推到任意真实角色卡。
