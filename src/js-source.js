'use strict';

// Token spans preserve source text; literals/comments never contribute structural brackets.
function createJsSource(deps = {}) {
    const acorn = deps.acorn
        || (typeof globalThis !== 'undefined' && globalThis.__MVU2SHUJUKU_SCHEMA_ENGINE_LIBS__?.acorn)
        || (typeof require === 'function' ? require('./vendor/schema-engine-libs').acorn : null);
    function tokens(source) {
        if (!acorn) throw new Error('Acorn tokenizer missing');
        const s = String(source || ''), out = [], lexer = acorn.tokenizer(s, { ecmaVersion: 'latest', allowHashBang: true });
        let templateStart = 0, templateDepth = 0, previous = '';
        for (;;) {
            const t = lexer.getToken(), label = t.type.label;
            if (label === 'eof') break;
            if (label === '`') {
                if (previous === 'template') {
                    if (--templateDepth === 0) out.push({ value: s.slice(templateStart, t.end), start: templateStart, end: t.end, kind: 'literal' });
                } else {
                    if (templateDepth++ === 0) templateStart = t.start;
                }
            } else if (!templateDepth) {
                const kind = ['string', 'num', 'regexp'].includes(label) ? 'literal'
                    : label === 'name' || t.type.keyword ? 'identifier' : 'punct';
                out.push({ value: s.slice(t.start, t.end), start: t.start, end: t.end, kind });
            }
            previous = label;
        }
        return out;
    }
    function balancedEnd(source, open) {
        const list = tokens(source), first = list.findIndex(t => t.start === open);
        const pairs = { '(': ')', '[': ']', '{': '}' }, stack = [];
        if (first < 0 || !pairs[list[first].value]) return -1;
        for (let j = first; j < list.length; j++) {
            const t = list[j]; if (t.kind === 'literal') continue;
            if (pairs[t.value]) stack.push(pairs[t.value]);
            else if (t.value === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return t.start; }
        }
        return -1;
    }
    function split(source, separator = ',') {
        const s = String(source || ''), parts = [], stack = [], pairs = { '(': ')', '[': ']', '{': '}' };
        let start = 0;
        for (const t of tokens(s)) {
            if (t.kind === 'literal') continue;
            if (pairs[t.value]) stack.push(pairs[t.value]);
            else if (t.value === stack[stack.length - 1]) stack.pop();
            else if (!stack.length && t.value === separator) { parts.push(s.slice(start, t.start).trim()); start = t.end; }
        }
        parts.push(s.slice(start).trim()); return parts;
    }
    function substitute(source, values) {
        let out = '', start = 0;
        for (const t of tokens(source)) {
            if (t.kind !== 'identifier' || !Object.prototype.hasOwnProperty.call(values, t.value)) continue;
            out += source.slice(start, t.start) + '(' + values[t.value] + ')'; start = t.end;
        }
        return out + source.slice(start);
    }
    return { tokens, balancedEnd, split, substitute };
}
module.exports = createJsSource;
