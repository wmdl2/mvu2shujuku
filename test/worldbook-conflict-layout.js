#!/usr/bin/env node
'use strict';
// 真正的冲突组件 + 宿主 CSS；只验布局和交互，不启动完整酒馆。
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(root, '../参考资料');
const work = process.env.MVU_UI_TEST_DIR || path.join(root, '.tools/worldbook-conflict-layout');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(refs, '测试工具/browsers');
const { chromium } = require(path.join(refs, '测试工具/node_modules/playwright'));
const core = require('../src/mvu2shujuku');
const factory = require('../src/worldbook-save');
async function main() {
    fs.mkdirSync(work, { recursive: true });
    const hostCss = fs.readFileSync(path.join(refs, 'SillyTavern/public/style.css'), 'utf8');
    const font = process.env.MVU_TEST_FONT || (fs.existsSync('/mnt/c/Windows/Fonts/msyh.ttc') ? '/mnt/c/Windows/Fonts/msyh.ttc' : '');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const results = [], errors = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.route('http://mvu-ui.test/**', route => route.request().url().endsWith('/font') && font
            ? route.fulfill({ path: font, contentType: 'font/ttf' }) : route.fulfill({ status: 204, body: '' }));
        const cases = [
            { width: 1280, size: 16, action: 'update', backup: true },
            { width: 615, size: 24, action: 'copy', backup: true },
            { width: 390, size: 16, action: 'cancel' },
            { width: 320, size: 20, action: 'escape', longName: true },
        ];
        for (const scenario of cases) {
            await page.setViewportSize({ width: scenario.width, height: 900 });
            await page.setContent('<base href="http://mvu-ui.test/"><style>' + hostCss + core.extensionStyle() +
                (font ? '@font-face{font-family:TestChinese;src:url("/font")}' : '') +
                'body{margin:0;padding:0;background:#161616;color:#ddd;font:' + scenario.size + 'px TestChinese,sans-serif}</style>' +
                '<div class="mvu2shujuku-operation-overlay" aria-label="保存进度测试层">正在保存</div>');
            await page.evaluate(async () => { await document.fonts.ready; });
            await page.evaluate(({ source, longName }) => {
                const saver = (0, eval)('(' + source + ')')({ document });
                const name = '校园恋爱综漫1.8_数据库' + (longName ? '_长书名验证'.repeat(12) : '');
                window.conflictResult = undefined;
                saver.promptConflict({ name }).then(result => { window.conflictResult = result; });
            }, { source: factory.toString(), longName: scenario.longName });
            const modal = page.locator('.mvu2shujuku-worldbook-conflict');
            await modal.waitFor();
            const dimensions = await modal.evaluate(node => {
                const box = node.querySelector('.mvu2shujuku-operation-box');
                return { width: box.clientWidth, scrollWidth: box.scrollWidth, fontLoaded: document.fonts.check('16px TestChinese', '中文'),
                    buttons: [...node.querySelectorAll('button')].map(button => {
                        const rect = button.getBoundingClientRect(), range = document.createRange();
                        range.selectNodeContents(button);
                        const text = range.getBoundingClientRect();
                        return { text: button.textContent, width: rect.width, height: rect.height, top: rect.top,
                            textWidth: text.width, lines: range.getClientRects().length };
                    }) };
            });
            assert.ok(dimensions.scrollWidth <= dimensions.width + 1, JSON.stringify(dimensions));
            if (font) assert.strictEqual(dimensions.fontLoaded, true, '中文字体应实际加载');
            for (const button of dimensions.buttons) {
                assert.strictEqual(button.lines, 1, '按钮文字不得拆行');
                assert.ok(button.width >= button.textWidth + 22, JSON.stringify(button));
                assert.ok(button.height >= 44 && button.height < 70, JSON.stringify(button));
                const row = dimensions.buttons.filter(other => Math.abs(other.top - button.top) < 1);
                assert.ok(row.every(other => Math.abs(other.width - button.width) < 1), '同一行按钮应等宽');
            }
            if (scenario.width === 1280) assert.ok(dimensions.buttons.every(b => b.top === dimensions.buttons[0].top), '宽屏三按钮应同排');
            const checkbox = modal.locator('[data-worldbook-backup]');
            assert.strictEqual(await checkbox.isChecked(), false);
            if (scenario.backup) await checkbox.check();
            const filename = 'width-' + scenario.width + '-font-' + scenario.size + '.png';
            await modal.locator('.mvu2shujuku-operation-box').screenshot({ path: path.join(work, filename) });
            if (scenario.action === 'escape') { await checkbox.focus(); await page.keyboard.press('Escape'); }
            else await modal.locator('[data-worldbook-action="' + scenario.action + '"]').click();
            await modal.waitFor({ state: 'hidden' });
            const choice = await page.evaluate(() => window.conflictResult);
            assert.deepStrictEqual(choice, { action: scenario.action === 'escape' ? 'cancel' : scenario.action,
                backup: scenario.action === 'update' && scenario.backup === true });
            results.push({ ...scenario, ...dimensions, filename, choice });
        }
        assert.deepStrictEqual(errors, []);
        fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ results, errors }, null, 2));
        console.log(JSON.stringify({ scenarios: results.length, errors, directory: work }));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
