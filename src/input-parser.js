'use strict';

// JSON/PNG 角色卡输入输出的自包含工厂。运行时依赖仅由调用方注入。
function createInputParser({ clone } = {}) {
    const deepClone = typeof clone === 'function' ? clone : (v => JSON.parse(JSON.stringify(v)));
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(buf) {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    function latin1ToString(bytes) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.toString('latin1');
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }
    function utf8ToString(bytes) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.toString('utf8');
        return new TextDecoder('utf-8').decode(bytes);
    }
    function readPngChunks(buffer) {
        if (!buffer || buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) throw new Error('不是有效的 PNG 文件');
        const chunks = [];
        let off = 8;
        const dv = buffer instanceof DataView ? buffer : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        while (off + 12 <= buffer.length) {
            const len = dv.getUint32(off);
            const type = String.fromCharCode(buffer[off + 4], buffer[off + 5], buffer[off + 6], buffer[off + 7]);
            const data = buffer.slice(off + 8, off + 8 + len);
            const crc = dv.getUint32(off + 8 + len);
            chunks.push({ type, data, crc, offset: off });
            off += 12 + len;
            if (type === 'IEND') break;
        }
        return chunks;
    }
    const MINI_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    function miniPngBuffer() {
        if (typeof Buffer !== 'undefined') return Buffer.from(MINI_PNG_B64, 'base64');
        const bin = atob(MINI_PNG_B64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }
    function atobSafe(b64) {
        if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    }
    function btoaSafe(str) {
        if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        return btoa(bin);
    }
    function toBase64(str) {
        return typeof Buffer !== 'undefined' ? Buffer.from(String(str), 'utf8').toString('base64') : btoaSafe(str);
    }
    function parseCardPng(buffer) {
        const chunks = readPngChunks(buffer);
        const decodeTextChunk = (chunk) => {
            const nul = chunk.data.indexOf(0);
            if (nul === -1) return null;
            const keyword = latin1ToString(chunk.data.slice(0, nul));
            const payload = chunk.data.slice(nul + 1);
            let text;
            if (chunk.type === 'iTXt') {
                if (payload[0] !== 0) throw new Error(keyword + ' iTXt 使用了压缩，暂不支持');
                let p = 2;
                while (p < payload.length && payload[p] !== 0) p++;
                p++;
                while (p < payload.length && payload[p] !== 0) p++;
                p++;
                text = utf8ToString(payload.slice(p));
            } else text = latin1ToString(payload);
            return { keyword: keyword.toLowerCase(), text };
        };
        let charaText = null, ccv3Text = null;
        for (const chunk of chunks) {
            if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt') continue;
            const decoded = decodeTextChunk(chunk);
            if (!decoded) continue;
            if (decoded.keyword === 'ccv3' && ccv3Text === null) ccv3Text = decoded.text;
            if (decoded.keyword === 'chara' && charaText === null) charaText = decoded.text;
        }
        const text = ccv3Text !== null ? ccv3Text : charaText;
        if (text === null) throw new Error('PNG 中未找到 chara/ccv3 文本块');
        return { card: JSON.parse(atobSafe(text)), chunks, text };
    }
    function concatBytes(...arrays) {
        const total = arrays.reduce((n, a) => n + a.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }
    function buildChunk(type, data) {
        const header = new Uint8Array(8);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, data.length);
        for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);
        const crc = new Uint8Array(4);
        new DataView(crc.buffer).setUint32(0, crc32(concatBytes(header.slice(4), data)));
        return concatBytes(header, data, crc);
    }
    function writeCardPng(originalBuffer, card) {
        const chunks = readPngChunks(originalBuffer);
        const charaText = btoaSafe(JSON.stringify(card));
        const type = chunks.some(c => c.type === 'tEXt') ? 'tEXt' : 'iTXt';
        const hasBuffer = typeof Buffer !== 'undefined';
        const keyword = hasBuffer ? Buffer.from('chara', 'latin1') : new TextEncoder().encode('chara');
        const payload = type === 'tEXt'
            ? concatBytes(keyword, new Uint8Array([0]), hasBuffer ? Buffer.from(charaText, 'latin1') : new TextEncoder().encode(charaText))
            : concatBytes(keyword, new Uint8Array([0, 0, 0, 0, 0]), new TextEncoder().encode(charaText));
        const chunkData = buildChunk(type, payload);
        const textKeyword = (chunk) => {
            if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt') return '';
            const nul = chunk.data.indexOf(0);
            if (nul === -1) return '';
            return latin1ToString(chunk.data.slice(0, nul)).toLowerCase();
        };
        const out = [originalBuffer.slice(0, 8)];
        let replaced = false;
        for (const chunk of chunks) {
            const kw = textKeyword(chunk);
            if (kw === 'ccv3' || (kw === 'chara' && replaced)) continue;
            if (chunk.type === 'IEND' && !replaced) { out.push(chunkData); replaced = true; }
            if (!replaced && kw === 'chara') { out.push(chunkData); replaced = true; continue; }
            out.push(originalBuffer.slice(chunk.offset, chunk.offset + 12 + chunk.data.length));
        }
        if (!replaced) out.push(chunkData);
        return concatBytes(...out);
    }
    function parseCard(input) {
        if (input && typeof input === 'object' && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
            if (input.spec || input.data || input.name) return deepClone(input);
            throw new Error('无法识别的角色卡对象');
        }
        if (typeof input === 'string') {
            const t = input.trim();
            if (t.startsWith('{')) return JSON.parse(t);
            throw new Error('JSON 字符串无法解析为角色卡');
        }
        const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength || input.length);
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return parseCardPng(buf).card;
        const json = utf8ToString(buf).replace(/^\uFEFF/, '').trim();
        if (json.startsWith('{')) return parseCard(JSON.parse(json));
        throw new Error('输入既不是 JSON 角色卡也不是 PNG 角色卡');
    }
    return { miniPngBuffer, parseCardPng, writeCardPng, parseCard, toBase64, btoaSafe, atobSafe };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createInputParser;
