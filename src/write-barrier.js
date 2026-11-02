'use strict';

// Observe the existing writer's completion contract; never submit or replay data.
function createWriteBarrier(options) {
    function failure(message, code) {
        return Object.assign(new Error(message), { code });
    }
    async function wait(session, cancellation) {
        const check = () => {
            options.assertCurrent(session);
            if (cancellation?.cancelled) throw failure('本次操作已取消', 'MVU_OPERATION_CANCELLED');
        };
        for (;;) {
            check();
            const pending = options.readPending();
            if (!pending) return;
            const saved = await (cancellation ? Promise.race([pending, cancellation.promise]) : pending);
            check();
            if (saved !== true) throw failure('变量保存未完成', 'MVU_WRITE_NOT_SAVED');
            // Resolve the author's Promise continuations before deciding that
            // its serial queue is empty. This is one event-loop turn, not a
            // guessed persistence delay; an idle writer does not yield.
            await options.yieldTurn();
        }
    }
    return { wait };
}
module.exports = createWriteBarrier;
