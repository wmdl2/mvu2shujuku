'use strict';
const assert = require('assert');
const path = require('path');

async function exerciseEditor(page) {
    const rows = page.locator('.mvu2shujuku-table-row');
    assert.ok(await rows.count() >= 3, '多选夹具至少三张表');
    const uids = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.sheetUid));
    const originalInjection = await rows.locator('.mvu2shujuku-table-injection').evaluateAll(nodes => nodes.map(node => node.checked));
    assert.strictEqual(await page.locator('.mvu2shujuku-apply-selected').isDisabled(), true);
    assert.strictEqual(await page.locator('.mvu2shujuku-invert-visible').isDisabled(), false);
    await rows.nth(0).locator('.mvu2shujuku-table-select').check();
    await rows.nth(2).locator('.mvu2shujuku-table-select').check();
    const hiddenSelectionName = await rows.nth(1).locator('.mvu2shujuku-param-name span').textContent();
    await page.locator('.mvu2shujuku-table-search').fill(hiddenSelectionName);
    const invert = page.locator('.mvu2shujuku-invert-visible');
    assert.strictEqual(await rows.nth(0).locator('.mvu2shujuku-table-select').isChecked(), true);
    assert.strictEqual(await rows.nth(1).locator('.mvu2shujuku-table-select').isChecked(), false);
    await invert.click();
    assert.strictEqual(await rows.nth(0).locator('.mvu2shujuku-table-select').isChecked(), true, '反选保留隐藏行选择');
    assert.strictEqual(await rows.nth(1).locator('.mvu2shujuku-table-select').isChecked(), true, '反选当前可见行');
    assert.strictEqual(await page.locator('.mvu2shujuku-select-visible').isChecked(), true);
    await invert.click();
    assert.strictEqual(await rows.nth(1).locator('.mvu2shujuku-table-select').isChecked(), false);
    await page.locator('.mvu2shujuku-table-search').fill('');
    await page.locator('.mvu2shujuku-bulk-param').selectOption('contextDepth');
    await page.locator('.mvu2shujuku-bulk-value').fill('8');
    await page.locator('.mvu2shujuku-apply-selected').click();
    assert.strictEqual(await rows.nth(0).locator('.mvu2shujuku-param-value').inputValue(), '8');
    assert.strictEqual(await rows.nth(2).locator('.mvu2shujuku-param-value').inputValue(), '8');
    // 筛选不清除已有选择；应用所选不偷偷变成应用当前可见行。
    await page.locator('.mvu2shujuku-table-search').fill('__没有这个表__');
    assert.strictEqual(await page.locator('.mvu2shujuku-table-row:visible').count(), 0);
    assert.strictEqual(await page.locator('.mvu2shujuku-select-visible').isDisabled(), true);
    assert.strictEqual(await page.locator('.mvu2shujuku-invert-visible').isDisabled(), true);
    await page.locator('.mvu2shujuku-bulk-param').selectOption('injectIntoWorldbook');
    await page.locator('.mvu2shujuku-bulk-injection').selectOption('false');
    await page.locator('.mvu2shujuku-apply-selected').click();
    await page.locator('.mvu2shujuku-table-search').fill('');
    assert.strictEqual(await rows.nth(0).locator('.mvu2shujuku-table-injection').isChecked(), false);
    assert.strictEqual(await rows.nth(2).locator('.mvu2shujuku-table-injection').isChecked(), false);
    assert.strictEqual(await rows.nth(1).locator('.mvu2shujuku-table-injection').isChecked(), originalInjection[1]);
    await rows.nth(0).locator('.mvu2shujuku-table-injection').check();
    await rows.nth(0).locator('.mvu2shujuku-table-injection').uncheck();
    await page.locator('.mvu2shujuku-select-visible').check();
    await page.locator('.mvu2shujuku-bulk-param').selectOption('skipFloors');
    await page.locator('.mvu2shujuku-bulk-value').fill('2');
    await page.locator('.mvu2shujuku-apply-selected').click();
    // 单项控件随后由原有 UI 场景继续验证更新频率 7。
    await rows.nth(0).locator('.mvu2shujuku-param-select').selectOption('updateFrequency');
    const report = await page.evaluate(() => {
        const box = document.querySelector('.mvu2shujuku-result');
        const summary = box.querySelector('.mvu2shujuku-report-summary');
        const editor = box.querySelector('.mvu2shujuku-param-editor');
        const scratch = document.createElement('div');
        const literal = '<img src=x onerror="window.__reportExecuted=true">';
        window.__MVU2SHUJUKU_RESULT_VIEW_FACTORY__({ document }).renderReport(scratch, {
            meta: { tableCount: 1 }, reportText: literal,
            report: { manualReview: [literal], warnings: [{ message: '重要警告' }], notes: ['普通说明'], autoRewrites: ['转换记录'] },
        });
        return { beforeEditor: !!(summary.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING),
            fullClosed: !summary.querySelector('.mvu2shujuku-full-report').open,
            attentionOpen: [...scratch.querySelectorAll('.mvu2shujuku-attention')].every(node => node.open),
            compatibilityTitle: scratch.querySelector('.mvu2shujuku-attention summary').textContent.startsWith('兼容性待确认'),
            compatibilityHint: scratch.querySelector('.mvu2shujuku-hint').textContent === '以下为兼容提醒，不代表转换失败；部分行为可能与原卡不同，请按需核对。',
            literalSafe: !scratch.querySelector('img') && scratch.querySelector('li').textContent === literal,
            fullTextPreserved: scratch.querySelector('textarea').value === literal };
    });
    assert.deepStrictEqual(report, { beforeEditor: true, fullClosed: true, attentionOpen: true, compatibilityTitle: true, compatibilityHint: true, literalSafe: true, fullTextPreserved: true });
    return { uids, originalInjection, report };
}
function verifyTemplate(template, edits) {
    for (const [index, uid] of edits.uids.entries()) {
        assert.strictEqual(template[uid].updateConfig.skipFloors, 2);
        if (index === 0 || index === 2) {
            assert.strictEqual(template[uid].updateConfig.contextDepth, 8);
            assert.strictEqual(template[uid].exportConfig.injectIntoWorldbook, false);
        } else {
            assert.ok(template[uid].updateConfig.contextDepth === undefined || template[uid].updateConfig.contextDepth === -1);
            assert.strictEqual(template[uid].exportConfig?.injectIntoWorldbook !== false, edits.originalInjection[index]);
        }
    }
}
async function verifyProfileAndLayout(page, edits, work) {
    const rows = page.locator('.mvu2shujuku-table-row');
    for (const index of [0, 2]) assert.strictEqual(await rows.nth(index).locator('.mvu2shujuku-table-injection').isChecked(), false);
    const originalViewport = page.viewportSize();
    await page.locator('.mvu2shujuku-report-summary').scrollIntoViewIfNeeded();
    await page.locator('#mvu2shujuku-settings .mvu2shujuku-card').screenshot({ path: path.join(work, 'frontend-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.mvu2shujuku-param-editor').scrollIntoViewIfNeeded();
    const fits = await page.locator('.mvu2shujuku-param-editor').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.ok(fits.scrollWidth <= fits.width + 1, JSON.stringify(fits));
    await page.locator('#mvu2shujuku-settings .mvu2shujuku-card').screenshot({ path: path.join(work, 'frontend-mobile.png') });
    await page.setViewportSize(originalViewport);
    return fits;
}
module.exports = { exerciseEditor, verifyTemplate, verifyProfileAndLayout };
