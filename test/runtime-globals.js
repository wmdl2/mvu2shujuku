'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert } = require('./helpers');
const createRuntimeGlobals = require('../src/runtime-globals');

function shim() { const fn = () => {}; fn.__mvu2shujuku = true; return fn; }
function setup(factory = createRuntimeGlobals, existing = { list: [] }) {
    const shared = existing;
    const globals = factory({ readSharedState: () => shared,
        isOursShimFn: fn => !!(fn && typeof fn === 'function' && fn.__mvu2shujuku),
        readFake: () => null });
    return { shared, globals };
}

test('runtime globals：内联工厂隔离，窗口反复重建时共享 list 只保留当前窗口', () => {
    const factory = vm.runInNewContext('(' + createRuntimeGlobals.toString() + ')');
    const { shared, globals } = setup(factory);
    const root = { getVariables: () => 'root' };
    globals.note(root);
    let previous = null;
    for (let i = 0; i < 40; i++) {
        const original = () => i;
        const frame = { getVariables: original };
        globals.note(frame);
        frame.getVariables = shim();
        globals.retainWindows([root, frame]);
        assert.strictEqual(shared.list.length, 2);
        if (previous) assert.strictEqual(previous.getVariables, previous.original);
        frame.original = original;
        previous = frame;
    }
    globals.restoreAll();
    assert.strictEqual(shared.list.length, 0);
    assert.strictEqual(previous.getVariables, previous.original);
});

test('runtime globals：还原后重新接管时采集新真实函数，不覆盖后来安装的真 MVU', () => {
    const { shared, globals } = setup();
    const first = () => 'first', second = () => 'second', latest = () => 'latest';
    const firstMvu = { owner: 'first' }, secondMvu = { owner: 'second' }, latestMvu = { owner: 'latest' };
    const w = { getVariables: first, Mvu: firstMvu };
    globals.note(w);
    w.getVariables = shim(); w.Mvu = { __mvu2shujukuFake: true };
    globals.restoreAll();
    assert.strictEqual(w.getVariables, first);
    assert.strictEqual(w.Mvu, firstMvu);
    w.getVariables = second; w.Mvu = secondMvu;
    globals.note(w);
    w.getVariables = shim(); w.Mvu = { __mvu2shujukuFake: true };
    globals.restoreAll();
    assert.strictEqual(w.getVariables, second);
    assert.strictEqual(w.Mvu, secondMvu);
    globals.note(w);
    w.getVariables = latest; w.Mvu = latestMvu;
    globals.restoreAll();
    assert.strictEqual(w.getVariables, latest, '只还原自己的 shim');
    assert.strictEqual(w.Mvu, latestMvu, '不覆盖后来安装的真 MVU');
    assert.strictEqual(shared.list.length, 0);
});

test('runtime globals：收纳旧桥 list 原始值，不把已有 shim 误记为真原始函数', () => {
    const original = () => 'legacy', ours = shim();
    const w = { getVariables: ours };
    const oldRecord = { w, get: original, hasGet: true };
    const { shared, globals } = setup(createRuntimeGlobals, { list: [oldRecord] });
    assert.strictEqual(globals.note(w), oldRecord);
    assert.strictEqual(shared.list.length, 1);
    globals.restoreAll();
    assert.strictEqual(w.getVariables, original);
    assert.strictEqual(shared.list.length, 0);
});

test('runtime globals：单窗访问异常不阻挡其他还原；失败记录可在重新出现后复用', () => {
    const { shared, globals } = setup();
    const badOriginal = () => 'bad', goodOriginal = () => 'good';
    const bad = { getVariables: badOriginal }, good = { getVariables: goodOriginal };
    globals.note(bad); globals.note(good);
    bad.getVariables = shim(); good.getVariables = shim();
    Object.defineProperty(bad, 'getVariables', { configurable: true, get() { throw new Error('跨源窗口失效'); } });
    globals.retainWindows([]);
    assert.strictEqual(shared.list.length, 0);
    assert.strictEqual(good.getVariables, goodOriginal);
    Object.defineProperty(bad, 'getVariables', { configurable: true, writable: true, value: shim() });
    globals.note(bad);
    globals.restoreAll();
    assert.strictEqual(bad.getVariables, badOriginal);
});


test('runtime globals：未经过 note 的旧桥离线记录，跨源失败后仍可还原', () => {
    const original = () => 'legacy original';
    const w = {};
    Object.defineProperty(w, 'getVariables', { configurable: true, get() { throw new Error('跨源'); } });
    const record = { w, get: original, hasGet: true };
    const { shared, globals } = setup(createRuntimeGlobals, { list: [record] });
    globals.retainWindows([]);
    assert.strictEqual(shared.list.length, 0);
    Object.defineProperty(w, 'getVariables', { configurable: true, writable: true, value: shim() });
    assert.strictEqual(globals.note(w), record);
    globals.restoreAll();
    assert.strictEqual(w.getVariables, original);
});
