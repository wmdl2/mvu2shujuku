# 旧布局测试资料

## 布局冻结输入输出（2026-10-12）

layouts.json.gz 保存来自 96067ef 的公开合成数据：已发布 0.8.0 转换布局和显式 version-1 构建器布局分开，VWD 全局开关也进入键。原输入在各 spec 中，SHA-256 使用 JSON.stringify([source, options])；前缀 published: / vwd: 区分契约。私有卡不进入此文件。

通过 frozen-value-codec 的类型帧保存 undefined、集合和非有限 Schema 边界。可用 Node 的 zlib.gunzipSync、JSON.parse 和 decode 检查内容。捕获先复制，再由真实产品 writer/codec/runtime 执行测试，不能把测试后数据当成初始期望；公开回归不在运行时加载本地旧源码。
