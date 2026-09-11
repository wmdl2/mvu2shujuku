#!/usr/bin/env node
'use strict';
// CPU/API 次数基准；内存宿主不计网络、SQLite、酒馆保存耗时。
const { performance } = require('perf_hooks');
const createWriter = require('../src/table-writer');
const codec = require('../src/table-codec')();
const { applyingApi } = require('./helpers');
async function measure(count, fields) {
    const header = ['row_id', '名称', ...Array.from({ length: fields }, (_, i) => '值' + i)];
    const content = [header], prev = { 记录: {} }, next = { 记录: {} };
    for (let i = 0; i < count; i++) {
        const key = '记录' + i;
        content.push([String(i + 1), key, ...Array(fields).fill('0')]);
        prev.记录[key] = {}; next.记录[key] = {};
        for (let j = 0; j < fields; j++) { prev.记录[key]['值' + j] = 0; next.记录[key]['值' + j] = 1; }
    }
    const tables = { sheet_records: { name: '记录表', content } };
    const layout = [{ kind: 'rows', group: '记录', table: '记录表', keyCol: '名称', writePaths: [['记录']],
        cols: header.slice(1).map(h => [h, h === '名称' ? 'text' : 'number']) }];
    const api = applyingApi(tables), calls = { updateCell: 0, updateRow: 0 };
    api.updateCell = async (table, row, col, value) => { calls.updateCell++; content[row][header.indexOf(col)] = value; return true; };
    api.updateRow = async (table, row, values) => { calls.updateRow++; for (const [col, value] of Object.entries(values)) content[row][header.indexOf(col)] = value; return true; };
    const writer = createWriter({ parseJson: codec.parseObject }), start = performance.now();
    await writer.writeStatDiffToDb(api, layout, prev, next);
    if (writer.lastStatWriteFailed) throw new Error('基准写入失败');
    return { rows: count, fields, ms: Number((performance.now() - start).toFixed(2)), ...calls };
}
(async () => {
    await measure(100, 1);
    const results = [];
    for (const count of [100, 1000, 10000]) for (const fields of [1, 3]) results.push(await measure(count, fields));
    console.log(JSON.stringify({ node: process.version, results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
