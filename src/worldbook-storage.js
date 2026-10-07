'use strict';

// 使用宿主的角色书转换器，网络读写绕过可能过期的世界书缓存。
module.exports = function createWorldbookStorage(deps) {
    let modulePromise;
    const load = () => modulePromise || (modulePromise = deps.loadModule());
    async function post(path, body) {
        const response = await deps.fetch(path, {
            method: 'POST', headers: await deps.getHeaders(), body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('世界书接口 ' + path + '：HTTP ' + response.status);
        return response;
    }
    return {
        document: deps.document,
        async convertBook(book) { return (await load()).convertCharacterBook(book); },
        async listNames() {
            const data = await (await post('/api/settings/get', {})).json();
            if (!Array.isArray(data.world_names)) throw new Error('宿主未返回世界书名称列表');
            return data.world_names;
        },
        async read(name) { return (await post('/api/worldinfo/get', { name })).json(); },
        async write(name, data) { await post('/api/worldinfo/edit', { name, data }); },
        async refresh(name, data) {
            const mod = await load();
            mod.worldInfoCache.set(name, data);
            await mod.updateWorldInfoList();
            const context = deps.getContext();
            if (context.eventSource && context.event_types?.WORLDINFO_UPDATED) {
                await context.eventSource.emit(context.event_types.WORLDINFO_UPDATED, name, data);
            }
        },
        async backup(name, data) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            deps.download(name + '-备份-' + stamp + '.json', 'application/json', JSON.stringify(data, null, 2));
        },
    };
};
