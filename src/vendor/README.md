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

`mvu-schema.js` 复用本地 MagVarUpdate 快照 `src/function/schema.ts` 的 `generateSchema` 与 `reconcileAndApplySchema`（源文件 SHA-256：`e4b17f6f3f682fdc0e6f996706fbe39eb75875471215dd1ea48e56f422d1ae84`）。仅移除 TypeScript 类型与模块导入，以注入的 lodash 和 JSON 快照克隆替代其依赖；适用输入限于状态档案的 JSON 数据。保留上游 MIT 许可及处理顺序。用于状态导入时对照目标既有 Schema 调和动态字段，不运行作者 Zod 变换。

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

## EJS 解析库

`ejs-parser.js` 是提示词模板 1.17.9（d6f520d149aba146305b0b781ddd691d449c28d2）所使用的 EJS 3.1.9 浏览器库的冻结副本，新增自包含工厂外壳，保留原文件的 Apache-2.0 声明及完整许可。原库字节 SHA-256：`66b3c84f33adbf154950e18cb55704062e3fa5e2f4e69001f6df296d11548d54`。生成器内联同一工厂，Node/浏览器不依赖私有参考目录；没有运行时下载。

用于转换器的模板范围解析，运行时仍调用宿主提示词模板。不是提示词模板 AGPL 变量模块的副本；项目 LICENSE 保持 MIT。详见[复用验证](../../docs/validation/2026-10-08-upstream-reuse.md)。更新冻结库时核对来源和许可、保留字节指纹，重新验证嵌套标签、转义、空白控制及实际宿主执行。

冻结的 EJS 原库包含186行尾空白，按原字节保留；其完整内容可在工厂内逐字节核验。提交差异检查单独记录这一上游格式例外，其余文件仍检查空白错误。
