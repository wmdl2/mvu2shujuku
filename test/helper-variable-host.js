'use strict';

// Minimal native storage for extension VMs. Real TavernHelper supplies these
// functions and Lodash before author scripts run; do not test their absence as
// an otherwise normal helper installation.
module.exports = function provideHelperVariables(win) {
    const lodash = require('../src/vendor/schema-engine-libs').lodash;
    win._ ||= lodash;
    for (const name of ['cloneDeep', 'isEqual', 'mergeWith', 'unset']) win._[name] ||= lodash[name];
    const context = () => win.SillyTavern?.getContext?.() || {};
    win.getVariables ||= function (opts = { type: 'chat' }) {
        const ctx = context();
        if (opts.type !== 'message') return lodash.cloneDeep(ctx.chat_metadata?.variables || {});
        const chat = ctx.chat || [], message = Number.isInteger(opts.message_id)
            ? chat.at(opts.message_id) : chat.filter(m => !m.is_system).at(-1);
        return lodash.cloneDeep(message?.variables?.[message.swipe_id || 0] || {});
    };
    win.replaceVariables ||= function (value, opts = { type: 'chat' }) {
        const ctx = context();
        if (opts.type !== 'message') { (ctx.chat_metadata ||= {}).variables = value; return; }
        const message = (ctx.chat || []).at(Number.isInteger(opts.message_id) ? opts.message_id : -1);
        if (!message) throw new Error('fixture message missing');
        message.variables ||= []; message.variables[message.swipe_id || 0] = value;
    };
};
