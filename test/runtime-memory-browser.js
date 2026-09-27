#!/usr/bin/env node
'use strict';
// 小型浏览器组件验证：真实 iframe 与强制 GC，无需 SillyTavern 服务器。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(root, '../参考资料');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(refs, '测试工具/browsers');
const { chromium } = require(path.join(refs, '测试工具/node_modules/playwright'));
const createGlobals = require('../src/runtime-globals');
async function main() {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<!doctype html><body></body>');
        await page.addScriptTag({ content: 'window.createRuntimeGlobals = ' + createGlobals.toString() + ';' });
        const counts = await page.evaluate(() => {
            const shared = { list: [] };
            const globals = window.createRuntimeGlobals({ readSharedState: () => shared,
                isOursShimFn: fn => !!fn?.__mvu2shujuku, readFake: () => null });
            window.detachedWindowRefs = [];
            window.memoryTestShared = shared;
            globals.note(window);
            let restored = 0, failedRestore = 0, maximumRecords = 0;
            for (let i = 0; i < 100; i++) {
                const frame = document.createElement('iframe'); document.body.appendChild(frame);
                const w = frame.contentWindow;
                const original = w.Function('return 42');
                w.getVariables = original;
                globals.note(w);
                const replacement = () => 0; replacement.__mvu2shujuku = true;
                w.getVariables = replacement;
                // 连还原失败而保存在 WeakMap 的窗口也必须可以回收。
                if (i % 10 === 0) {
                    Object.defineProperty(w, 'getVariables', { get() { throw new Error('不可访问'); } });
                    failedRestore++;
                }
                maximumRecords = Math.max(maximumRecords, shared.list.length);
                window.detachedWindowRefs.push(new WeakRef(w));
                frame.remove(); globals.retainWindows([window]);
                if (i % 10 !== 0 && w.getVariables === original) restored++;
            }
            return { maximumRecords, remainingRecords: shared.list.length, restored, failedRestore };
        });
        assert.deepStrictEqual(counts, { maximumRecords: 2, remainingRecords: 1, restored: 90, failedRestore: 10 });
        const cdp = await page.context().newCDPSession(page);
        // 跨 JS 任务执行回收，避免 WeakRef 的“当前任务保持存活”语义干扰。
        await cdp.send('HeapProfiler.collectGarbage');
        await cdp.send('HeapProfiler.collectGarbage');
        const remainingDetachedWindows = await page.evaluate(() => window.detachedWindowRefs.filter(ref => ref.deref()).length);
        assert.strictEqual(remainingDetachedWindows, 0);
        assert.deepStrictEqual(errors, []);
        const report = { ...counts, remainingDetachedWindows, browserErrors: errors.length,
            scope: 'actual runtime-globals factory and 100 real iframes; forced GC, not a long-running ST heap benchmark' };
        const output = process.env.MVU_MEMORY_TEST_RESULT;
        if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
        console.log(JSON.stringify(report));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
