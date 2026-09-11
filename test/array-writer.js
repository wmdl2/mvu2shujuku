'use strict';
const { test } = require('./runner');
const { assert, applyingApi } = require('./helpers');
const createWriter = require('../src/table-writer');
const codec = require('../src/table-codec')();
const clone = value => JSON.parse(JSON.stringify(value));
const layout = [{ kind: 'array', group: '列表', table: '列表表', valueCol: '内容', cols: [['内容', 'jsonScalar']] }];
function setup(values) {
    const tables = { sheet_a: { name: '列表表', content: [['row_id', '内容', '备注'], ...values.map((v, i) => [String(i + 1), JSON.stringify(v), '保留' + i])] },
        sheet_other: { name: '无关表', content: [['row_id', '值'], ['1', '保留']] } };
    const api = applyingApi(tables), calls = [];
    for (const method of ['updateCell', 'insertRow', 'deleteRow', 'importTableAsJson']) {
        const original = api[method];
        api[method] = async (...args) => { calls.push(method); return original(...args); };
    }
    const writer = createWriter({ parseJson: codec.parseObject });
    return { tables, api, calls, writer, write: next => writer.writeStatDiffToDb(api, layout, { 列表: values }, { 列表: next }) };
}

test('数组差量：未变化零调用，单值更新无需 import 且保留附加列', async () => {
    const f = setup([null, false, 0, '重复', '重复', { a: [1] }]);
    delete f.api.importTableAsJson;
    await f.write([null, false, 0, '重复', '重复', { a: [1] }]);
    assert.deepStrictEqual(f.calls, []);
    await f.write([null, false, 0, '改变', '重复', { a: [1] }]);
    assert.deepStrictEqual(f.calls, ['updateCell']);
    assert.strictEqual(f.tables.sheet_a.content[4][2], '保留3');
    assert.strictEqual(f.writer.lastStatWriteFailed, false);
});

for (const [label, next, method] of [['追加', [1, 2, 3], 'insertRow'], ['缩短', [1], 'deleteRow']]) {
    test('数组差量：尾部单步' + label, async () => {
        const f = setup([1, 2]);
        delete f.api.importTableAsJson;
        await f.write(next);
        assert.deepStrictEqual(f.calls, [method]);
        assert.deepStrictEqual(f.tables.sheet_a.content.slice(1).map(r => JSON.parse(r[1])), next);
        assert.strictEqual(f.writer.lastStatWriteFailed, false);
    });
}

test('数组差量：多步一次原子导入，重复请求幂等且保留其他表', async () => {
    const f = setup([1, 2, 3]), other = clone(f.tables.sheet_other);
    await f.write([null, false, 0, { a: 1 }, '重复', '重复']);
    assert.deepStrictEqual(f.calls, ['importTableAsJson']);
    assert.deepStrictEqual(f.tables.sheet_other, other);
    assert.deepStrictEqual(f.tables.sheet_a.content.slice(1).map(r => JSON.parse(r[1])), [null, false, 0, { a: 1 }, '重复', '重复']);
    await f.write([null, false, 0, { a: 1 }, '重复', '重复']);
    assert.strictEqual(f.calls.length, 1);
});

for (const mode of ['missing', 'false', 'throw']) test('数组差量：原子能力缺失或失败无部分写入且可以重试 ' + mode, async () => {
    const f = setup([1, 2, 3]), before = clone(f.tables), importData = f.api.importTableAsJson;
    if (mode === 'missing') delete f.api.importTableAsJson;
    else f.api.importTableAsJson = async () => { if (mode === 'throw') throw new Error('保存失败'); return false; };
    await f.write([4, 5]);
    assert.strictEqual(f.writer.lastStatWriteFailed, true);
    assert.deepStrictEqual(f.tables, before);
    assert.deepStrictEqual(f.calls, []);
    f.api.importTableAsJson = importData;
    await f.write([4, 5]);
    assert.strictEqual(f.writer.lastStatWriteFailed, false);
    assert.deepStrictEqual(f.calls, ['importTableAsJson']);
    assert.deepStrictEqual(f.tables.sheet_a.content.slice(1).map(r => JSON.parse(r[1])), [4, 5]);
});

test('数组差量：持久化成功但回放失败时不反向覆盖，重试不重复提交', async () => {
    const f = setup([1, 2, 3]), commit = f.api.importTableAsJson;
    f.api.importTableAsJson = async data => { await commit(data); return { success: false, persisted: true }; };
    await f.write([4, 5]);
    assert.strictEqual(f.writer.lastStatWriteFailed, true);
    assert.deepStrictEqual(f.calls, ['importTableAsJson']);
    await f.write([4, 5]);
    assert.strictEqual(f.writer.lastStatWriteFailed, false);
    assert.deepStrictEqual(f.calls, ['importTableAsJson']);
});

test('数组差量：规划后表格变化拒绝使用过期行号', async () => {
    const f = setup([1, 2]);
    let reads = 0;
    f.api.exportTableAsJson = () => {
        if (++reads === 2) f.tables.sheet_a.content.unshift(['更换表头']);
        return f.tables;
    };
    await f.write([3, 4]);
    assert.strictEqual(f.writer.lastStatWriteFailed, true);
    assert.deepStrictEqual(f.calls, []);
});

test('数组差量：嵌套多父项共用行号分配并保留其他父项和列', async () => {
    const f = setup([]);
    f.tables.sheet_a.content = [['row_id', '父项', '内容', '备注'], ['5', '甲', 'a', '甲备注'], ['8', '乙', 'b', '乙备注'], ['9', '丙', 'c', '丙备注']];
    const nested = [{ kind: 'nestedArray', group: '角色', path: ['角色', '*', '标签'], table: '列表表', parentKeyCol: '父项', valueCol: '内容' }];
    await f.writer.writeStatDiffToDb(f.api, nested, { 角色: { 甲: { 标签: ['a'] }, 乙: { 标签: ['b'] } } },
        { 角色: { 甲: { 标签: ['A', '追加甲'] }, 乙: { 标签: ['B', '追加乙'] } } });
    assert.strictEqual(f.writer.lastStatWriteFailed, false);
    assert.deepStrictEqual(f.calls, ['importTableAsJson']);
    const rows = f.tables.sheet_a.content.slice(1);
    assert.strictEqual(new Set(rows.map(r => r[0])).size, rows.length);
    assert.deepStrictEqual(rows.find(r => r[1] === '丙'), ['9', '丙', 'c', '丙备注']);
    assert.deepStrictEqual(rows.filter(r => r[1] === '甲').map(r => r[2]), ['A', '追加甲']);
    assert.strictEqual(rows[0][3], '甲备注');
});
