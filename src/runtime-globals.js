'use strict';

// 只把当前窗口保存在共享 list；WeakMap 让暂时离线的窗口复用未还原的原始值。
function createRuntimeGlobals(options) {
    'use strict';
    const { readSharedState, isOursShimFn, readFake } = options;
    function registry() {
        const reg = readSharedState();
        if (!reg || typeof reg !== 'object') return null;
        if (!Array.isArray(reg.list)) reg.list = [];
        // 跨 realm 的 WeakMap 也可复用；普通 Map 会强持有已移除窗口。
        if (Object.prototype.toString.call(reg.originalsByWindow) !== '[object WeakMap]') {
            reg.originalsByWindow = new WeakMap();
        }
        return reg;
    }
    function note(w) {
        try {
            const reg = registry();
            if (!reg || !w) return null;
            let rec = reg.list.find(r => r && r.w === w);
            if (!rec) rec = reg.originalsByWindow.get(w);
            if (!rec) rec = { w, get: undefined, hasGet: false, upd: undefined, hasUpd: false, rep: undefined, hasRep: false, ins: undefined, hasIns: false, mvu: undefined, hasMvu: false, gav: undefined, hasGav: false, wait: undefined, hasWait: false, msg: undefined, hasMsg: false };
            if (!reg.list.includes(rec)) reg.list.push(rec);
            reg.originalsByWindow.set(w, rec);
            if (!rec.hasGet && typeof w.getVariables === 'function' && !isOursShimFn(w.getVariables)) { rec.get = w.getVariables; rec.hasGet = true; }
            if (!rec.hasUpd && typeof w.updateVariablesWith === 'function' && !isOursShimFn(w.updateVariablesWith)) { rec.upd = w.updateVariablesWith; rec.hasUpd = true; }
            if (!rec.hasRep && typeof w.replaceVariables === 'function' && !isOursShimFn(w.replaceVariables)) { rec.rep = w.replaceVariables; rec.hasRep = true; }
            if (!rec.hasIns && typeof w.insertOrAssignVariables === 'function' && !isOursShimFn(w.insertOrAssignVariables)) { rec.ins = w.insertOrAssignVariables; rec.hasIns = true; }
            if (!rec.hasMvu && w.Mvu && !isOursShimFn(w.Mvu) && !w.Mvu.__mvu2shujukuBridgeFake && !w.Mvu.__mvu2shujukuFake) { rec.mvu = w.Mvu; rec.hasMvu = true; }
            if (!rec.hasGav && typeof w.getAllVariables === 'function' && !isOursShimFn(w.getAllVariables)) { rec.gav = w.getAllVariables; rec.hasGav = true; }
            if (!rec.hasWait && typeof w.waitGlobalInitialized === 'function' && !isOursShimFn(w.waitGlobalInitialized)) { rec.wait = w.waitGlobalInitialized; rec.hasWait = true; }
            if (!rec.hasMsg && typeof w.getChatMessages === 'function' && !isOursShimFn(w.getChatMessages)) { rec.msg = w.getChatMessages; rec.hasMsg = true; }
            return rec;
        } catch (e) { return null; }
    }
    function restore(rec) {
        try {
            const w = rec.w;
            if (!w) return true;
            if (isOursShimFn(w.getVariables)) { if (rec.hasGet) w.getVariables = rec.get; else delete w.getVariables; }
            if (isOursShimFn(w.updateVariablesWith)) { if (rec.hasUpd) w.updateVariablesWith = rec.upd; else delete w.updateVariablesWith; }
            if (isOursShimFn(w.replaceVariables)) { if (rec.hasRep) w.replaceVariables = rec.rep; else delete w.replaceVariables; }
            if (isOursShimFn(w.insertOrAssignVariables)) { if (rec.hasIns) w.insertOrAssignVariables = rec.ins; else delete w.insertOrAssignVariables; }
            if (w.getAllVariables && isOursShimFn(w.getAllVariables)) { if (rec.hasGav) w.getAllVariables = rec.gav; else delete w.getAllVariables; }
            if (w.Mvu && (w.Mvu === readFake() || w.Mvu.__mvu2shujukuFake || w.Mvu.__mvu2shujukuBridgeFake)) { if (rec.hasMvu) w.Mvu = rec.mvu; else delete w.Mvu; }
            if (isOursShimFn(w.waitGlobalInitialized)) { if (rec.hasWait) w.waitGlobalInitialized = rec.wait; else delete w.waitGlobalInitialized; }
            if (isOursShimFn(w.getChatMessages)) { if (rec.hasMsg) w.getChatMessages = rec.msg; else delete w.getChatMessages; }
            return true;
        } catch (e) { return false; }
    }
    function releaseMissing(keep) {
        const reg = registry();
        if (!reg) return;
        const previous = reg.list.splice(0);
        for (const rec of previous) {
            let w;
            try { w = rec && rec.w; } catch (e) {}
            // 旧桥可能只写 list、尚未经过 note；移出强引用前也须保留失败还原的原始值。
            if (w) { try { reg.originalsByWindow.set(w, rec); } catch (e) {} }
            if (w && keep && keep.has(w)) { reg.list.push(rec); continue; }
            try {
                if (restore(rec) && w) reg.originalsByWindow.delete(w);
            } catch (e) {
                // 单个跨源窗口失效不能妨碍其他窗口清理；list 已提前移除。
            }
        }
    }
    function retainWindows(windows) {
        releaseMissing(new Set(Array.isArray(windows) ? windows : []));
    }
    function restoreAll() { releaseMissing(null); }
    return { note, retainWindows, restoreAll };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createRuntimeGlobals;
