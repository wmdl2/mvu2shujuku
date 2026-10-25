'use strict';

// Author HTML may read only once at DOMContentLoaded. Recover only frames which
// actually observed an unavailable read, using the helper's native iframe reload.
function createFrontendReadiness(options) {
    'use strict';
    const records = new WeakMap();
    const sameTarget = (a, b) => !!a && !!b && a.index === b.index && a.message === b.message
        && a.swipe === b.swipe && a.text === b.text;
    function request(frame) {
        const target = options.target(frame);
        if (!target) return Promise.resolve(false);
        const session = options.capture();
        const old = records.get(frame);
        if (old && options.sameSession(old.session, session) && sameTarget(old.target, target)) {
            if (old.done) return Promise.resolve(false);
            if (old.document === frame.document) {
                if (old.pending) return old.pending;
                if (old.finished) return Promise.resolve(false);
            }
        }
        const record = { session, target, document: frame.document, done: false, pending: null };
        records.set(frame, record);
        const valid = () => records.get(frame) === record && options.current(session)
            && frame.document === record.document && sameTarget(options.target(frame), target);
        record.pending = (async () => {
            for (let attempt = 0; attempt < (options.maxAttempts || 40); attempt++) {
                if (!valid()) return false;
                try {
                    await options.prepare(target.index);
                    if (!valid()) return false;
                    const value = options.read(target.index);
                    if (value && value.__mvu2shujukuReadUnavailable !== true && frame.document.readyState !== 'loading') {
                        // Leave the current DOM event before rerunning author code.
                        await options.wait(0);
                        if (!valid()) return false;
                        record.done = true;
                        options.reload(frame);
                        return true;
                    }
                } catch (error) {
                    if (!['MVU_DATA_NOT_READY', 'MVU_HISTORY_NOT_READY'].includes(error.code)) throw error;
                }
                await options.wait(250);
            }
            return false;
        })().catch(error => { options.onError?.(error); return false; })
            .finally(() => { record.finished = true; record.pending = null; });
        return record.pending;
    }
    return { request };
}

module.exports = createFrontendReadiness;
