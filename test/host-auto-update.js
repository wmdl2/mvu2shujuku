'use strict';
const assert = require('assert/strict');
// 使用数据库真实开关，避免仅调整门槛后仍被表级配置或异步任务触发。
module.exports = async function setAutoUpdateEnabled(page, enabled) {
    const authorMonitorClose = page.locator('#wb-float-close');
    if (await authorMonitorClose.isVisible()) await authorMonitorClose.click();
    await page.evaluate(() => AutoCardUpdaterAPI.openSettings());
    await page.getByRole('button', { name: '仪表盘', exact: true }).dispatchEvent('click');
    const toggle = page.getByRole('switch', { name: '自动更新', exact: true });
    const wanted = String(!!enabled);
    // 作者浮窗可能覆盖此位置；直接向真实开关派发事件，仍走组件处理和保存。
    if (await toggle.getAttribute('aria-checked') !== wanted) await toggle.dispatchEvent('click');
    await page.waitForFunction(wanted => document.querySelector('#acu-app-v2 [role="switch"][aria-label="自动更新"]')?.getAttribute('aria-checked') === wanted, wanted);
    assert.equal(await toggle.getAttribute('aria-checked'), wanted, '真实自动更新开关');
    await page.waitForTimeout(2500);
    await page.evaluate(async () => await (await import('/script.js')).saveSettings());
    const close = page.locator('#acu-app-v2 .acu-v2-app__close');
    if (await close.isVisible()) await close.dispatchEvent('click');
};
