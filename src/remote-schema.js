'use strict';

// Fetching is confined to conversion. Runtime adapters reuse the author's module.
function createRemoteSchema({ createJsSource }) {
    const js = createJsSource();
    const cache = new Map();
    const clone = value => JSON.parse(JSON.stringify(value));
    function imports(source) {
        const tokens = js.tokens(String(source || '')), out = [];
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].value !== 'import') continue;
            const offset = tokens[i + 1]?.value === '(' ? 2 : 1;
            const token = tokens[i + offset];
            if (!token || token.kind !== 'literal' || !/^['"]https?:\/\//.test(token.value)) continue;
            const url = token.value.slice(1, -1);
            out.push({ url, start: token.start, end: token.end });
        }
        return out;
    }
    function classify(url) {
        const parsed = new URL(url), match = parsed.pathname.match(/^\/gh\/([^/]+)\/([^/@]+)(?:@([^/]+))?\/(.+)$/);
        if (!match || !/(?:^|\.)jsdelivr\.net$/.test(parsed.hostname)) return { kind: 'other', fixed: false };
        const [, owner, repo, ref = '', file] = match;
        const kind = /^[a-f\d]{40}$/i.test(ref) ? 'commit' : /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(ref) ? 'version' : 'floating';
        return { kind, fixed: kind !== 'floating', owner, repo, ref, file };
    }
    function candidates(card) {
        const data = card.data || card, scripts = data.extensions?.tavern_helper?.scripts || [];
        return scripts.flatMap((script, index) => {
            if (script.enabled === false) return [];
            const source = String(script.content || script.code || script.script || '');
            if (!/schema|zod|变量结构/i.test(String(script.name || '') + ' ' + source)) return [];
            return imports(source).filter(item => /schema|zod|变量结构/i.test(decodeURI(item.url)))
                .filter(item => !/mvu_zod\.js(?:[?#]|$)/.test(item.url))
                .map(item => ({ ...item, index, name: script.name || '远程 Schema' }));
        });
    }
    async function digest(source) {
        const bytes = new TextEncoder().encode(source);
        const crypto = globalThis.crypto || (typeof require === 'function' && require('crypto').webcrypto);
        if (crypto?.subtle) {
            const sum = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(sum), byte => byte.toString(16).padStart(2, '0')).join('');
        }
        // LAN HTTP and some embedded browsers do not expose SubtleCrypto.
        const constants = [
            0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
            0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
            0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
            0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
            0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
        ];
        const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
        const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
        data.set(bytes); data[bytes.length] = 128;
        const view = new DataView(data.buffer), words = new Int32Array(64);
        view.setUint32(data.length - 8, Math.floor(bytes.length * 8 / 4294967296));
        view.setUint32(data.length - 4, bytes.length * 8);
        const rotate = (n, bits) => n >>> bits | n << (32 - bits);
        for (let offset = 0; offset < data.length; offset += 64) {
            for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4);
            for (let i = 16; i < 64; i++) {
                const a = words[i - 15], b = words[i - 2];
                words[i] = words[i - 16] + (rotate(a,7) ^ rotate(a,18) ^ a >>> 3) + words[i - 7] + (rotate(b,17) ^ rotate(b,19) ^ b >>> 10);
            }
            let [a,b,c,d,e,f,g,h] = state;
            for (let i = 0; i < 64; i++) {
                const first = h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i];
                const second = (rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c));
                h=g;g=f;f=e;e=d+first|0;d=c;c=b;b=a;a=first+second|0;
            }
            [a,b,c,d,e,f,g,h].forEach((n, i) => { state[i] = state[i] + n | 0; });
        }
        return state.map(n => (n >>> 0).toString(16).padStart(8,'0')).join('');
    }
    async function fetchText(url, fetcher, limit = 512 * 1024) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetcher(url, { signal: controller.signal });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            if (Number(response.headers?.get('content-length')) > limit) throw new Error('脚本超过大小上限');
            const source = await response.text();
            if (new TextEncoder().encode(source).length > limit) throw new Error('脚本超过大小上限');
            return source;
        } finally { clearTimeout(timer); }
    }
    async function resolve(card, options = {}) {
        const snapshots = [], fetcher = options.fetch || globalThis.fetch;
        for (const candidate of candidates(card)) {
            let snapshot = options.remoteSchemaSources?.find(item => item.url === candidate.url);
            if (!snapshot) {
                let pending = cache.get(candidate.url);
                if (pending && (options.refreshRemoteSchemas || Date.now() - pending.createdAt > 300000)) {
                    cache.delete(candidate.url); pending = null;
                }
                if (!pending) {
                    pending = (async () => {
                        if (typeof fetcher !== 'function') throw new Error('没有可用的下载接口');
                        const source = await fetchText(candidate.url, fetcher);
                        return { url: candidate.url, source, sha256: await digest(source), version: classify(candidate.url) };
                    })();
                    pending.createdAt = Date.now();
                    if (cache.size >= 32) cache.delete(cache.keys().next().value);
                    cache.set(candidate.url, pending);
                    pending.catch(() => cache.delete(candidate.url));
                }
                try { snapshot = await pending; }
                catch (error) { const failure = new Error(`远程 Schema「${candidate.name}」下载失败：${error.message}。可提供同一链接的本地源码后重试。`); failure.code = 'REMOTE_SCHEMA_FETCH_FAILED'; throw failure; }
            }
            if (typeof snapshot.source !== 'string') throw new Error('远程 Schema 快照缺少源码');
            snapshot = { ...snapshot, index: candidate.index, sha256: await digest(snapshot.source), version: classify(candidate.url), runtimeUrl: candidate.url };
            // Pin only after comparing the CDN bytes; a floating CDN may lag GitHub HEAD.
            if (!options.preserveRemoteSchemaUrls && snapshot.version.kind !== 'commit' && snapshot.version.owner && typeof fetcher === 'function') {
                try {
                    const v = snapshot.version, ref = v.ref || 'HEAD';
                    const info = JSON.parse(await fetchText(`https://api.github.com/repos/${v.owner}/${v.repo}/commits/${encodeURIComponent(ref)}`, fetcher));
                    if (!/^[a-f\d]{40}$/i.test(info.sha || '')) throw new Error('没有取得 commit');
                    const pinned = new URL(snapshot.url); pinned.pathname = `/gh/${v.owner}/${v.repo}@${info.sha}/${v.file}`;
                    const fixedSource = await fetchText(pinned.href, fetcher);
                    if (fixedSource !== snapshot.source) throw new Error('CDN 内容与仓库提交不同');
                    snapshot.runtimeUrl = pinned.href;
                    snapshot.commit = info.sha;
                } catch (error) { snapshot.pinWarning = '未固定远程版本：' + error.message + '；运行时保留原链接。'; }
            }
            snapshots.push(snapshot);
        }
        return snapshots;
    }
    function analysisSource(source) {
        // Known webpack module export shape; inspect its lexical scope, never execute it.
        const call = source.match(/(?:\(\s*0\s*,\s*\w+\.registerMvuSchema\s*\)|\w+\.registerMvuSchema)\s*\(\s*(\w+)\.(\w+)/);
        if (!call) return source;
        const binding = source.match(new RegExp('\\b' + call[1] + '\\s*=\\s*(\\w+)\\((\\d+)\\)'));
        if (!binding) return source;
        const factory = source.match(new RegExp('\\b' + binding[2] + '\\s*\\([^)]*\\)\\s*\\{'));
        if (!factory) return source;
        const open = source.indexOf('{', factory.index), close = js.balancedEnd(source, open);
        const body = source.slice(open + 1, close);
        const exported = body.match(new RegExp('\\[\\s*[\'\"]' + call[2] + '[\'\"]\\s*,\\s*0\\s*,\\s*(\\w+)\\s*\\]'));
        return exported ? body + '\nregisterMvuSchema(' + exported[1] + ');' : source;
    }
    function supported(source) {
        return /mvu_zod\.js/.test(source) && /registerMvuSchema/.test(source);
    }
    function key(snapshot) {
        let hash = 2166136261;
        for (let i = 0; i < snapshot.source.length; i++) hash = Math.imul(hash ^ snapshot.source.charCodeAt(i), 16777619);
        return 'remote-schema-' + (hash >>> 0).toString(16) + '-' + snapshot.index;
    }
    function runtimeAdapter(snapshot, content, localize = false) {
        const schemaKey = key(snapshot);
        const prelude = `await waitGlobalInitialized('Mvu');
const __remoteRegister = window.registerVariableSchema;
window.registerVariableSchema = function(schema, options) {
    const result = typeof __remoteRegister === 'function' ? __remoteRegister.apply(this, arguments) : undefined;
    if (options && options.type === 'message' && schema && schema.shape && schema.shape.stat_data) {
        const api = window.parent && window.parent.Mvu || window.Mvu;
        if (!api || !api.__mvu2shujukuFake || !api.registerSchema(schema.shape.stat_data, ${JSON.stringify(schemaKey)})) throw new Error('远程 Schema 登记未接入当前数据桥');
    }
    return result;
};\n`;
        if (localize) {
            if (/\bimport\s*\.\s*meta\b/.test(snapshot.source)) throw new Error('含 import.meta 的远程模块不能直接本地化');
            // Resolve relative static/dynamic import specifiers against the original module.
            let body = snapshot.source;
            const tokens = js.tokens(body), edits = [];
            tokens.forEach((token, i) => {
                if (token.kind === 'literal' && /^['"]\.\.?\//.test(token.value) && ['from', 'import', '('].includes(tokens[i - 1]?.value))
                    edits.push({ ...token, value: JSON.stringify(new URL(token.value.slice(1, -1), snapshot.runtimeUrl).href) });
            });
            for (const edit of edits.reverse()) body = body.slice(0, edit.start) + edit.value + body.slice(edit.end);
            return { content: prelude + body, key: schemaKey };
        }
        const found = imports(content).filter(item => item.url === snapshot.url);
        if (found.length !== 1 || !/^\s*(?:await\s+)?import\s*(?:\(\s*)?['"][^'"]+['"]\s*\)?\s*;?\s*$/.test(content))
            throw new Error('远程 Schema 启动脚本包含其他逻辑，尚不能自动接入');
        return { content: prelude + 'await import(' + JSON.stringify(snapshot.runtimeUrl) + ');', key: schemaKey };
    }
    return { candidates, classify, resolve, analysisSource, supported, key, runtimeAdapter };
}
module.exports = createRemoteSchema;
