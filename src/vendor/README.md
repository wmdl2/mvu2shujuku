# MVU 解析库（与 MagVarUpdate 源码同款）

`mvu-yaml-libs.js` 是 yaml@2.8 / json5@2.2 / jsonrepair@3.13 的 webpack 自包含 bundle
（target:web，内嵌 process/buffer 垫片），供 `parseInitVar` 使用——解析逻辑与
MagVarUpdate `util/common.ts` 的 `parseString` 完全一致（YAML → JSON5 → JSON(jsonrepair) → YAML 兜底）。

`jsonrepair-lite.js` 是 jsonrepair 单独的 33KB bundle，转换时内联进**卡内桥**，
让桥对 AI 输出的略畸形 JSONPatch 也能容错解析（与官方 extractCommands 一致）。

`../sheet-identity.js` 的自包含工厂内嵌 pinyin-pro@3.28.2 的原始 UMD 发布文件和 MIT 许可，
匹配受测龙血玄黄·数据库 1.2.5 的物理表名算法 v1。原始文件为 npm 包的 `dist/index.js`，
SHA-256 `23b01bfc76de73a041dd2b1600f146f56a02611ae9033f0042d5d9ab19bce9d7`。
使用完整词组和繁体规则检测表名冲突；不以单字拼音字典近似宿主行为。
工厂进入插件构建，角色卡只保存分配后的表名，不包含此拼音库。

## 重新生成

```powershell
# 任意临时目录
npm init -y
npm install --no-audit --no-fund yaml@2.8.0 json5@2.2.3 jsonrepair@3.13.2 webpack webpack-cli buffer process
# entry.js：
#   const YAML = require('yaml');
#   const JSON5 = (require('json5').default || require('json5'));
#   const { jsonrepair } = require('jsonrepair');
#   module.exports = { YAML, JSON5, jsonrepair };
# webpack.config.cjs（见下文），输出覆盖 src/vendor/mvu-yaml-libs.js
```

webpack.config.cjs 要点：`target: 'web'`、`resolve.fallback { buffer, process }`、
`ProvidePlugin({ Buffer: ['buffer','Buffer'] })`、`output.library { type: 'commonjs2' }`。

jsonrepair-lite：同样的 webpack 配置，入口 `module.exports = { jsonrepair }`。
