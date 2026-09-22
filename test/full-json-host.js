'use strict';
const assert = require('assert');
const core = require('../src/mvu2shujuku');
const presenceHost = require('./container-presence-host');
module.exports = async function fullJsonHost(h) {
    const { page, record } = h, source = presenceHost.fixture(true).source;
    await page.locator('#extensions-settings-button').click();
    await page.locator('.inline-drawer-header').filter({ hasText: 'MVU转数据库' }).click();
    await page.locator('#mvu2shujuku-json-containers').check();
    try {
        await page.locator('input[name="mvu2shujuku-source"][value="file"]').check();
        await page.locator('#mvu2shujuku-file').setInputFiles({ name: 'full-json.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
        await page.locator('#mvu2shujuku-convert-file').click();
        await page.locator('.mvu2shujuku-param-grid .mvu2shujuku-param-value').first().waitFor({ timeout: 30000 });
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#mvu2shujuku-downloads button').filter({ hasText: /-DB\.json/ }).first().click()]);
        const result = JSON.parse(require('fs').readFileSync(await download.path(), 'utf8'));
        const layout = JSON.parse((result.data || result).extensions.mvu2shujuku.layout);
        assert.ok(layout.length && layout.every(e => e.valueCol === '内容' && e.cols.length === 1));
        record('full-json-ui-enabled', { tables: layout.length });
    } finally { await page.locator('#mvu2shujuku-json-containers').uncheck(); }
    await presenceHost({ ...h, fullJson: true, initialOnly: process.argv.includes('--full-json-initial-only') });
};
module.exports.preflight = () => {
    const { source, initial } = presenceHost.fixture(true);
    for (const selection of [true, ['整组', '可空列表', '可空字典']]) {
        const r = core.convert(source, { mode: 'both', jsonContainers: selection });
        const layout = JSON.parse((r.card.data || r.card).extensions.mvu2shujuku.layout);
        assert.deepStrictEqual(core.statDataFromTables(layout, r.template).stat_data, initial);
        assert.strictEqual(initial.状态.金币, 10);
        assert.strictEqual(initial.背包.length, 4);
        assert.strictEqual(layout.find(e => e.group === '整组').valueCol, '内容');
    }
    return { checked: ['UI 全部容器', '实机选定容器'], groups: Object.keys(initial) };
};
