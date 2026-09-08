#!/usr/bin/env node
'use strict';
// node test/benchmark-refresh.js [原卡.json或.png]；默认使用可公开复现的合成卡。
const fs = require('fs');
const { performance } = require('perf_hooks');
const core = require('../src/mvu2shujuku');
const groups = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['分组' + i, {
    名称: '角色' + i, 生命: 100, 金币: 50, 状态: '正常', 说明: '用于测量参数刷新，不读取外部资源',
}]));
const input = process.argv[2] ? new Uint8Array(fs.readFileSync(process.argv[2])) : {
    name: '刷新性能合成卡', first_mes: '你好', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(groups) },
    ] },
};
let current = core.convert(input);
const samples = { full: [], refresh: [], unchanged: [] };
for (let i = 0; i < 11; i++) {
    const sheet = Object.values(current.template).find(value => value && value.content);
    sheet.updateConfig.updateFrequency = i + 1;
    const template = JSON.parse(JSON.stringify(current.template));
    let start = performance.now();
    core.convert(input, { template });
    const full = performance.now() - start;
    start = performance.now();
    current = core.refreshConversion(current);
    const refresh = performance.now() - start;
    start = performance.now();
    core.refreshConversion(current);
    const unchanged = performance.now() - start;
    if (i >= 2) { samples.full.push(full); samples.refresh.push(refresh); samples.unchanged.push(unchanged); }
}
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name + 'Ms', Number(median(values).toFixed(2))]));
console.log(JSON.stringify({ version: core.VERSION, tables: current.meta.tableCount, samples: 9, ...result }, null, 2));
