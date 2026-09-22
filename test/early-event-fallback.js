'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, fs, path } = require('./helpers');

const source = fs.readFileSync(path.join(__dirname, '../src/extension-runtime.js'), 'utf8');
const start = source.indexOf('    function installEarlyEventOnFallback(');
const end = source.indexOf('\n    async function emitMvuEvent', start);
assert.ok(start >= 0 && end > start);
const functionSource = source.slice(start, end).replace(/^    /gm, '');

class FakeEventTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, fn) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(fn);
    }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    dispatchEvent(event) {
        for (const fn of Array.from(this.listeners.get(event.type) || [])) fn.call(this, event);
        return true;
    }
}
function makeWindow() {
    const w = new FakeEventTarget();
    w.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    w.window = w;
    return w;
}
function install(w, hostWindow = w) {
    const context = vm.createContext({ window: w, hostWindow, Object, Map, Set, WeakMap, Array });
    vm.runInContext(`(${functionSource})()`, context);
}
function fire(w, name, detail) { w.dispatchEvent(new w.CustomEvent(name, { detail })); }

test('早期 eventOn 兜底：参数、eventOff、stop 和重复注册', () => {
    const w = makeWindow(); install(w);
    const calls = [], handler = (...args) => calls.push(args);
    const first = w.eventOn('x', handler), second = w.eventOn('x', handler);
    fire(w, 'x', { args: [1, 2, 3, 4] });
    assert.deepStrictEqual(calls, [[1, 2, 3, 4], [1, 2, 3, 4]]);
    w.eventOff('x', handler); fire(w, 'x', { args: [] });
    assert.strictEqual(calls.length, 2);
    first.stop(); second.stop(); second.stop();
});

test('早期 eventOn 兜底：两 handler、兼容载荷和纯 detail', () => {
    const w = makeWindow(); install(w);
    const a = [], b = [], stopA = w.eventOn('x', (...args) => a.push(args));
    w.eventOn('x', (...args) => b.push(args));
    fire(w, 'x', { after: 'after', before: 'before' });
    fire(w, 'x', { value: 7 });
    assert.deepStrictEqual(a, [['after', 'before'], [{ value: 7 }]]);
    assert.deepStrictEqual(b, [['after', 'before'], [{ value: 7 }]]);
    stopA.stop(); stopA.stop(); fire(w, 'x', { args: ['remaining'] });
    assert.deepStrictEqual(a, [['after', 'before'], [{ value: 7 }]]);
    assert.deepStrictEqual(b[2], ['remaining']);
});

test('早期 eventOn 兜底：窗口隔离并保留宿主 eventOn', () => {
    const w = makeWindow(), host = makeWindow(), hostOn = () => {};
    host.eventOn = hostOn; install(w, host);
    assert.notStrictEqual(w.eventOn, undefined);
    assert.strictEqual(host.eventOn, hostOn);
    let calls = 0; w.eventOn('x', () => calls++); fire(host, 'x', { args: [] }); fire(w, 'x', { args: [] });
    assert.strictEqual(calls, 1);
});
