'use strict';

// Token spans preserve source text; literals/comments never contribute structural brackets.
function createJsSource() {
    const idStart = ch => !!ch && /[A-Za-z_$\u0080-\uffff]/.test(ch);
    const idPart = ch => !!ch && /[\w$\u0080-\uffff]/.test(ch);
    function tokens(source) {
        const s = String(source || ''), out = [];
        let i = 0;
        function quoted(quote) {
            i++;
            while (i < s.length) { const c = s[i++]; if (c === '\\') i++; else if (c === quote) break; }
        }
        function template() {
            i++;
            while (i < s.length) {
                const c = s[i++];
                if (c === '\\') i++;
                else if (c === '`') break;
                else if (c === '$' && s[i] === '{') { i++; scan(true, []); }
            }
        }
        function scan(inTemplate, output) {
            let expression = true, previous = '', depth = 0;
            const parens = [], braces = [];
            while (i < s.length) {
                const start = i, c = s[i], next = s[i + 1];
                if (/\s/.test(c)) { i++; continue; }
                if (c === '/' && next === '/') { i += 2; while (i < s.length && s[i] !== '\n') i++; continue; }
                if (c === '/' && next === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i = Math.min(s.length, i + 2); continue; }
                let kind = 'punct';
                if (c === '"' || c === "'") { quoted(c); kind = 'literal'; }
                else if (c === '`') { template(); kind = 'literal'; }
                else if (c === '/' && expression) {
                    i++; let inClass = false;
                    while (i < s.length) {
                        const r = s[i++];
                        if (r === '\\') i++;
                        else if (r === '[') inClass = true;
                        else if (r === ']') inClass = false;
                        else if (r === '/' && !inClass) break;
                        else if (r === '\n' || r === '\r') break;
                    }
                    while (idPart(s[i])) i++;
                    kind = 'literal';
                } else if (idStart(c)) { i++; while (idPart(s[i])) i++; kind = 'identifier'; }
                else if (/\d/.test(c)) { i++; while (i < s.length && /[\w.]/.test(s[i])) i++; kind = 'literal'; }
                else {
                    const multi = ['===', '!==', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '**'].find(v => s.startsWith(v, i));
                    i += multi ? multi.length : 1;
                }
                const value = s.slice(start, i);
                if (inTemplate && value === '}' && depth === 0) return;
                output.push({ value, start, end: i, kind });
                if (value === '(') parens.push(/^(if|while|for|with|switch|catch)$/.test(previous));
                if (value === '{') { depth++; braces.push(previous === ')' || previous === '=>' || /^(else|try|finally|do)$/.test(previous)); }
                if (value === '}') depth--;
                if (kind === 'literal') expression = false;
                else if (kind === 'identifier') expression = /^(return|throw|case|delete|void|typeof|new|in|of|yield|await|else|do)$/.test(value);
                else if (value === ')') expression = !!parens.pop();
                else if (value === '}') expression = !!braces.pop();
                else expression = !['.', '?.', ']', '++', '--'].includes(value);
                previous = value;
            }
        }
        scan(false, out);
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
