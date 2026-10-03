# 开发、验证与排查

[文档索引](README.md) · [运行时契约](runtime.md)

本文维护稳定的开发流程；具体测试数量与版本证据见日期验收记录。文中的仓库路径均相对仓库根目录。

## 开始工作

检查 `git status --short`，保留已有未提交改动；按[索引](README.md)定位模块与函数。以对应版本上游源码核对行为，来源见[参考说明](../REFERENCES.md)。

使用通用结构和语义规则，不针对卡名、角色名或某张卡的字段制作特例。无法证明等价的脚本和 EJS 保留并报告。

### 提示词维护原则

完整且可识别的旧变量输出格式文档属于宿主填表协议，转换时整条移除，不把附加句子拆成启用的普通世界书条目。此边界由文档归属和结构确认，不按具体协议说明的措辞白名单决定；剧情、EJS 和不可解析的混合内容仍保守保留。不要把“格式已接管”报告成“所有附加业务条件均已迁移”。

静态更新规则按来源路径和 schema 中实际保留的 check/note 拆分，不能只凭相同句子判定迁移。只删除已承接项及其空分支，未知补充字段和未承接规则维持原世界书设置；报告须说明剩余内容未进入填表侧。不存在通用的“全局规则”分组协议，不按名称补造全局变量或逐表复制规则。EJS、解析失败和 YAML 共享节点不拆分。

表格 note 与操作触发条件描述业务约束，输出语法和行列编号由宿主当前填表协议及数据呈现提供。双模式不逐表重复 native/SQL/严格 JSON 的定位分支，也不在单例业务句子中固定 `row_id=1`；只对 JSON 写法与 SQL 示例说明适用协议。关键范围决定（例如新增响应协议、改变默认行为）先向用户说明并确认，再实现。公开样本对照需区分数据映射与动态说明正文缓存，文案变化可更新缓存，不能笼统声称完整 layout 字符串不变。

提示词以含义完整、字段归属清楚和操作安全为优先，篇幅不是首要目标。不得为了精简删除字段
含义、单位、格式、例外条件、更新规则或有用的操作示范；无法确认内容重复时保留。
列名由表头/DDL 提供，note 应保留原卡给出的业务说明，不凭常识补写作者没有提供的规则。
同一字段内逐字相同的条目可以去重，不把多个字段的说明或条件折叠成一个模糊标签。
规则清洗不能仅凭「指令」、操作名或路径判断内容无用；改写已识别的 MVU 机制时，保留参数值、
前置条件和例外。含义不明或夹杂业务的文本保留原文，并用公开合成用例覆盖这些边界。
调整示例须检查类型、范围、枚举、JSON 编码和完整定位，并明确区分示范值与本轮实际值。
SQL 示例应实际执行并核对结果，不能仅测试其包含 INSERT/UPDATE 字样。

## 构建与测试

```bash
node build-extension.js
node test/run-tests.js
node test/run-tests.js --grep "桥|扩展"
node test/run-tests.js --list --grep "初始化"
node test/run-tests.js --verbose
```

维护要求：

- 修改源码后必须运行 `node build-extension.js`。
- 构建后检查 `index.js` 语法，并确认 `manifest.json` 与源码版本一致。
- 提交或推送已完成的产品行为变更前，默认完成发布收尾：递增补丁版本，将“未发布”更新日志转为带版本和日期的正式条目，同步 README／兼容清单并重建产物；用户明确要求保留草稿或指定版本时按其要求处理。纯文档或命名整理不自动升级版本。版本与文档仍使用旧值的一致性检查不能代替版本升级。
- 按可独立验收的行为组成批次：局部修复先跑相关 `--grep`，一批修改稳定后、交付前统一运行一次全量回归和构建；不要求每个编辑步骤或每个待办完成后都跑全量。
- 默认模式只输出运行数量和最终汇总；通过用例的 `console.log/info/debug/warn/error` 均不打印。
- 每个用例单独保留最后 20 条日志，单条最多 2000 字符；失败时在断言堆栈后回放，既保留现场又限制输出/上下文占用。
- 仅在主动诊断时使用 `--verbose` / `-v` 或 `TEST_VERBOSE=1`；详细模式显示分组、每条通过用例和完整 VM/数据桥日志。
- `test/real-host.js` 将源码构建到隔离扩展目录；交付时另行构建根目录并比较文件内容，不依赖硬链接。环境与固定版本证据见[实机记录](validation/2026-09-11-host.md)。

## 验证范围

特殊关联提示使用 `node test/real-host.js --only=prompts --filter-initvar --relation-prompts`。
模板库存和同一请求的说明增量由 `test/measure-template-delta.js` 计量，复现与边界见
[增量测量](benchmarks/prompt-2026-09-15.md)。夹具按实际列编码读写，路由回调异常交回主流程收尾。

新增相关源码改动或检查失败时，先运行受影响的场景；实机失败先定位原因，再重跑受影响的场景。纯文档修改无需重跑产品测试。

连续调试时可在隔离环境使用 `--keep-server`，后续用 `--reuse-server --only=...` 复用专用服务器。浏览器仍由测试脚本管理；结束后关闭保留的服务器。不要连接日常使用的酒馆实例。

通用路径、标量类型和规则迁移边界使用公开 `test/converter-contracts.js`；双模式实际保存/重载使用 `--only=converter-contracts`。宿主夹具必须满足共用入口的前置条件；特殊原型键在 Playwright 参数和返回值边界使用 JSON 文本传输，再解析为 own-key，不能把测试工具的键丢失算成产品失败。

使用 Node 22，开始前执行 `node --version`。核心回归使用内置模块、仓库源码和 vendored 解析库。

TauriTavern 的 iframe/global/滚动组件取证使用 `node test/tauritavern-audit.js`，需要参考源码树、参考 SillyTavern 的 jquery/lodash 和 Playwright 浏览器。占位符组件另需参考 SillyTavern 的 TypeScript，脚本从助手源码提取实际函数并去除类型。可用 `MVU_REFERENCE_ROOT`、`MVU_HELPER_ROOT` 选择参考区和助手源码版本，`MVU_TAURI_AUDIT_OUTPUT` 指定结果目录。脚本只用公开合成卡、当前插件构建和实际参考模块，数据库 API 为替代实现；原 MVU 对照运行真实 initGlobals 发布函数，engine/store/watch 为替代实现。默认输出观察记录，退出成功不等于正式 WebView/native/SQLite 验收通过；`MVU_TAURI_ASSERT_FIXED=1` 额外断言 v0.4.9 修复的接口行为、原发布协议冷恢复读值和无浏览器异常；占位符分支由 `test/tauritavern-placeholder.js` 执行实际助手消息更新/刷新函数与 TT updateMessageBlock/渲染事务，格式化、前端挂载、装饰器和数据库为替代实现。覆盖边界见[运行兼容性审查](validation/2026-10-03-tauritavern-runtime-audit.md)。
SQLite 执行检查另需 Python 3 标准库 `sqlite3`：Windows 默认 `python`，其他平台默认 `python3`，可用 `PYTHON` 指定解释器；测试进程固定 Python UTF-8 输入，与 Node 传入的 JSON 编码一致。实机另需宿主与浏览器依赖。
JSON 路径更新及固定附属字段的填表、重载和删楼场景使用 `node test/real-host.js --only=json-path`，
范围见 [JSON 与合表验收](validation/2026-09-14-json-path.md)。

| 改动 | 验证 |
| --- | --- |
| 纯文档 | 链接、内容准确性、`git diff --check`；无需重建或启动宿主 |
| 转换、运行时、构建代码 | 相关行为回归，再全量测试、构建、产物语法检查 |
| 宿主事件、持久化、保存或 UI | 加测受影响的真实宿主场景 |
| 性能 | 同环境同输入对照，分别记录 CPU、调用数、真实保存耗时 |

`test/synthetic-card.js` 是公开合成卡；`test/fixtures/` 为不提交的参考卡附加数据。公开 checkout 缺失私有 fixture 时明确跳过对应测试，其余核心回归仍运行。异步边界优先使用可控时钟与 deferred Promise。`test/legacy/` 的冻结旧桥只用于兼容测试。

测试数量只在日期验收记录和更新日志中维护，不在本流程复制。`node test/benchmark-diff.js` 测量边界见[差异基准](benchmarks/diff-2026-09-10.md)；`node test/benchmark-refresh.js` 对照完整转换和参数刷新。内存测量不证明真实聊天端到端提速。

## 高频排查

### 初始化失败

1. 看 `[SyncBridge]` / `[游戏初始化]` 的第一个 SQLite 错误。
2. 对照 DDL 检查是否把描述文字当成枚举，或把哨兵值写进数值 range。
3. 检查 JSON 列默认是否为合法 `{}` / `[]`。
4. 确认宏已替换，固定表/列名未被动态宏改写。

### 前端反复刷新或卡顿

1. 统计 `replaceMvuData` 实际调用次数，不要把每个 CRUD 的栈误当成多次前端提交。
2. 统计 `manual_crud`、`MVU 变量更新`和事件总线发送数。
3. 检查批量写入的表更新回调是否被抑制，结束后是否只广播一次。
4. 比较写前与读回 `stat_data` 形状，检查是否人为补入「键名」或丢失部分嵌套字段，形成回声振荡。
5. 若删楼/切 swipe 后表已回退而前端未变，检查 `[聊天回放兜底/*]` 是否取得完整快照；旧值和半物化表不应被提前广播。

### 表格有值、前端缺字段

1. `window.getAllVariables()` 检查数据库映射结果。
2. `Mvu.getMvuData()` 检查前端实际视角。
3. `AutoCardUpdaterAPI.exportTableAsJson()` 检查运行时表格。
4. 核对 layout 的 `path` / `writePaths` / 展开列路径。
5. 检查 `_扩展数据` 是否含未建列叶子，读回时是否“只补缺失”深度合并。

### 切卡后读到上一张卡

- 检查当前 layout 表名与 `exportTableAsJson()` 的表名差集。
- 确认写库在运行时异步加载窗口内被拒绝，而不是把上张卡的表作为当前基线。

## 改动检查清单

交付任何转换/兼容修复前，至少检查：

- [ ] 是否为通用结构规则，而非卡名/字段特例。
- [ ] 轻量桥登记、扩展运行时及历史桥退出交接是否仍符合各自契约。
- [ ] 完整初始化与普通差量更新是否没有混淆。
- [ ] 无变化写入是否跳过持久化和事件。
- [ ] 动态键、有限通配键与真无限结构是否正确分类。
- [ ] JSON 类型、默认值和 CHECK 是否一致。
- [ ] 未知脚本/EJS 是否被保守保留。
- [ ] 宏是否调用 SillyTavern 原生替换。
- [ ] 切卡、首楼替换、多 swipe 和 iframe 路径是否考虑。
- [ ] 相关测试与全量回归是否通过。
- [ ] `node build-extension.js`、`node --check index.js`、`git diff --check` 是否通过。
- [ ] 版本号、`README.md`、`COMPATIBILITY.md` 和对应架构文档的对外声明是否一致。

## 文档与行尾

架构与流程变化更新对应现行章节；验证结果记录在日期验收文档。公开文档不包含私有角色卡内容、凭据或机器绝对路径。

源码和 Markdown/JSON/CSS/YAML 按 `.gitattributes` 使用 LF；图片和压缩文件不转换行尾。上游仓库遵循各自策略，不混合行为修改与大范围行尾变化。生成包中的 vendor 与模板字面量保留内容。

## 分批验收与证据复用

每批先写清行为边界、受影响入口与缺失证据，复用上一批已通过且指纹未变的结论。按“转换/读回 → 写入载荷与读回 → 实际运行时 → 必要宿主场景”推进；针对性检查稳定后再跑一次全量，不按每次编辑重复全量。

启动浏览器前，用 Node 检查夹具满足所复用宿主函数的前置条件，包括初值、表头、模式及安装产物。运行宿主验收前固定源码和构建指纹；运行中不要修改受测源码。失败先区分产品、夹具、环境，保存证据后只补失败或尚未覆盖的路径，不能把夹具失败当成产品结论。

实机脚本默认将运行数据、截图和日志写入仓库内被忽略的 `.tools/real-host/`。报告受测版本、命令、结果和未覆盖项时，保留可核对的摘要，避免提交原始数据或长日志。

有限字段、完整声明路径与业务 ID 列使用 `node test/real-host.js --only=bound-fields`，覆盖 SQLite/原生模式的初始化、写入、重载和删除。启动前核对浏览器安装的操作系统；可用 `MVU_TEST_BROWSER` 指定本机可执行文件。模板作用域拒绝等初始化问题可加 `--sp-warnings`：在加载前启用隔离宿主的警告选项，避免只凭最终超时推断根因；诊断可用 `MVU_INIT_TEST_TIMEOUT` 缩短等待。

完整 JSON 容器回归：`node test/run-tests.js --grep '完整JSON容器'`；
夹具预检查：`node -e "console.log(require('./test/full-json-host').preflight())"`；
实机入口：`node test/real-host.js --only=full-json`。若只改变 DDL 默认值，
`--full-json-initial-only` 可补实际初始化/刷新而不重跑全部状态链；证据须区分两次受测包。
静态成本：`node test/measure-json-containers.js`，按模板部件计量，不代替完整请求或真实模型质量测试。


### 转换结果界面验收

结果视图逻辑位于 `src/result-view.js`，运行时调用同一个工厂，装配器通过 `toString()` 内联。
纯逻辑与模板刷新回归用 `node test/run-tests.js --grep '结果设置'`，包括旧配置缺字段、显式 false、其他导出设置保留和布局不变。
宿主用 `node test/real-host.js --only=ui`；直接进入转换界面场景，不先执行聊天写入验收。
公开三表夹具在 `test/frontend-card.js`，两张选中表和一张对照表用于检查选择隔离；
`test/frontend-host.js` 覆盖筛选后选择、批量数值、主注入开关、下载/配置复用、报告文本安全与窄屏截图。
独立组件布局检查用 `node test/frontend-layout.js`，覆盖宽屏窄侧栏和手机；同时检查外层编辑器与内部列表的溢出。`MVU_TEST_FONT` 可指定本地中文字体，不把字体资源打包进项目。


### 转换配置与合表验证

配置数据规则直接调用 `src/conversion-profiles.js`，用真实的模板合并和结果视图配置方法：

```sh
node test/run-tests.js --grep '转换配置|手动合表'
node build-extension.js
node test/conversion-profile-ui.js
```

独立浏览器检查复用布局测试的 Playwright/Chromium 安装及 `MVU_REFERENCE_ROOT` 配置。
它加载完整扩展包，通过真实按钮完成转换、配置确认、下载与合表；SP/ST 接口由替身提供，
不启动 SillyTavern 服务，也不证明宿主持久化行为。覆盖拒绝配置不覆盖旧配置、手动合表刷新失败
不提交来源引用，以及成功后保存引用。输入来自公开合成卡，无需私人夹具。

可选第一个参数指定受测 `index.js`；`MVU_PROFILE_UI_TEST_DIR` 指定产物目录，默认
`.tools/conversion-profile-ui`。浏览器退出由 `finally` 清理，错误导致命令失败。


### 表格提示输出对照

`test/table-prompt-cases.js` 提供公开输入，`test/table-prompt-baseline.json` 保存重构前的输出摘要。
`test/table-prompt-output.js` 同时经过 Node 转换核心与无 `require` 的浏览器装配 VM，比较完整模板、
layout 和逐表 sourceData。模板摘要包含实际字符串，因此说明、空白、SQL 示例及字段内容变化都会被发现。

```sh
node test/run-tests.js --grep '提示输出冻结|表格提示工厂'
```

摘要按 33 种模式/容器/说明配置组合登记。有意修改提示或结构时，先核对失败用例所指向的表，
确认实际文本与结构差异，再更新相应期望；不为让重构通过而整体重新生成基线。
日常措辞修改按相关用例验证，不因存在冻结样本而增加整套宿主或成本基准验收。


### 写入结果与旧接口

新调用使用 `writeStatDiffToDbResult` 的 `ok`，不要用计划数量判断成功，也不要读取旧失败标记。
`test/table-writer.js` 覆盖同一实例的交错结果、降级、回放跳过和部分写入；
`test/runtime-native.js` 经过实际装配的运行时检查候选拒绝与有界重试。

```sh
node test/run-tests.js --grep '写入结果|写入适配模块|开场快照|当前楼批次|写入楼层|数组差量'
```

纯接口调整优先复用这些调用载荷和 VM 行为检查；涉及宿主保存能力或读回语义时再补对应实机场景。


### 内存生命周期验证

```sh
node test/run-tests.js --grep '运行内存|runtime globals|runtime windows|旧桥|切卡'
node test/runtime-memory-browser.js
```

第二条使用与独立界面验证相同的 Playwright 安装（可用 `MVU_REFERENCE_ROOT` 指定资料目录），
执行真实窗口登记工厂，循环创建/移除 100 个 iframe，然后通过 CDP 回收并检查弱引用。
覆盖还原失败的弱键记录，不启动酒馆；结果可用 `MVU_MEMORY_TEST_RESULT` 指定 JSON 输出路径。
这证明受测组件的引用能够释放，不代表完整宿主长时内存曲线。新增缓存时应检查所有顶层持有者，
不能仅凭局部 observer 已 disconnect 判断窗口已释放。


### 数据库安装形态与版本识别

```sh
node test/run-tests.js --grep 'SP版本识别|模板内部列|VWD动态说明：目标 SP'
node test/sp-version-browser.js
```

浏览器组件沿用 Playwright 测试环境，以固定响应模拟旧 `spv9.2.5.1` 和新 `naiv1` 官方模块 URL，验证 iframe 的真实 import
和 ResourceTiming。只模拟数据库公开 API，不运行完整数据库，不将此结果写成新版宿主兼容验收。
官方标签历史用于确认功能存在，最低受测版本与功能引入版本须分别记录。
