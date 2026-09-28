#!/usr/bin/env node
'use strict';
const path = require('path');
const assert = require('assert');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(__dirname, '../../参考资料');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(refs, '测试工具/browsers');
const { chromium } = require(path.join(refs, '测试工具/node_modules/playwright'));
const createReader = require('../src/sp-version');
async function main() {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const url = 'https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@spv9.2.5.1/index.js';
        // 固定模块仅模拟SP公开API，验证真实import及浏览器ResourceTiming，不执行真实SP。
        await page.route(url, route => route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' },
            body: 'window.parent.AutoCardUpdaterAPI = { importTemplateFromData() {} };' }));
        await page.setContent('<iframe></iframe>');
        await page.frames()[1].evaluate(url => import(url), url);
        await page.addScriptTag({ content: 'window.createSpVersionReader = ' + createReader.toString() });
        const result = await page.evaluate(async () => {
            const windows = [window, document.querySelector('iframe').contentWindow];
            const read = window.createSpVersionReader({ readExtensions: async () => ({ extensionNames: [] }),
                readWindows: () => windows, readApi: () => window.AutoCardUpdaterAPI });
            return { version: await read(), imports: windows[1].performance.getEntriesByType('resource')
                .filter(entry => entry.name.includes('shujuku@')).map(entry => ({ name: entry.name, initiatorType: entry.initiatorType })) };
        });
        assert.strictEqual(result.version, '9.2.5.1');
        assert.deepStrictEqual(result.imports, [{ name: url, initiatorType: 'script' }]);
        console.log(JSON.stringify(result));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
