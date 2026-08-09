#!/usr/bin/env node
/*
 * 构建 SillyTavern 原生扩展：读取 src/mvu2db.js，装配出可直接安装的扩展目录。
 * 用法：node build-extension.js [输出目录]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE_SRC = path.join(__dirname, 'src', 'mvu2db.js');
const PINYIN_SRC = path.join(__dirname, 'src', 'pinyin-data.js');
const OUT_DIR = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(ROOT, '扩展', 'mvu2db-converter');

const coreSource = fs.readFileSync(CORE_SRC, 'utf8');
const pinyinData = fs.readFileSync(PINYIN_SRC, 'utf8');
const core = require(CORE_SRC);

// 浏览器端没有 require：把拼音字典内联成 root.__MVU2DB_PINYIN__
const pinyinInline = pinyinData
    .replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2DB_PINYIN__ = ')
    .replace(/;\s*$/, ';');

const files = core.assembleExtension({ coreSource, pinyinInline });

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of Object.entries(files)) {
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

console.log('\n扩展目录：', OUT_DIR);
console.log('安装方式：把整个 mvu2db-converter 目录放入 SillyTavern 的 data/<user>/extensions/ 后刷新页面。');
