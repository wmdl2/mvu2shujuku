'use strict';
const { test } = require('./runner');
const { assert } = require('./helpers');
const createRuntimeWindows = require('../src/runtime-windows');

class FakeFrame {
    constructor(child) { this.localName = 'iframe'; this.contentWindow = child; this.parentNode = null; this.listeners = new Map(); }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    fire(name) { for (const fn of this.listeners.get(name) || []) fn(); }
}
class FakeDocument {
    constructor(frames = []) { this.frames = frames; this.queries = 0; }
    querySelectorAll(selector) { assert.strictEqual(selector, 'iframe'); this.queries++; return this.frames.slice(); }
}
class FakeContainer {
    constructor(frames) { this.localName = 'div'; this.frames = frames; }
    querySelectorAll(selector) { assert.strictEqual(selector, 'iframe'); return this.frames.slice(); }
}
class FakeWindow {
    constructor(doc) { this.document = doc; this.closed = false; }
}
function observerClass() {
    const all = [];
    class FakeObserver {
        constructor(callback) { this.callback = callback; this.records = []; this.disconnected = false; all.push(this); }
        observe(doc) { this.doc = doc; }
        takeRecords() { const records = this.records; this.records = []; return records; }
        disconnect() { this.disconnected = true; }
    }
    FakeObserver.all = all;
    return FakeObserver;
}
function mutation(doc, addedNodes = [], removedNodes = []) {
    for (const observer of observerClass.all || []) if (observer.doc === doc) observer.records.push({ addedNodes, removedNodes });
}

test('runtime windows：稳定缓存、同栈 takeRecords、嵌套变更与导航', () => {
    const Observer = observerClass(); observerClass.all = Observer.all;
    const childDoc = new FakeDocument(), child = new FakeWindow(childDoc);
    const frame = new FakeFrame(child); const rootDoc = new FakeDocument([frame]); const root = new FakeWindow(rootDoc);
    let changes = 0;
    const rw = createRuntimeWindows({ readRoots: () => [root, root], readSessionKey: () => 'a', MutationObserver: Observer, onChange: () => changes++ });
    assert.strictEqual(rw.getWindows().length, 2);
    for (let i = 0; i < 50; i++) rw.getWindows();
    assert.strictEqual(rw.stats.scans, 1); assert.strictEqual(rw.stats.queries, 2); assert.strictEqual(rw.stats.hits, 50);
    const nested = new FakeFrame(new FakeWindow(new FakeDocument())); nested.parentNode = frame;
    childDoc.frames.push(nested); mutation(childDoc, [nested]);
    assert.strictEqual(rw.getWindows().length, 3); assert.strictEqual(rw.stats.scans, 2); assert.strictEqual(changes, 1);
    const newDoc = new FakeDocument(); child.document = newDoc;
    assert.strictEqual(rw.getWindows().length, 2); // navigation drops the old child descendants
    frame.fire('load'); assert.strictEqual(rw.getWindows().length, 2);
    const removed = new FakeFrame(new FakeWindow(new FakeDocument()));
    const holder = new FakeContainer([removed]); rootDoc.frames.push(removed); // the holder models a removed ancestor container
    mutation(rootDoc, [], [holder]); rootDoc.frames.pop();
    assert.strictEqual(rw.getWindows().length, 2);
    assert.ok(rw.stats.queries >= 3, 'mutation descendant search should be counted');
});

test('runtime windows：会话切换、显式失效、dispose 清理与无 observer 回退', () => {
    const Observer = observerClass(); observerClass.all = Observer.all;
    const doc = new FakeDocument(), root = new FakeWindow(doc); let key = 'one';
    const rw = createRuntimeWindows({ readRoots: () => [root], readSessionKey: () => key, MutationObserver: Observer });
    rw.getWindows(); rw.getWindows(); assert.strictEqual(rw.stats.scans, 1);
    const firstObserver = Observer.all[Observer.all.length - 1];
    key = 'two'; rw.getWindows(); assert.strictEqual(rw.stats.scans, 2);
    assert.ok(firstObserver.disconnected, 'session change disconnects old observer');
    rw.invalidate(); rw.getWindows(); assert.strictEqual(rw.stats.scans, 3);
    assert.ok(Observer.all[Observer.all.length - 1].disconnected === false);
    const activeObserver = Observer.all[Observer.all.length - 1];
    rw.dispose(); rw.dispose(); assert.deepStrictEqual(rw.getWindows(), []);
    assert.ok(activeObserver.disconnected, 'dispose disconnects observer');
});

test('runtime windows：observer 构造失败时不可永久命中缓存', () => {
    class BrokenObserver { constructor() { throw new Error('broken'); } }
    const rw = createRuntimeWindows({ readRoots: () => [new FakeWindow(new FakeDocument())], MutationObserver: BrokenObserver });
    rw.getWindows(); rw.getWindows();
    assert.strictEqual(rw.stats.scans, 2);
});
