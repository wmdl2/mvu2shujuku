'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, fs } = require('./helpers');

// 直接运行扩展当前 API 实现；只替换宿主总线，避免测试冻结的历史卡桥。
function publicApi(emitMvuEvent = async () => {}) {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const slice = (start, end) => {
        const a = source.indexOf(start), b = source.indexOf(end, a);
        assert.ok(a >= 0 && b > a);
        return source.slice(a, b);
    };
    const context = { window: {}, hostWindow: {}, windowMvuFake: {}, emitMvuEvent, dbg() {}, dbgWarn() {} };
    vm.createContext(context);
    vm.runInContext(slice('    function mvuVariablePathParts(', '    let windowMvuShimTimer') +
        slice('            windowMvuFake.getMvuVariable =', '            const waitForRuntimeBasics'), context);
    return context.windowMvuFake;
}

test('公共 MVU API：普通两元素数组与 VWD 按上游 getter 语义区分', () => {
    const api = publicApi();
    const data = { stat_data: { numbers: [10, 20], flags: [false, null], pair: [7, '说明'], objectPair: [{ x: 1 }, '说明'] } };
    assert.strictEqual(api.getMvuVariable(data, 'numbers'), data.stat_data.numbers);
    assert.strictEqual(api.getMvuVariable(data, 'flags'), data.stat_data.flags);
    assert.strictEqual(api.getMvuVariable(data, 'pair'), 7);
    assert.strictEqual(api.getMvuVariable(data, 'objectPair'), data.stat_data.objectPair[0]);
});

test('公共 MVU API：setter 保留普通值类型、Date 身份、普通数组和 VWD 描述符', async () => {
    const events = [];
    const api = publicApi(async (name, stat, path, oldValue, newValue) => events.push({ name, stat, path, oldValue, newValue }));
    const date = new Date('2025-01-02T03:04:05.000Z');
    const data = { stat_data: {
        number: 1, nullable: 'before', when: null, date: null,
        pair: [10, 20], vwd: [[1, 2], '说明'],
    } };
    assert.strictEqual(await api.setMvuVariable(data, 'number', '2'), true);
    assert.strictEqual(data.stat_data.number, '2');
    assert.strictEqual(await api.setMvuVariable(data, 'nullable', null), true);
    assert.strictEqual(data.stat_data.nullable, null);
    assert.strictEqual(await api.setMvuVariable(data, 'date', date), true);
    assert.strictEqual(data.stat_data.date, date);
    assert.strictEqual(await api.setMvuVariable(data, 'pair', [30, 40]), true);
    assert.deepStrictEqual(data.stat_data.pair, [30, 40]);
    assert.strictEqual(await api.setMvuVariable(data, 'vwd', 'new', { is_recursive: true }), true);
    assert.ok(Array.isArray(data.stat_data.vwd));
    assert.strictEqual(data.stat_data.vwd[0], 'new');
    assert.strictEqual(data.stat_data.vwd[1], '说明');
    assert.strictEqual(events.length, 1);
    assert.ok(Array.isArray(events[0].oldValue));
    assert.deepStrictEqual(Array.from(events[0].oldValue), [1, 2]);
    assert.strictEqual(events[0].newValue, data.stat_data.vwd[0]);
    assert.strictEqual(typeof events[0].newValue, 'string');
});

test('公共 MVU API：方括号、引号键、空键与字面点号键读写一致', async () => {
    const api = publicApi();
    const data = { stat_data: { rows: [{ value: 1 }], obj: { 'a.b': 2, 'a"b': 3, '': 4 }, 'a.b': 5, a: { b: 6 }, nil: null, unset: undefined } };
    for (const [path, before] of [['rows[0].value', 1], ['obj["a.b"]', 2], ['obj["a\\"b"]', 3], ['obj[""]', 4], ['a.b', 5]]) {
        assert.strictEqual(api.getMvuVariable(data, path), before, path);
        assert.strictEqual(await api.setMvuVariable(data, path, before + 10), true, path);
        assert.strictEqual(api.getMvuVariable(data, path), before + 10, path);
    }
    assert.strictEqual(data.stat_data.a.b, 6, '已有字面键优先，不误写嵌套路径');
    assert.strictEqual(api.getMvuVariable(data, 'nil.child', { default_value: 'missing' }), 'missing');
    assert.strictEqual(await api.setMvuVariable(data, 'rows[1].value', 4), false);
    assert.strictEqual(data.stat_data.rows.length, 1);
    assert.strictEqual(await api.setMvuVariable(data, 'unset', 9), true, '已存在但为 undefined 的字段仍可写');
    assert.strictEqual(data.stat_data.unset, 9);
    const polluted = {stat_data: JSON.parse('{"__proto__":{"x":1}}')};
    assert.strictEqual(await api.setMvuVariable(polluted, '__proto__.x', 2), false);
});

test('公共 MVU API：递归 setter 等待异步监听修正后再返回', async () => {
    let release, entered = false, returned = false;
    const gate = new Promise(resolve => { release = resolve; });
    const api = publicApi(async (name, stat, path, oldValue, newValue) => {
        assert.strictEqual(name, 'mag_variable_updated');
        assert.strictEqual(path, 'x');
        assert.strictEqual(oldValue, 1);
        assert.strictEqual(newValue, 2);
        entered = true;
        await gate;
        stat.y = 7;
    });
    const data = {stat_data: {x: 1, y: 0}};
    const pending = api.setMvuVariable(data, 'x', 2, {is_recursive: true}).then(ok => { returned = true; return ok; });
    await Promise.resolve();
    assert.strictEqual(entered, true);
    assert.strictEqual(returned, false);
    assert.strictEqual(data.stat_data.y, 0);
    release();
    assert.strictEqual(await pending, true);
    assert.strictEqual(data.stat_data.y, 7);
});

test('公共 MVU API：展示记录沿数组和引号键保存，不改变非递归事件策略', async () => {
    let calls = 0;
    const api = publicApi(async () => { calls++; });
    const display = {}, delta = {};
    const data = {stat_data: {rows: [{'a.b': 1}], $internal: {display_data: display, delta_data: delta}}};
    assert.strictEqual(await api.setMvuVariable(data, 'rows[0]["a.b"]', 2), true);
    assert.strictEqual(calls, 0);
    assert.ok(Array.isArray(display.rows));
    assert.strictEqual(display.rows[0]['a.b'], '1->2');
    assert.strictEqual(delta.rows[0]['a.b'], '1->2');
});

test('公共 MVU API：没有 iframe 发射器时使用宿主上下文总线，并等待异步完成', async () => {
    const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const a = source.indexOf('    function installEarlyEventOnFallback('), b = source.indexOf('    let tableUpdateHookApi', a);
    assert.ok(a >= 0 && b > a);
    let release, calls = 0, returned = false;
    const gate = new Promise(resolve => {release = resolve;});
    const bus = {emit: async (name, data) => {calls++; assert.strictEqual(name, 'mag_variable_updated'); await gate; data.updated = true;}};
    const window = {document: {querySelectorAll: () => []}, dispatchEvent() {}, addEventListener() {}, CustomEvent: function () {}};
    window.parent = window; window.top = window;
    const emit = vm.runInNewContext(source.slice(a,b) + '\nemitMvuEvent;', {
        window, hostWindow: window, activeLayout: null, getContextSafe: () => ({eventSource: bus}), getRuntimeWindows: () => [window],
    });
    const data = {};
    const pending = emit('mag_variable_updated', data).then(() => {returned = true;});
    await Promise.resolve();
    assert.strictEqual(calls, 1, '宿主上下文总线不能被忽略');
    assert.strictEqual(returned, false);
    release(); await pending;
    assert.strictEqual(data.updated, true);
    window.eventEmit = bus.emit;
    await emit('mag_variable_updated', {});
    assert.strictEqual(calls, 2, '已有 TH 发射器时不重复向相同总线发送');
});
