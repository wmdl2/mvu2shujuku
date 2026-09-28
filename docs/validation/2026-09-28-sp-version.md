# SP 脚本安装的版本识别与隐藏列提示

## 问题与修复

原转换入口只调用 SillyTavern 的扩展清单读取 SP manifest。酒馆助手用 `import` 加载 SP 时没有
对应扩展清单，因此即使实际运行 9.2.5.1 也会返回 unknown，并被误述为“不支持可靠隐藏”。
这不仅是文字问题：未知版本时生成器会保守不写 `hiddenPhysicalColumns`。

`sp-version.js` 现在优先读取启用的 SP 扩展清单。脚本安装的回退路径要求 SP API 已发布，
再从当前同源窗口的 ResourceTiming 查实际模块加载记录，识别官方 jsDelivr 固定标签：
`https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv9.2.5.1/index.js`。
识别支持 jsDelivr 的 CDN 子域、三段或四段版本，不依赖脚本名称或未运行的脚本配置。
下载/fetch 请求、非官方仓库、分支 URL、多个冲突标签、无加载记录均不推断版本。

报告分别说明“无法识别版本”和“低于转换器已验证基线”。未知不再等同于不支持，也不直接要求升级。
识别改变本次生成的模板，已转换卡和旧聊天不自动补写配置，需要重新转换才能获得新的隐藏列设置。

## 上游能力与验证基线

隐藏列并非 9.2.5 才引入。上游历史中的标准 `spv8.4` 不含该实现，`spv8.5` 已有：

- `src/shared/models/table-data.ts` 的 `hiddenPhysicalColumns`。
- `src/shared/ddl-utils.ts` 的可见列与 DDL 投影，禁止隐藏 row_id。
- 提示构造和可视化编辑器对可见列的投影。
- `sql-table-service.ts` 的隐藏列写保护，由 `update-orchestrator.ts` 实际调用。

对应首次源码提交为 `15c31a7933526d4e1b1aa51153d485dbdbbf1858`，标准 `spv8.5` 标签为
`8c8abb23840dafa6f8ffa082745ce79f76e871ee`；见[上游字段定义](https://github.com/AlbusKen/shujuku/blob/spv8.5/src/shared/models/table-data.ts)。
`spv9.2.5`（`5c53f795…`）与 `spv9.2.5.1`（`8646e5cc…`）均有隐藏能力，但后者的
[manifest](https://github.com/AlbusKen/shujuku/blob/spv9.2.5.1/manifest.json)仍声明 9.2.5。
因此导入标签和内部版本字段不能视为始终一致。

9.2.5 继续作为本转换器已验证兼容基线。本批没有把较早版本的源码存在证据当成转换器端到端验收，
也没有降低旧版门控。扩展与助手脚本安装形态本身不决定有没有隐藏能力。

## 验证

使用 Node 22：

```sh
node test/run-tests.js --grep 'SP版本识别|模板内部列|VWD'
node test/sp-version-browser.js
node test/run-tests.js
node build-extension.js
node --check index.js
git diff --check
```

- 相关回归最终 69 项通过（初次68/1为旧警告字符串断言，更新后该项1/1）。
- 浏览器在真实 iframe 中 import 同一官方 URL，以固定模块模拟 SP API：ResourceTiming 类型为
  script，识别结果为 9.2.5.1；没有下载或执行完整 SP。
- 实际转换入口接受识别结果后生成隐藏列；旧版本和未知版本仍保守降级，并分别报告。
- 独立 VM 的工厂内联、禁用扩展、跨源窗口、冲突标签和非官方 URL 均覆盖。
- 最终全量 561 通过、0 失败；构建、语法和格式检查通过。未启动完整酒馆或重做旧兼容审查。

上述全量回归时版本为 0.4.1；受测 index.js SHA-256：
`7f4dced677a937998f316af4dd6d02af645cd1fe979c05a7084a672e3e9c75fe`。

发布版本为 **0.4.2**。版本收尾仅修改版本常量、发布说明并重新构建；源码及构建产物与上述受测版本对比，除版本字符串外逐字节一致，未重复运行全量回归。版本一致性、构建语法及差异检查通过。
发布 index.js SHA-256：
`0b205dc7b304bd6f31368e48cc291081de77080cac667f6897cbe61c76726044`。
