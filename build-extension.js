#!/usr/bin/env node
/*
 * 构建 SillyTavern 原生扩展：读取 src/mvu2shujuku.js，装配出仓库根目录可直接安装的扩展文件。
 * 用法：node build-extension.js [输出目录]（默认仓库根目录）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CORE_SRC = path.join(__dirname, 'src', 'mvu2shujuku.js');
const PINYIN_SRC = path.join(__dirname, 'src', 'pinyin-data.js');
const YAML_LIBS_SRC = path.join(__dirname, 'src', 'vendor', 'mvu-yaml-libs.js');
const OUT_DIR = process.argv[2]
    ? path.resolve(process.argv[2])
    : ROOT;

const coreSource = fs.readFileSync(CORE_SRC, 'utf8');
const pinyinData = fs.readFileSync(PINYIN_SRC, 'utf8');
const yamlLibsData = fs.readFileSync(YAML_LIBS_SRC, 'utf8');
const core = require(CORE_SRC);

// 浏览器端没有 require：把拼音字典内联成 root.__MVU2SHUJUKU_PINYIN__
const pinyinInline = pinyinData
    .replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ')
    .replace(/;\s*$/, ';');

// 与 MVU 源码同款的解析库（yaml/json5/jsonrepair）：bundle 是 CJS，
// 浏览器端包一层 module 捕获导出后挂到 root.__MVU2SHUJUKU_YAML_LIBS__。
const yamlLibsInline = [
    '(function () {',
    '  var module = { exports: {} };',
    '  var exports = module.exports;',
    yamlLibsData,
    '  var target = typeof globalThis !== "undefined" ? globalThis : this;',
    '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;',
    '})();',
    '',
].join('\n');

const files = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline });

fs.mkdirSync(OUT_DIR, { recursive: true });
// 只写扩展运行文件；README 以仓库根目录的手写文档为准
for (const [name, content] of Object.entries(files)) {
    if (name === 'README.md') continue;
    const target = path.join(OUT_DIR, name);
    fs.writeFileSync(target, content, 'utf8');
    console.log('已生成', path.relative(ROOT, target), `(${content.length} 字节)`);
}

// 语法校验生成的 index.js
try {
    new Function(files['index.js']);
    console.log('index.js 语法校验通过');
} catch (e) {
    console.error('index.js 语法错误:', e.message);
    process.exit(1);
}

console.log('\n扩展文件已写入：', OUT_DIR);
console.log('安装方式：在 SillyTavern 扩展面板粘贴本仓库 GitHub 链接，或把整个仓库目录放入 data/<user>/extensions/ 后刷新页面。');
