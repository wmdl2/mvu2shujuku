'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert, fs, path, bridgeSandbox } = require('./helpers');
const createLifecycle = require('../src/bridge-lifecycle');
const source = fs.readFileSync(path.join(__dirname, '../src/mvu2shujuku.js'), 'utf8');
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function extract(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
}
function setup() {
    const timers = new Map(), listeners = new Map();
    let id = 0;
    const bus = {
        on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        off(name, fn) { listeners.get(name)?.delete(fn); },
    };
    const converted = core.convert({ name: '接管测试', first_mes: '你好', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ 状态: { 生命: 100, 魔力: 50 } }) },
    ] } }, { installMvuShim: true });
    const r = bridgeSandbox(converted, { extra: {
        setTimeout(fn, delay) { const next = ++id; timers.set(next, { fn, delay }); return next; },
        clearTimeout(key) { timers.delete(key); },
        setInterval(fn, delay) { const next = ++id; timers.set(next, { fn, delay }); return next; },
        clearInterval(key) { timers.delete(key); },
        getContext: () => ({ chatId: 'A', chat: [], eventSource: bus, event_types: { MESSAGE_RECEIVED: 'message', CHAT_CHANGED: 'chat' } }),
    } });
    r.fakeApi.initGameSession = undefined;
    return { ...r, timers, listeners, converted };
}
function startExtension(win) {
    const started = [], received = [];
    const extensionMvu = { owner: 'extension' };
    Object.assign(win, {
        hostWindow: win, MVU2SHUJUKU_CORE: core,
        getContextSafe() { started.push('main'); return {}; }, getSettings: () => ({}),
        installEarlyEventOnFallback() {}, ensureSettingsPanel() {}, registerMagicWandRefreshButton() {},
        bindDebugHooks() {}, ensureTemplateDefine() {}, bindAutoInit() {}, autoInitDatabase() {}, dbg() {},
        syncRuntimeForCurrentCard() { win.Mvu = extensionMvu; },
        acceptBridgeRegistration(payload) { received.push(payload); return true; },
    });
    vm.runInContext(extract('    const runtimeRegistry = (() => {', '\n    function getContextSafe()') +
        extract('    function activateRuntimeRegistry()', '    // 重读通知去重') +
        extract('    function main() {', '\n    try {\n        main();') + '\nmain();', win);
    return { started, received, extensionMvu, registry: win.__mvu2shujukuRuntime };
}

test('桥接管：工厂停止后取消睡眠、定时器和监听，API 失败也能排空', async () => {
    const timers = new Map(); let id = 0, fire;
    const factory = vm.runInNewContext('(' + createLifecycle.toString() + ')');
    const life = factory({ setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); } });
    const sleep = life.sleep(1000);
    let calls = 0, removed = 0, reject;
    life.on({ on(name, fn) { fire = fn; }, off() { removed++; } }, 'event', () => calls++);
    const raw = { count: 7, work() { assert.strictEqual(this, raw); return new Promise((resolve, fail) => { reject = fail; }); } };
    const api = life.api(raw), result = api.work().catch(() => false);
    const ready = life.stop(); let drained = false; ready.then(() => { drained = true; });
    assert.strictEqual(life.stop(), ready);
    assert.strictEqual(await sleep, false);
    assert.strictEqual(timers.size, 0);
    fire(); assert.strictEqual(calls, 0); assert.strictEqual(removed, 1);
    assert.throws(() => api.work(), /旧桥已退出/);
    assert.strictEqual(drained, false);
    reject(new Error('模拟宿主失败'));
    assert.strictEqual(await result, false);
    await ready;
});

test('桥接管：扩展晚加载取消待提交快照，旧定时器不会抢回 Mvu', async () => {
    const r = setup(); await tick();
    const callbackKey = '__mvu2shujukuTableUpdateCallback_' + core.VERSION;
    const oldCallback = r.win[callbackKey];
    let removed = 0;
    r.fakeApi.unregisterTableUpdateCallback = callback => { assert.strictEqual(callback, oldCallback); removed++; };
    const old = r.win.Mvu, oldTimers = Array.from(r.timers.values());
    const pending = old.replaceMvuData({ stat_data: { 状态: { 生命: 80 } } });
    await Promise.resolve();
    const extension = startExtension(r.win);
    assert.strictEqual(await pending, false);
    await extension.registry.ready; await tick();
    assert.strictEqual(extension.started.length, 1);
    assert.strictEqual(extension.received.length, 1);
    assert.strictEqual(r.win.Mvu, extension.extensionMvu);
    assert.strictEqual(removed, 1);
    assert.strictEqual(r.win.getCellByHeader('状态表', 1, '生命'), 100, '保留的只读表格工具仍读取当前宿主');
    assert.strictEqual(r.win[callbackKey], undefined);
    oldCallback();
    for (const timer of oldTimers) timer.fn();
    assert.strictEqual(r.win.Mvu, extension.extensionMvu);
    assert.strictEqual(await old.replaceMvuData({ stat_data: { 状态: { 生命: 1 } } }), false);
    assert.ok(Array.from(r.listeners.values()).every(set => set.size === 0), '旧桥宿主监听应解绑');
    const sheet = Object.values(r.tables).find(t => t && t.name === '状态表');
    assert.strictEqual(sheet.content[1][sheet.content[0].indexOf('生命')], 100);
});

test('桥接管：API 缺失时重试不累积控制器，晚加载扩展取消重试', async () => {
    const r = setup(), timers = new Map(); let id = 0;
    const win = { console, setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; },
        clearTimeout(key) { timers.delete(key); } };
    win.window = win; win.top = win; win.parent = win;
    vm.createContext(win);
    vm.runInContext(r.converted.bridgeScript, win);
    assert.strictEqual(win.__mvu2shujukuLegacyBridges.length, 1);
    const first = Array.from(timers.values())[0]; timers.clear(); first.fn();
    assert.strictEqual(win.__mvu2shujukuLegacyBridges.length, 1);
    const retry = Array.from(timers.values())[0];
    const extension = startExtension(win);
    assert.strictEqual(timers.size, 0);
    await extension.registry.ready; await tick();
    retry.fn();
    assert.strictEqual(extension.started.length, 1);
    assert.strictEqual(win.Mvu, extension.extensionMvu);
    assert.strictEqual(win.__mvu2shujukuLegacyBridges.length, 0);
});

test('桥接管：扩展登记抛错也不启动第二套兼容运行时', () => {
    const r = setup();
    const win = { console, __mvu2shujukuRuntime: { owner: 'extension', registerCard() { throw new Error('登记失败'); } } };
    win.window = win; win.top = win;
    vm.createContext(win);
    vm.runInContext(r.converted.bridgeScript, win);
    assert.strictEqual(win.__mvu2shujukuLegacyBridges, undefined);
    assert.strictEqual(win.Mvu, undefined);
});

test('桥接管：等在途提交结束再启动扩展，旧批次后续单元格被拒绝', async () => {
    const r = setup(); await tick();
    let release, signal, writes = 0;
    const started = new Promise(resolve => { signal = resolve; });
    r.fakeApi.updateCell = async () => { writes++; signal(); await new Promise(resolve => { release = resolve; }); return true; };
    const old = r.win.Mvu;
    const pending = old.replaceMvuData({ stat_data: { 状态: { 生命: 80, 魔力: 30 } } });
    await Promise.resolve();
    Array.from(r.timers.values()).find(timer => timer.delay === 150).fn();
    await started;
    const extension = startExtension(r.win);
    assert.strictEqual(await pending, false);
    await tick();
    assert.strictEqual(extension.started.length, 0);
    // 扩展等待时另一个薄桥只能排队，不能启动自己的兼容运行时。
    vm.runInContext(r.converted.bridgeScript, r.win);
    assert.strictEqual(r.win.__mvu2shujukuLegacyBridges.length, 0);
    release();
    await extension.registry.ready; await tick();
    assert.strictEqual(writes, 1, '旧批次不得再发第二次单元格调用');
    assert.strictEqual(extension.started.length, 1);
    assert.strictEqual(r.win.__mvu2shujukuSuppressTableMvuEnded, 0, '旧批次 finally 必须先结束');
    assert.strictEqual(r.win.Mvu, extension.extensionMvu);
});
