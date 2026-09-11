'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const converted = () => core.convert(require('./synthetic-card')());
function setup(registry) {
    const timers = new Map(), events = new Map(), warnings = [];
    let serial = 0;
    const host = { __mvu2shujukuRuntime: registry, document: {
        createElement() { return { style: {}, setAttribute() {}, remove() { warnings.splice(warnings.indexOf(this), 1); } }; },
        body: { appendChild(element) { warnings.push(element); } },
    } };
    const frame = { top: host, setTimeout(fn) { timers.set(++serial, fn); return serial; }, clearTimeout(id) { timers.delete(id); },
        addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
    frame.window = frame;
    vm.createContext(frame);
    const result = converted();
    vm.runInContext(result.bridgeScript, frame);
    return { frame, host, timers, events, warnings, result, tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}
test('轻量桥：转换产物只登记元数据，无扩展时等待而不接管全局', () => {
    const r = setup();
    assert.strictEqual(r.frame.__mvu2shujukuBridgeStatus.state, 'waiting');
    assert.strictEqual(r.frame.Mvu, undefined);
    assert.strictEqual(r.host.Mvu, undefined);
    assert.strictEqual(r.host.__mvu2shujukuLegacyBridges, undefined);
    assert.ok(Buffer.byteLength(r.result.bridgeScript) < 20000, '公开合成卡注册脚本应小于 20 KB');
    new Function(r.result.bridgeScript);
    assert.strictEqual(r.timers.size, 1);
});
test('轻量桥：扩展晚加载自动登记且清理可见等待提示', () => {
    const r = setup(), accepted = [];
    for (let i = 0; i < 10; i++) r.tick();
    assert.strictEqual(r.warnings.length, 1);
    assert.match(r.warnings[0].textContent, /安装或启用扩展/);
    r.host.__mvu2shujukuRuntime = { owner: 'extension', registerCard(payload) { accepted.push(payload); return true; } };
    r.tick();
    assert.strictEqual(r.frame.__mvu2shujukuBridgeStatus.state, 'registered');
    assert.strictEqual(r.timers.size, 0);
    assert.strictEqual(r.warnings.length, 0);
    assert.strictEqual(accepted.length, 1);
    assert.strictEqual(accepted[0].sourceWindow, vm.runInContext('window', r.frame));
    assert.deepStrictEqual(JSON.parse(Buffer.from(accepted[0].templateBase64, 'base64').toString()), r.result.template);
});
test('轻量桥：扩展拒绝旧卡登记时退出，抛错时显示失败并重试', () => {
    const rejected = setup({ owner: 'extension', registerCard() { return false; } });
    assert.strictEqual(rejected.frame.__mvu2shujukuBridgeStatus.state, 'rejected');
    assert.strictEqual(rejected.timers.size, 0);
    const failed = setup({ owner: 'extension', registerCard() { throw new Error('加载失败'); } });
    assert.strictEqual(failed.frame.__mvu2shujukuBridgeStatus.state, 'failed');
    assert.match(failed.warnings[0].textContent, /登记失败/);
    failed.host.__mvu2shujukuRuntime.registerCard = () => true;
    failed.tick();
    assert.strictEqual(failed.frame.__mvu2shujukuBridgeStatus.state, 'registered');
    assert.strictEqual(failed.warnings.length, 0);
});
test('轻量桥：iframe 卸载及重复执行清理旧重试', () => {
    const r = setup();
    vm.runInContext(r.result.bridgeScript, r.frame);
    assert.strictEqual(r.timers.size, 1);
    const timer = [...r.timers.values()][0];
    r.events.get('pagehide')();
    assert.strictEqual(r.timers.size, 0);
    r.host.__mvu2shujukuRuntime = { owner: 'extension', registerCard() { throw new Error('卸载后不能登记'); } };
    timer();
    assert.strictEqual(r.warnings.length, 0);
});
