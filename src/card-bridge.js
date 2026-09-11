'use strict';

/** 卡内仅登记转换元数据；扩展负责 Mvu、事件和持久化。函数可直接内联。 */
function installCardBridge(payload, frame) {
    let host = frame;
    try { host = frame.top || frame; } catch (_) {}
    const previous = frame.__mvu2shujukuCardBridge;
    if (previous && typeof previous.stop === 'function') previous.stop();
    let stopped = false, timer = null, warning = null, attempts = 0;
    const status = { state: 'waiting', message: '等待 MVU转数据库 扩展加载' };
    frame.__mvu2shujukuBridgeStatus = status;
    payload.sourceWindow = frame;
    function clearWarning() {
        try { if (warning) warning.remove(); } catch (_) {}
        warning = null;
    }
    function showWarning(message) {
        status.message = message;
        try {
            const doc = host.document;
            if (!warning && doc && doc.body) {
                warning = doc.createElement('div');
                warning.setAttribute('role', 'status');
                warning.style.cssText = 'position:fixed;bottom:16px;right:16px;max-width:360px;padding:12px;background:#382b16;color:#fff;border:1px solid #a98441;border-radius:6px;z-index:2147483647;font:14px sans-serif;';
                doc.body.appendChild(warning);
            }
            if (warning) warning.textContent = message;
        } catch (_) {}
    }
    function stop() {
        stopped = true;
        if (timer !== null) frame.clearTimeout(timer);
        timer = null;
        clearWarning();
        if (typeof frame.removeEventListener === 'function') frame.removeEventListener('pagehide', stop);
    }
    function attempt() {
        if (stopped) return;
        timer = null;
        attempts++;
        try {
            const registry = host.__mvu2shujukuRuntime;
            if (registry && registry.owner === 'extension' && typeof registry.registerCard === 'function') {
                const accepted = registry.registerCard(payload);
                status.state = accepted === true ? 'registered' : 'rejected';
                status.message = accepted === true ? '已登记到 MVU转数据库 扩展' : '当前角色与此数据桥不匹配，登记已拒绝';
                stop();
                return;
            }
        } catch (error) {
            status.state = 'failed';
            showWarning('MVU转数据库 扩展登记失败，正在重试。请检查扩展是否正常加载。');
        }
        if (attempts >= 11 && status.state === 'waiting') {
            showWarning('此角色卡需要 MVU转数据库 扩展。请安装或启用扩展；加载完成后会自动连接。');
        }
        timer = frame.setTimeout(attempt, 1000);
    }
    frame.__mvu2shujukuCardBridge = { stop, status };
    if (typeof frame.addEventListener === 'function') frame.addEventListener('pagehide', stop);
    attempt();
    return frame.__mvu2shujukuCardBridge;
}

module.exports = installCardBridge;
