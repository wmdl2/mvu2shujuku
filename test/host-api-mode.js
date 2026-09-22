'use strict';
// 仅供隔离实机夹具：切 SP 独立 API 并保证恢复原配置，不读取或打印真实凭据。
module.exports = async function withDirectApi(page, restorePage, action) {
    const saved = await page.evaluate(async () => {
        const groups = window.SillyTavern.getContext().extensionSettings.__userscripts;
        const namespace = Object.keys(groups).find(key => key.startsWith('shujuku_') && key.endsWith('__userscript_settings_v1'));
        const key = Object.keys(groups[namespace]).find(key => key.includes('_profile_v1__') && key.endsWith('__settings'));
        const raw = groups[namespace][key], settings = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
        const set = target => {
            target.apiMode = 'custom'; target.apiConfig = { ...target.apiConfig, useMainApi: false,
                url: location.origin + '/fixture', apiKey: '', model: 'isolated-direct-probe' };
        };
        set(settings); (settings.apiPresets || []).forEach(set);
        groups[namespace][key] = typeof raw === 'string' ? JSON.stringify(settings) : settings;
        await (await import('/script.js')).saveSettings();
        return { namespace, key, raw };
    });
    try {
        await page.reload({ waitUntil: 'domcontentloaded' }); await restorePage();
        return await action();
    } finally {
        await page.evaluate(async saved => {
            window.SillyTavern.getContext().extensionSettings.__userscripts[saved.namespace][saved.key] = saved.raw;
            await (await import('/script.js')).saveSettings();
        }, saved);
        await page.reload({ waitUntil: 'domcontentloaded' }); await restorePage();
    }
};
