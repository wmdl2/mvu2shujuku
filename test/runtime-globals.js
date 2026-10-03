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

test('runtime globals：旧版本事件兜底没有清理句柄也能撤销，不阻断还原', () => {
    const eventOn = () => {}, eventOff = () => {};
    eventOn.__mvu2shujukuFallback = eventOff.__mvu2shujukuFallback = true;
    const w = { eventOn, eventOff }, record = { w };
    const { shared, globals } = setup(createRuntimeGlobals, { list: [record] });
    globals.restoreAll();
    assert.strictEqual(w.eventOn, undefined);
    assert.strictEqual(w.eventOff, undefined);
    assert.strictEqual(shared.originalsByWindow.has(w), false);
});

test('runtime globals：同一 WindowProxy 导航按文档重新记录，离线还原不污染新文档', () => {
    const { globals, shared } = setup(vm.runInNewContext('(' + createRuntimeGlobals.toString() + ')'));
    const first = () => 1, second = () => 2;
    const w = { document: {}, getVariables: first };
    globals.note(w); w.getVariables = shim();
    w.document = {}; w.getVariables = second;
    const next = globals.note(w);
    assert.strictEqual(next.get, second);
    assert.strictEqual(shared.list.length, 1);
    w.getVariables = shim(); globals.restoreAll();
    assert.strictEqual(w.getVariables, second);
    globals.note(w); w.getVariables = shim();
    w.document = {}; w.getVariables = first;
    globals.restoreAll();
    assert.strictEqual(w.getVariables, first);
});

test('runtime globals：安全发布 Mvu，保留助手只读 getter 并恢复被替换的属性描述符', () => {
    const { globals } = setup(vm.runInNewContext('(' + createRuntimeGlobals.toString() + ')'));
    const fake = { __mvu2shujukuFake: true }, real = { owner: 'native' };
    const w = { document: {} }, getter = () => fake;
    Object.defineProperty(w, 'Mvu', { configurable: true, get: getter });
    assert.strictEqual(globals.publishMvu(w, fake), true);
    globals.restoreAll();
    assert.strictEqual(Object.getOwnPropertyDescriptor(w, 'Mvu').get, getter);
    const original = { configurable: true, enumerable: false, get: () => real };
    Object.defineProperty(w, 'Mvu', original);
    assert.strictEqual(globals.publishMvu(w, fake), true);
    assert.strictEqual(w.Mvu, fake);
    globals.restoreAll();
    assert.strictEqual(Object.getOwnPropertyDescriptor(w, 'Mvu').get, original.get);
    assert.strictEqual(w.Mvu, real);
    globals.publishMvu(w, fake);
    const later = () => real;
    Object.defineProperty(w, 'Mvu', { configurable: true, get: later });
    globals.restoreAll();
    assert.strictEqual(Object.getOwnPropertyDescriptor(w, 'Mvu').get, later);
    const fixed = {};
    Object.defineProperty(fixed, 'Mvu', { get: () => real });
    assert.strictEqual(globals.publishMvu(fixed, fake), false);
    globals.restoreAll();
    assert.strictEqual(fixed.Mvu, real);
});

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
