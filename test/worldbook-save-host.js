'use strict';
// 真正的插件保存按钮、冲突组件和宿主世界书接口；仅使用公开合成卡。
const assert = require('assert'), fs = require('fs');
module.exports = async function ({ page, record }) {
    const source = require('./synthetic-card')();
    const unique = '公开世界书保存_' + Date.now();
    source.data.name = unique;
    source.data.character_book.name = unique + '规则';
    source.data.extensions.world = source.data.character_book.name;
    const bookName = source.data.character_book.name + '_数据库';
    async function api(path, body) {
        return page.evaluate(async ({ path, body }) => {
            const context = window.SillyTavern.getContext();
            const response = await fetch(path, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body) });
            if (!response.ok) throw new Error(path + ' HTTP ' + response.status);
            return response.json();
        }, { path, body });
    }
    const read = name => api('/api/worldinfo/get', { name });
    const write = (name, data) => api('/api/worldinfo/edit', { name, data });
    const count = () => page.evaluate(() => window.SillyTavern.getContext().characters.length);
    const save = async () => {
        // 角色创建后的宿主异步界面刷新可能收起扩展抽屉。
        if (!await page.locator('#extensions_settings').isVisible()) await page.locator('#extensions-settings-button').click();
        const button = page.locator('#mvu2shujuku-save-card');
        if (!await button.isVisible()) await page.locator('.inline-drawer-header').filter({ hasText: 'MVU转数据库' }).click();
        await button.click();
    };
    const conflict = page.locator('[aria-label="世界书同名冲突"]');
    const backup = conflict.locator('[data-worldbook-backup]');
    async function finishSave() {
        const popup = page.locator('dialog[open]').filter({ hasText: '角色卡已保存' });
        await popup.waitFor({ timeout: 60000 });
        const text = await popup.innerText();
        assert.ok(!text.includes('脚本复核未通过'), text);
        await popup.locator('.popup-button-ok').click();
        await popup.waitFor({ state: 'hidden' });
        await page.locator('.mvu2shujuku-operation-overlay').waitFor({ state: 'hidden' });
        return text;
    }
    async function lastCard() {
        const avatar = await page.evaluate(name => {
            const cards = window.SillyTavern.getContext().characters.filter(ch => ch.name === name);
            return cards[cards.length - 1]?.avatar;
        }, unique + '_数据库');
        assert.ok(avatar);
        const card = await api('/api/characters/get', { avatar_url: avatar });
        return card.data || card;
    }
    await page.locator('#extensions-settings-button').click();
    await page.locator('.inline-drawer-header').filter({ hasText: 'MVU转数据库' }).click();
    await page.locator('input[name="mvu2shujuku-source"][value="file"]').check();
    await page.locator('#mvu2shujuku-file').setInputFiles({ name: 'worldbook-save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
    await page.locator('#mvu2shujuku-convert-file').click();
    await page.locator('#mvu2shujuku-save-card').waitFor();
    await page.waitForFunction(() => !document.querySelector('#mvu2shujuku-save-card')?.disabled);
    await save();
    assert.match(await finishSave(), /世界书已创建/);
    const desired = await read(bookName), first = await lastCard();
    assert.strictEqual(first.extensions.world, bookName);
    assert.strictEqual(first.character_book.name, bookName);
    assert.ok(Object.keys(desired.entries).length > 0);
    record('worldbook-save-create-and-bind', { bookName });
    const changed = JSON.parse(JSON.stringify(desired));
    changed.entries[Object.keys(changed.entries)[0]].content = '仅存在于旧世界书的编辑';
    changed.extensions = { author_setting: '完整备份保留' };
    const downloads = [];
    page.on('download', d => downloads.push(d));
    if (!process.argv.includes('--worldbook-save-from=backup')) {
        await save(); assert.match(await finishSave(), /世界书已复用/);
        assert.deepStrictEqual(await read(bookName), desired);
        record('worldbook-save-identical-reuse', {});
        await write(bookName, changed);
        const beforeCancel = await count();
        await save(); await conflict.waitFor(); assert.strictEqual(await backup.isChecked(), false);
        await backup.focus(); await page.keyboard.press('Escape');
        await conflict.waitFor({ state: 'hidden' });
        await page.locator('.mvu2shujuku-operation-overlay').waitFor({ state: 'hidden' });
        assert.strictEqual(await count(), beforeCancel); assert.deepStrictEqual(await read(bookName), changed);
        record('worldbook-save-cancel-and-unchecked-default', {});
        await save(); await conflict.waitFor(); assert.strictEqual(await backup.isChecked(), false);
        await conflict.locator('[data-worldbook-action="update"]').click();
        assert.match(await finishSave(), /世界书已更新/);
        assert.strictEqual(downloads.length, 0); assert.deepStrictEqual(await read(bookName), desired);
        record('worldbook-save-update-without-backup', {});
    }
    await write(bookName, changed);
    await save(); await conflict.waitFor(); await backup.check();
    const backupDownload = page.waitForEvent('download');
    await conflict.locator('[data-worldbook-action="update"]').click();
    const file = await backupDownload;
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(await file.path(), 'utf8')), changed);
    assert.match(await finishSave(), /已发起旧世界书 JSON 备份下载/);
    assert.deepStrictEqual(await read(bookName), desired);
    record('worldbook-save-optional-native-json-backup', { file: file.suggestedFilename() });
    await write(bookName, changed); await write(bookName + ' (1)', { entries: {} });
    const downloadsBeforeCopy = downloads.length;
    await save(); await conflict.waitFor(); await backup.check();
    await conflict.locator('[data-worldbook-action="copy"]').click(); await finishSave();
    const copied = await lastCard(), copyName = bookName + ' (2)';
    assert.strictEqual(copied.extensions.world, copyName); assert.strictEqual(copied.character_book.name, copyName);
    assert.deepStrictEqual(await read(bookName), changed);
    assert.strictEqual((await read(copyName)).originalData.name, copyName);
    assert.strictEqual(downloads.length, downloadsBeforeCopy);
    record('worldbook-save-copy-unique-and-original-preserved', { copyName });
    // 上一次另存只影响保存副本，下一次仍应比较原转换结果的书名。
    const beforeRace = await count();
    await save(); await conflict.waitFor();
    const race = JSON.parse(JSON.stringify(changed)); race.extensions.race = '确认期间编辑';
    await write(bookName, race);
    await conflict.locator('[data-worldbook-action="update"]').click();
    const failedPopup = page.locator('dialog[open]').filter({ hasText: '世界书在确认期间发生变化' });
    await failedPopup.waitFor({ timeout: 30000 }); await failedPopup.locator('.popup-button-ok').click();
    assert.strictEqual(await count(), beforeRace); assert.deepStrictEqual(await read(bookName), race);
    record('worldbook-save-concurrent-edit-rejected', {});
    await page.reload(); await page.waitForFunction(() => window.SillyTavern?.getContext()?.characters?.length > 0);
    const names = (await api('/api/settings/get', {})).world_names;
    assert.ok(names.includes(bookName)); assert.ok(names.includes(copyName));
    assert.deepStrictEqual(await read(bookName), race);
    assert.strictEqual((await read(copyName)).originalData.name, copyName);
    record('worldbook-save-reload-persistence', {});
};
