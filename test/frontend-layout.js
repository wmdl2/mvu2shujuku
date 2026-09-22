#!/usr/bin/env node
'use strict';
// 独立组件截图与容器宽度检查；复用真实视图/样式，不代替宿主保存验收。
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(root, '../参考资料');
const work = process.env.MVU_UI_TEST_DIR || path.join(root, '.tools/frontend-layout');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(refs, '测试工具/browsers');
const { chromium } = require(path.join(refs, '测试工具/node_modules/playwright'));
const core = require('../src/mvu2shujuku');
const settingsView = require('../src/settings-view');
const resultView = require('../src/result-view');

async function main() {
    fs.mkdirSync(work, { recursive: true });
    const result = core.convert(require('./frontend-card')());
    const rows = Object.keys(result.template).filter(uid => uid.startsWith('sheet_')).map(uid => ({ uid, sheet: result.template[uid] }));
    const font = process.env.MVU_TEST_FONT;
    const fontCss = font ? '@font-face{font-family:TestChinese;src:url(data:font/ttf;base64,' + fs.readFileSync(font).toString('base64') + ')}' : '';
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const results = [];
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        for (const [viewport, width] of [[1280, 314], [390, 390], [1024, 760]]) {
            await page.setViewportSize({ width: viewport, height: 900 });
            await page.setContent('<style>' + fontCss + 'body{margin:0;background:#202020;color:#ddd;font:14px TestChinese,sans-serif}button,input,select,textarea{font:inherit}*{box-sizing:border-box}' + core.extensionStyle() + '</style><div id="mvu2shujuku-settings" style="width:' + width + 'px"></div>');
            await page.evaluate(({ viewSource, settingsSource, result, rows }) => {
                const panel = document.getElementById('mvu2shujuku-settings');
                panel.innerHTML = (0, eval)('(' + settingsSource + ')')({ installMvuShim: 'auto', asPng: 'auto' });
                const box = panel.querySelector('.mvu2shujuku-result');
                const view = (0, eval)('(' + viewSource + ')')({ document });
                view.renderReport(box, result);
                view.renderEditor(box, rows);
                panel.querySelector('#mvu2shujuku-file-area').style.display = '';
                panel.querySelector('#mvu2shujuku-char-area').style.display = 'none';
            }, { viewSource: resultView.toString(), settingsSource: settingsView.toString(),
                result: JSON.parse(JSON.stringify({ meta: result.meta, report: result.report, reportText: result.reportText })), rows });
            await page.evaluate(() => document.fonts.ready);
            const dimensions = await page.locator('.mvu2shujuku-param-editor').evaluate(node => {
                const grid = node.querySelector('.mvu2shujuku-param-grid');
                const numberStyles = [...node.querySelectorAll('input[type="number"]')].map(input => {
                    const style = getComputedStyle(input);
                    return JSON.stringify(['backgroundColor', 'color', 'borderTopColor', 'borderRadius', 'paddingTop', 'fontSize', 'height'].map(key => style[key]));
                });
                return { width: node.clientWidth, scrollWidth: node.scrollWidth, gridWidth: grid.clientWidth, gridScrollWidth: grid.scrollWidth,
                    numberStyleCount: new Set(numberStyles).size, explanationRemoved: !node.textContent.includes('世界书注入与自动更新有什么区别') };
            });
            const filename = 'frontend-' + width + '.png';
            await page.locator('.mvu2shujuku-result').screenshot({ path: path.join(work, filename) });
            results.push({ viewport, container: width, ...dimensions, filename });
        }
        fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ results, errors }, null, 2));
        console.log(JSON.stringify({ results, errors }));
        assert.deepStrictEqual(errors, []);
        for (const result of results) {
            assert.ok(result.scrollWidth <= result.width + 1 && result.gridScrollWidth <= result.gridWidth + 1, JSON.stringify(result));
            assert.strictEqual(result.numberStyleCount, 1, '批量与逐表数值框必须一致');
            assert.strictEqual(result.explanationRemoved, true);
        }
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
