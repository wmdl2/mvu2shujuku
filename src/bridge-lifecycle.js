'use strict';

// 自包含工厂：桥退出后禁止新任务，并等待已经发出的 API 调用结束。
function createBridgeLifecycle(host) {
    let stopped = false, ready = null;
    const timers = new Map(), cleanups = [], calls = new Set(), proxies = new WeakMap();
    let notifyStop;
    const stoppedPromise = new Promise(resolve => { notifyStop = resolve; });
    const guard = fn => function (...args) { if (!stopped) return fn.apply(this, args); };
    function timer(repeat, fn, delay) {
        if (stopped) return null;
        const schedule = repeat ? host.setInterval : host.setTimeout;
        if (typeof schedule !== 'function') return null;
        let id;
        id = schedule.call(host, function () {
            if (!repeat) timers.delete(id);
            if (!stopped) fn();
        }, delay);
        timers.set(id, repeat);
        return id;
    }
    function clear(id) {
        const repeat = timers.get(id);
        timers.delete(id);
        const cancel = repeat ? host.clearInterval : host.clearTimeout;
        if (typeof cancel === 'function') cancel.call(host, id);
    }
    function cleanup(fn) {
        if (stopped) { try { fn(); } catch (_) {} }
        else cleanups.push(fn);
    }
    function on(bus, name, fn) {
        if (stopped || !bus || typeof bus.on !== 'function') return;
        const wrapped = guard(fn);
        bus.on(name, wrapped);
        cleanup(() => {
            const off = bus.off || bus.removeListener;
            if (typeof off === 'function') off.call(bus, name, wrapped);
        });
    }
    function eventOn(subscribe, name, fn) {
        if (stopped || typeof subscribe !== 'function') return;
        const handle = subscribe(name, guard(fn));
        cleanup(() => { if (handle && typeof handle.stop === 'function') handle.stop(); });
        return handle;
    }
    function run(fn) {
        if (stopped) return Promise.resolve(false);
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        calls.add(pending);
        const done = () => { calls.delete(pending); finish(); };
        try {
            return Promise.resolve(fn()).then(value => { done(); return value; }, error => { done(); throw error; });
        } catch (error) { done(); return Promise.reject(error); }
    }
    function api(raw) {
        if (!raw) return raw;
        if (proxies.has(raw)) return proxies.get(raw);
        const proxy = new Proxy(raw, {
            get(target, key) {
                const value = target[key];
                if (typeof value !== 'function') return value;
                return function (...args) {
                    if (stopped) throw new Error('旧桥已退出，数据库调用已取消');
                    // 在调用宿主前登记，覆盖宿主同步回调触发扩展加载的重入情况。
                    let finish;
                    const pending = new Promise(resolve => { finish = resolve; });
                    calls.add(pending);
                    const done = () => { calls.delete(pending); finish(); };
                    try {
                        const result = value.apply(target, args);
                        if (result && typeof result.then === 'function') return Promise.resolve(result).then(
                            answer => { done(); return answer; }, error => { done(); throw error; });
                        done();
                        return result;
                    } catch (error) { done(); throw error; }
                };
            },
        });
        proxies.set(raw, proxy);
        return proxy;
    }
    function stop() {
        if (ready) return ready;
        stopped = true;
        notifyStop(false);
        for (const id of Array.from(timers.keys())) clear(id);
        for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) {} }
        ready = Promise.all(Array.from(calls)).then(() => undefined);
        return ready;
    }
    return {
        get stopped() { return stopped; }, stop, cleanup, guard, on, eventOn, api, run,
        setTimeout: (fn, delay) => timer(false, fn, delay),
        setInterval: (fn, delay) => timer(true, fn, delay),
        clearTimeout: clear, clearInterval: clear,
        sleep(delay) { return Promise.race([stoppedPromise, new Promise(resolve => timer(false, () => resolve(true), delay))]); },
    };
}

module.exports = createBridgeLifecycle;
