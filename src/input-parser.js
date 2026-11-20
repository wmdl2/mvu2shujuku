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
        const parts = [];
        // TextDecoder('latin1') 实际使用 Windows-1252；分块保留逐字节语义。
        for (let i = 0; i < bytes.length; i += 8192)
            parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
        return parts.join('');
    }
    function utf8ToString(bytes) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.toString('utf8');
        return new TextDecoder('utf-8').decode(bytes);
    }
    function readPngChunks(buffer, copyData = false) {
        if (!buffer || buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) throw new Error('不是有效的 PNG 文件');
        const chunks = [];
        let off = 8;
        const dv = buffer instanceof DataView ? buffer : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        while (off + 12 <= buffer.length) {
            const len = dv.getUint32(off);
            const type = String.fromCharCode(buffer[off + 4], buffer[off + 5], buffer[off + 6], buffer[off + 7]);
            const data = copyData ? buffer.slice(off + 8, off + 8 + len) : buffer.subarray(off + 8, off + 8 + len);
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
        if (typeof Uint8Array.fromBase64 === 'function') {
            try { return new TextDecoder('utf-8').decode(Uint8Array.fromBase64(b64)); }
            catch (_) { /* 无效数据交给 atob，保留原错误。 */ }
        }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    }
    function btoaSafe(str) {
        if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
        const bytes = new TextEncoder().encode(str);
        if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
        return btoa(latin1ToString(bytes));
    }
    function toBase64(str) {
        return typeof Buffer !== 'undefined' ? Buffer.from(String(str), 'utf8').toString('base64') : btoaSafe(str);
    }
    function textKeyword(chunk) {
        if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt') return '';
        const nul = chunk.data.indexOf(0);
        return nul < 0 ? '' : latin1ToString(chunk.data.subarray(0, nul));
    }
    function decodeCardChunks(chunks) {
        let chara, ccv3;
        for (const chunk of chunks) {
            if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt') continue;
            const nul = chunk.data.indexOf(0);
            if (nul === -1) continue;
            const keyword = latin1ToString(chunk.data.subarray(0, nul));
            if (chunk.type === 'iTXt' && chunk.data[nul + 1] !== 0) {
                throw new Error(keyword + ' iTXt 使用了压缩，暂不支持');
            }
            const key = keyword.toLowerCase();
            if (key === 'ccv3' && !ccv3) ccv3 = { chunk, start: nul + 1 };
            if (key === 'chara' && !chara) chara = { chunk, start: nul + 1 };
        }
        const selected = ccv3 || chara;
        if (!selected) throw new Error('PNG 中未找到 chara/ccv3 文本块');
        const { chunk, start } = selected;
        let payloadStart = start;
        if (chunk.type === 'iTXt') {
            payloadStart += 2; // 压缩标志与方法之后是语言标记和翻译后的关键字。
            for (let field = 0; field < 2; field++) {
                while (payloadStart < chunk.data.length && chunk.data[payloadStart] !== 0) payloadStart++;
                payloadStart++;
            }
        }
        const payload = chunk.data.subarray(payloadStart);
        const text = chunk.type === 'iTXt' ? utf8ToString(payload) : latin1ToString(payload);
        return { card: JSON.parse(atobSafe(text)), text };
    }
    function parseCardPng(buffer) {
        const chunks = readPngChunks(buffer, true);
        const { card, text } = decodeCardChunks(chunks);
        return { card, chunks, text };
    }
    function concatBytes(...arrays) {
        const total = arrays.reduce((n, a) => n + a.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }
    function pngSource(bytes, chunks = readPngChunks(bytes)) {
        const parts = [bytes.subarray(0, 8)];
        let size = 8, insertAt;
        for (const chunk of chunks) {
            const key = textKeyword(chunk).toLowerCase();
            if (insertAt === undefined && (key === 'chara' || chunk.type === 'IEND')) insertAt = size;
            if (key === 'chara' || key === 'ccv3') continue;
            const end = chunk.offset + 12 + chunk.data.length;
            parts.push(bytes.subarray(chunk.offset, end));
            size += end - chunk.offset;
        }
        return {
            avatar: concatBytes(...parts),
            insertAt: insertAt ?? size,
            textType: chunks.some(c => c.type === 'tEXt') ? 'tEXt' : 'iTXt',
        };
    }
    function extractPngAvatar(input) {
        const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
        return pngSource(bytes).avatar;
    }

    function writeCardPng(originalBuffer, card) {
        return writeCardPngSource(pngSource(originalBuffer), card);
    }
    function writeCardPngSource({ avatar, insertAt, textType }, card) {
        const charaText = btoaSafe(JSON.stringify(card));
        const prefixLength = textType === 'tEXt' ? 6 : 10;
        const payloadLength = prefixLength + charaText.length;
        const end = insertAt + 8 + payloadLength;
        const result = new Uint8Array(avatar.length + 12 + payloadLength);
        result.set(avatar.subarray(0, insertAt));
        result.set(avatar.subarray(insertAt), end + 4);
        const view = new DataView(result.buffer);
        view.setUint32(insertAt, payloadLength);
        const encoder = new TextEncoder();
        result.set(encoder.encode(textType + 'chara'), insertAt + 4);
        const textOffset = insertAt + 8 + prefixLength;
        if (encoder.encodeInto) encoder.encodeInto(charaText, result.subarray(textOffset, end));
        else result.set(encoder.encode(charaText), textOffset);
        view.setUint32(end, crc32(result.subarray(insertAt + 4, end)));
        return result;
    }
    function readCardInput(input, retainPng = false) {
        if (input && typeof input === 'object' && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
            if (input.spec || input.data || input.name) return { card: deepClone(input) };
            throw new Error('无法识别的角色卡对象');
        }
        if (typeof input === 'string') {
            const t = input.trim();
            if (t.startsWith('{')) return { card: JSON.parse(t) };
            throw new Error('JSON 字符串无法解析为角色卡');
        }
        const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength || input.length);
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
            const chunks = readPngChunks(buf);
            const { card } = decodeCardChunks(chunks);
            return { card, png: retainPng ? pngSource(buf, chunks) : undefined };
        }
        const json = utf8ToString(buf).replace(/^\uFEFF/, '').trim();
        if (json.startsWith('{')) return readCardInput(JSON.parse(json));
        throw new Error('输入既不是 JSON 角色卡也不是 PNG 角色卡');
    }
    const parseCard = input => readCardInput(input).card;
    return { miniPngBuffer, parseCardPng, writeCardPng, writeCardPngSource, extractPngAvatar, parseCard, readCardInput, toBase64, btoaSafe, atobSafe };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createInputParser;
