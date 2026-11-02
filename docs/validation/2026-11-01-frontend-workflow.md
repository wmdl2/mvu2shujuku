# 设置面板与转换结果工作流（2026-11-01，未发布）

## 行为与范围

设置面板区分状态存档与转换卡片，颜色跟随酒馆主题变量；结果按报告、可折叠表格设置、合并、下载／保存排列。表格显示已设置的参数，完整报告可复制，拖入文件只选中、不自动转换。

再次转换前，只有存在未保存的表格修改时才询问；取消保留当前结果和编辑。转换级规则（完整 JSON 容器、DDL CHECK、简单 EJS 翻译、MVU 兼容层、状态栏刷新）改变后，结果区提示重新转换。当前产物沿用核心已有转换会话，模板参数仍可编辑，PNG／JSON 格式可实时选择；各下载入口、合并与保存不再分别套用不同时间的转换设置。

文件读取期间有请求守卫。保存状态依据本次操作的结果，不沿用上次成功标记。原 MVU 变量行为、Schema 布局与数据库持久化协议未调整。

## 实现入口

- `settings-view.js` 生成控件；`result-view.js` 渲染报告和表格设置。
- `extension-runtime.js` 的 `confirmDiscardEditedResult`、`updateReconvertNotice` 与 `performConversion` 负责确认和规则快照；`refreshConvertedResult`／`applyMergeTables` 复用核心会话。
- `mvu2shujuku.js:extensionStyle` 为样式源，根 style.css 与 index.js 重建生成。

## 验证

使用 Node 22.23.2、本地 Playwright／Chromium、公开合成卡执行：

```sh
node build-extension.js
node test/run-tests.js --grep '结果设置|转换配置|手动合表|扩展安全门控|刷新'
node test/run-tests.js
node test/run-tests.js --grep '^审查：点击数据桥下载按钮得到可执行 JS 而非报告$'
node test/frontend-layout.js
node test/conversion-profile-ui.js
```

- 相关公开回归 34 通过。完整批次 1010 通过、1 项 DOM 夹具失败；给该局部桩补齐真实 DOM 的 dataset 与运行时初始状态后，失败项单独复验 1 通过。合计 1011 项全部闭合，产品源码／构建在这两次运行之间未改，未重复整套回归。
- 布局覆盖深色、浅色、自定义主题与 314／390／760 像素容器的 9 组组合，无编辑器或列表横向溢出，浏览器异常为零。
- 完整扩展包浏览器交互通过：配置匹配／拒绝、手动合并成功／失败、拖入与复制、结果顺序、五类规则提示、格式实时选择、取消重转保留编辑、确认重转应用选项、导出与保存载荷一致、保存进度／防重复及失败后保持未保存状态。整个 314 像素面板在三种主题下也通过溢出检查。
- 浏览器保存夹具提供明确的宿主世界书模块和 HTTP 替身，执行真实产品保存／存储适配器。它不启动完整 SillyTavern，不证明真实文件持久化或长剧情模型效果；原卡实机证据保留其原受测版本。
- 截图可通过 MVU_TEST_FONT 指定本地中文字体；字体与截图不打包进扩展。根包语法与版本核对通过；向独立临时目录重建的 index.js、style.css、manifest.json 与工作区逐字节一致。

受测 index.js SHA-256：`1ab6c36dec80bb72af7e8aa59f626a2ae5723f3b241de00115f0fc62f945149f`。版本仍为 0.8.4 的未发布工作树，未提交／推送；本记录不代表发布新版本。
