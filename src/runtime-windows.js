'use strict';

function createRuntimeWindows(options = {}) {
    const readRoots = typeof options.readRoots === 'function' ? options.readRoots : () => options.readRoots || [];
    const readSessionKey = typeof options.readSessionKey === 'function' ? options.readSessionKey : () => undefined;
    const Observer = options.MutationObserver;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const stats = { scans: 0, queries: 0, hits: 0, enumeratedFrames: 0 };
    let cached = [];
    let observers = [];
    let loads = [];
    let dirty = true;
    let cacheable = false;
    let disposed = false;
    let sessionKey;
    let hasSessionKey = false;
    let notifying = false;

    const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
    const isIframe = node => {
        const name = safe(() => String(node && (node.localName || node.tagName || '')).toLowerCase(), '');
        return name === 'iframe';
    };
    const impactsIframe = node => {
        if (isIframe(node)) return true;
        try {
            if (node && typeof node.querySelectorAll === 'function') {
                stats.queries += 1;
                return Array.from(node.querySelectorAll('iframe') || []).length > 0;
            }
            if (node && typeof node.querySelector === 'function') {
                stats.queries += 1;
                return !!node.querySelector('iframe');
            }
        } catch (e) {}
        return false;
    };
    const markDirty = () => {
        if (disposed || dirty) return;
        dirty = true;
        if (onChange && !notifying) {
            notifying = true;
            try { onChange(); } catch (e) {}
            notifying = false;
        }
    };
    const drain = () => {
        let changed = false;
        for (const observer of observers.slice()) {
            let records = [];
            try { records = observer.takeRecords ? observer.takeRecords() || [] : []; } catch (e) {}
            for (const record of records) {
                const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
                if (nodes.some(impactsIframe)) changed = true;
            }
        }
        if (changed) markDirty();
    };
    const cleanup = () => {
        for (const observer of observers.splice(0)) { try { observer.disconnect(); } catch (e) {} }
        for (const item of loads.splice(0)) { try { item.frame.removeEventListener('load', item.listener); } catch (e) {} }
    };
    const currentDocument = win => safe(() => {
        if (!win || win.closed) return null;
        return win.document || null;
    }, null);
    const rootsNow = () => {
        const roots = safe(() => readRoots(), []) || [];
        return Array.from(roots).filter(Boolean);
    };
    const scan = () => {
        cleanup();
        stats.scans += 1;
        cacheable = typeof Observer === 'function';
        const windows = [];
        const seenWindows = new Set();
        const seenDocuments = new Set();
        const visit = win => {
            if (!win || seenWindows.has(win)) return;
            const doc = currentDocument(win);
            if (!doc) return;
            seenWindows.add(win); windows.push(win);
            if (seenDocuments.has(doc)) return;
            seenDocuments.add(doc);
            let frames = [];
            try {
                if (typeof doc.querySelectorAll !== 'function') return;
                stats.queries += 1;
                frames = Array.from(doc.querySelectorAll('iframe') || []);
                stats.enumeratedFrames += frames.length;
            } catch (e) { return; }
            for (const frame of frames) {
                const listener = () => markDirty();
                try { if (typeof frame.addEventListener === 'function') { frame.addEventListener('load', listener); loads.push({ frame, listener }); } } catch (e) {}
                const child = safe(() => frame.contentWindow, null);
                if (child) visit(child);
            }
        };
        for (const root of rootsNow()) visit(root);
        if (typeof Observer === 'function') {
            for (const doc of seenDocuments) {
                try {
                    const observer = new Observer(records => {
                        if (records.some(record => [...(record.addedNodes || []), ...(record.removedNodes || [])].some(impactsIframe))) markDirty();
                    });
                    observer.observe(doc, { childList: true, subtree: true });
                    observers.push(observer);
                } catch (e) { cacheable = false; }
            }
        }
        cached = windows.map(win => ({ win, doc: currentDocument(win) }));
        cachedRoots = rootsNow();
        dirty = false;
        return windows;
    };
    let cachedRoots = [];
    const rootsUnchanged = roots => roots.length === cachedRoots.length && roots.every((root, index) => root === cachedRoots[index]);
    const cacheStillValid = () => {
        if (!cached.length) return rootsNow().length === 0;
        for (const entry of cached) {
            if (!entry.win || safe(() => entry.win.closed, true) || currentDocument(entry.win) !== entry.doc) return false;
        }
        return true;
    };
    const getWindows = () => {
        if (disposed) return [];
        const nextKey = safe(() => readSessionKey(), undefined);
        if (!hasSessionKey || nextKey !== sessionKey) {
            hasSessionKey = true; sessionKey = nextKey; cleanup(); cached = []; dirty = true;
        }
        drain();
        const roots = rootsNow();
        if (!Observer || !cacheable || !rootsUnchanged(roots)) dirty = true;
        if (!dirty && !cacheStillValid()) { cleanup(); dirty = true; }
        if (dirty) return scan().slice();
        stats.hits += 1;
        return cached.map(entry => entry.win);
    };
    const invalidate = () => { if (!disposed) { cleanup(); dirty = true; } };
    const dispose = () => { if (disposed) return; disposed = true; cleanup(); cached = []; dirty = true; };
    return { getWindows, invalidate, dispose, stats };
}

module.exports = createRuntimeWindows;
module.exports.createRuntimeWindows = createRuntimeWindows;
