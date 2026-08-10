# MVU 解析库（与 MagVarUpdate 源码同款）

`mvu-yaml-libs.js` 是 yaml@2.8 / json5@2.2 / jsonrepair@3.13 的 webpack 自包含 bundle
（target:web，内嵌 process/buffer 垫片），供 `parseInitVar` 使用——解析逻辑与
MagVarUpdate `util/common.ts` 的 `parseString` 完全一致（YAML → JSON5 → JSON(jsonrepair) → YAML 兜底）。

`jsonrepair-lite.js` 是 jsonrepair 单独的 33KB bundle，转换时内联进**卡内桥**，
让桥对 AI 输出的略畸形 JSONPatch 也能容错解析（与官方 extractCommands 一致）。

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
