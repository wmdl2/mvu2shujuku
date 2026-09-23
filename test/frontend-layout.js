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
            if (width === 314) {
                const tableRows = page.locator('.mvu2shujuku-table-row');
                assert.strictEqual(await tableRows.count(), 3);
                assert.strictEqual(await page.locator('.mvu2shujuku-apply-all').count(), 0);
                const checks = tableRows.locator('.mvu2shujuku-table-select');
                await checks.nth(0).check();
                await checks.nth(2).check();
                await page.locator('.mvu2shujuku-table-search').fill('背包表');
                assert.strictEqual(await page.locator('.mvu2shujuku-table-row:visible').count(), 1);
                await page.locator('.mvu2shujuku-invert-visible').click();
                assert.deepStrictEqual(await checks.evaluateAll(nodes => nodes.map(node => node.checked)), [true, true, true]);
                assert.strictEqual(await page.locator('.mvu2shujuku-select-visible').isChecked(), true);
                assert.ok((await page.locator('.mvu2shujuku-selection-count').textContent()).includes('已选 3 / 3'));
                await page.locator('.mvu2shujuku-invert-visible').click();
                assert.deepStrictEqual(await checks.evaluateAll(nodes => nodes.map(node => node.checked)), [true, false, true]);
                await page.locator('.mvu2shujuku-table-search').fill('');
                assert.strictEqual(await page.locator('.mvu2shujuku-select-visible').evaluate(node => node.indeterminate), true);
                await page.locator('.mvu2shujuku-table-search').fill('__没有这个表__');
                assert.strictEqual(await page.locator('.mvu2shujuku-invert-visible').isDisabled(), true);
                assert.strictEqual(await page.locator('.mvu2shujuku-select-visible').isDisabled(), true);
                assert.strictEqual(await page.locator('.mvu2shujuku-apply-selected').isDisabled(), false);
                await page.locator('.mvu2shujuku-bulk-param').selectOption('contextDepth');
                await page.locator('.mvu2shujuku-bulk-value').fill('8');
                await page.locator('.mvu2shujuku-apply-selected').click();
                await page.locator('.mvu2shujuku-table-search').fill('');
                assert.deepStrictEqual(await tableRows.locator('.mvu2shujuku-param-select').evaluateAll(nodes => nodes.map(node => node.value)),
                    ['contextDepth', 'updateFrequency', 'contextDepth']);
                assert.deepStrictEqual(await tableRows.locator('.mvu2shujuku-param-value').evaluateAll(nodes => nodes.map(node => node.value)),
                    ['8', '-1', '8']);
                const reportState = await page.evaluate(viewSource => {
                    const view = (0, eval)('(' + viewSource + ')')({ document });
                    const sample = document.createElement('div');
                    const literal = '<img src=x onerror=bad>';
                    view.renderReport(sample, { meta: { tableCount: 1 }, reportText: literal,
                        report: { manualReview: [literal], warnings: [{ message: '警告' }], autoRewrites: ['已转换'], notes: [] } });
                    const empty = document.createElement('div');
                    view.renderReport(empty, { meta: { tableCount: 0 }, reportText: '', report: {} });
                    return {
                        title: sample.querySelector('.mvu2shujuku-attention summary').textContent,
                        hint: sample.querySelector('.mvu2shujuku-hint').textContent,
                        manual: sample.querySelector('.mvu2shujuku-attention li').textContent,
                        warning: sample.querySelectorAll('.mvu2shujuku-attention li')[1].textContent,
                        full: sample.querySelector('textarea').value,
                        injected: !!sample.querySelector('img'),
                        emptyHint: empty.querySelector('.mvu2shujuku-hint').textContent,
                    };
                }, resultView.toString());
                assert.deepStrictEqual(reportState, {
                    title: '兼容性待确认（1）',
                    hint: '以下为兼容提醒，不代表转换失败；部分行为可能与原卡不同，请按需核对。',
                    manual: '<img src=x onerror=bad>', warning: '警告', full: '<img src=x onerror=bad>', injected: false,
                    emptyHint: '未报告需额外核对的兼容事项；详细转换记录可在下方展开。',
                });
            }
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
