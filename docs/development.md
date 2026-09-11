# 开发、验证与排查

[文档索引](README.md) · [运行时契约](runtime.md)

本文维护稳定的开发流程；具体测试数量与版本证据见日期验收记录。文中的仓库路径均相对仓库根目录。

## 开始工作

检查 `git status --short`，保留已有未提交改动；按[索引](README.md)定位模块与函数，不默认读取生成包、vendor 或历史夹具。以对应版本上游源码核对行为，来源见[参考说明](../REFERENCES.md)。优先使用已有本地资料；参考仓库有未提交差异时保留工作树。

使用通用结构和语义规则，不针对卡名、角色名或某张卡的字段制作特例。无法证明等价的脚本和 EJS 保留并报告。

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
- 先运行与改动相关的 `--grep` 测试，交付前运行全量回归。
- 默认模式只输出运行数量和最终汇总；通过用例的 `console.log/info/debug/warn/error` 均不打印。
- 每个用例单独保留最后 20 条日志，单条最多 2000 字符；失败时在断言堆栈后回放，既保留现场又限制输出/上下文占用。
- 仅在主动诊断时使用 `--verbose` / `-v` 或 `TEST_VERBOSE=1`；详细模式显示分组、每条通过用例和完整 VM/数据桥日志。
- `test/real-host.js` 将源码构建到隔离扩展目录；交付时另行构建根目录并比较文件内容，不依赖硬链接。环境与固定版本证据见[实机记录](validation/2026-09-11-host.md)。

## 验证范围

使用 Node 22，开始前执行 `node --version`。核心回归使用内置模块、仓库源码和 vendored 解析库；实机另需宿主与浏览器依赖。

| 改动 | 验证 |
| --- | --- |
| 纯文档 | 链接、公开/本地边界、`git diff --check`；无需重建或启动宿主 |
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

共享架构和流程写入公开 docs，个人偏好、本机路径、私有卡诊断和交接留在本地；具体维护位置见[索引](README.md)。结论更新对应现行章节，过程进入日期档案，废弃方案不继续描述为当前架构。

源码和 Markdown/JSON/CSS/YAML 按 `.gitattributes` 使用 LF；图片和压缩文件不转换行尾。上游仓库遵循各自策略，不混合行为修改与大范围行尾变化。生成包中的 vendor 与模板字面量保留内容。
