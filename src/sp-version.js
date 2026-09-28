'use strict';

// 转换时读取目标安装信息，不执行脚本、不写宿主，也不把“无法识别”等同于旧版。
function createSpVersionReader(dependencies) {
    'use strict';
    const { readExtensions, readWindows, readApi } = dependencies;
    const normalize = value => {
        const match = String(value || '').trim().match(/^v?(\d+\.\d+(?:\.\d+){0,2})$/i);
        return match ? match[1] : null;
    };
    const pinnedVersion = name => {
        // 只认官方仓库的固定发布标签；main、任意数字文件名及其他二创仓库均不能证明版本。
        const match = String(name || '').match(/^https:\/\/(?:[a-z0-9-]+\.)?jsdelivr\.net\/gh\/AlbusKen\/shujuku@spv(\d+\.\d+(?:\.\d+){0,2})\/index\.js(?:\?[^#]*)?(?:#.*)?$/i);
        return match ? normalize(match[1]) : null;
    };
    return async function readTargetSpVersion() {
        try {
            const extensions = await readExtensions();
            const disabled = new Set(extensions?.extension_settings?.disabledExtensions || []);
            const matches = [];
            for (const name of extensions?.extensionNames || []) {
                if (disabled.has(name)) continue;
                const manifest = await extensions.getExtensionManifest(name);
                if (manifest && /^SP[·・\s]*数据库(?:\s|$)/i.test(String(manifest.display_name || ''))) matches.push(manifest);
            }
            // 已安装的扩展存在多个候选或坏版本时不拿另一个脚本掩盖歧义。
            if (matches.length) {
                const versions = new Set(matches.map(manifest => normalize(manifest.version)));
                return versions.size === 1 && !versions.has(null) ? [...versions][0] : 'unknown';
            }
        } catch (_) {}
        // 脚本版没有 ST manifest。只查活跃窗口实际加载过的模块，并要求 SP API 已发布。
        try {
            const api = readApi();
            if (!api || typeof api.importTemplateFromData !== 'function') return 'unknown';
            const versions = new Set();
            for (const w of readWindows() || []) {
                try {
                    const entries = w.performance?.getEntriesByType('resource') || [];
                    for (const entry of entries) {
                        if (entry.initiatorType !== 'script') continue;
                        const version = pinnedVersion(entry.name);
                        if (version) versions.add(version);
                    }
                } catch (_) { /* 跨源窗口不能阻断其他同源脚本窗口。 */ }
            }
            return versions.size === 1 ? [...versions][0] : 'unknown';
        } catch (_) { return 'unknown'; }
    };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createSpVersionReader;
