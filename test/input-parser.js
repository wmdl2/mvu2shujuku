'use strict';

const vm = require('vm');
const { test } = require('./runner');
const { assert, fs, path } = require('./helpers');
const createInputParser = require('../src/input-parser');

function browserParser() {
    const source = fs.readFileSync(path.join(__dirname, '../src/input-parser.js'), 'utf8');
    const context = {
        Uint8Array, Uint32Array, DataView, ArrayBuffer, TextEncoder, TextDecoder, JSON,
        atob, btoa, console,
    };
    vm.runInNewContext(source + '\nthis.create = createInputParser;', context);
    return context.create({ clone: v => JSON.parse(JSON.stringify(v)) });
}

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return (c ^ 0xffffffff) >>> 0;
}
function textChunk(keyword, text) {
    const payload = new TextEncoder().encode(keyword + '\0' + btoa(new TextEncoder().encode(text).reduce((s, b) => s + String.fromCharCode(b), '')));
    const out = new Uint8Array(12 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, payload.length);
    out.set(new TextEncoder().encode('tEXt'), 4);
    out.set(payload, 8);
    dv.setUint32(8 + payload.length, crc32(out.slice(4, 8 + payload.length)));
    return out;
}
function withCcv3(bytes, card) {
    const parser = createInputParser();
    const chunks = parser.parseCardPng(bytes).chunks;
    const iend = chunks.find(c => c.type === 'IEND');
    const extra = textChunk('ccv3', JSON.stringify(card));
    const out = new Uint8Array(bytes.length + extra.length);
    out.set(bytes.slice(0, iend.offset), 0);
    out.set(extra, iend.offset);
    out.set(bytes.slice(iend.offset), iend.offset + extra.length);
    return out;
}

test('角色卡输入解析：无 Buffer 环境支持 UTF8 JSON/PNG 往返', () => {
    const parser = browserParser();
    const card = { spec: 'chara_card_v3', data: { name: '无 Buffer 测试', first_mes: '你好，世界' } };
    const jsonBytes = new TextEncoder().encode('\uFEFF  ' + JSON.stringify(card));
    assert.deepStrictEqual(parser.parseCard(jsonBytes), card);
    const png = parser.writeCardPng(parser.miniPngBuffer(), card);
    assert.deepStrictEqual(parser.parseCardPng(png).card, card);
    assert.deepStrictEqual(parser.parseCard(png), card);
});
test('角色卡输入解析：大块 Unicode 在浏览器与 Node 编码一致并保留头像', () => {
    const browser = browserParser(), node = createInputParser();
    const card = { name: '分块文本', description: '中文😀\u0080\u009f'.repeat(6000) };
    const base = node.miniPngBuffer();
    const png = browser.writeCardPng(new Uint8Array(base), card);
    assert.deepStrictEqual(browser.parseCardPng(png).card, card);
    assert.deepStrictEqual(node.parseCardPng(png).card, card);
    assert.strictEqual(browser.btoaSafe(card.description), node.btoaSafe(card.description));
    assert.strictEqual(browser.atobSafe(node.btoaSafe(card.description)), card.description);
    const originalImage = node.parseCardPng(node.writeCardPng(base, {})).chunks.find(c => c.type === 'IDAT').data;
    const image = browser.parseCardPng(png).chunks.find(c => c.type === 'IDAT').data;
    assert.deepStrictEqual(Buffer.from(image), Buffer.from(originalImage));
});

test('角色卡输入解析：ccv3 优先于 chara', () => {
    const parser = createInputParser();
    const oldCard = { spec: 'chara_card_v2', data: { name: '旧卡' } };
    const newCard = { spec: 'chara_card_v3', data: { name: '新卡' } };
    const png = parser.writeCardPng(parser.miniPngBuffer(), oldCard);
    assert.deepStrictEqual(parser.parseCardPng(withCcv3(png, newCard)).card, newCard);
});
test('角色卡输入解析：保存头像只移除原卡载荷，保留像素', () => {
    const node = createInputParser(), browser = browserParser();
    const original = node.writeCardPng(node.miniPngBuffer(), { name: '原卡', description: '正文'.repeat(20000) });
    const twoCards = withCcv3(original, { name: 'v3卡' });
    const extra = textChunk('author_note', '保留的其他 PNG 信息');
    const both = Buffer.concat([twoCards.slice(0, -12), extra, twoCards.slice(-12)]);
    const avatar = browser.extractPngAvatar(new Uint8Array(both));
    const base = node.miniPngBuffer();
    const expected = Buffer.concat([base.slice(0, -12), extra, base.slice(-12)]);
    assert.deepStrictEqual(Buffer.from(avatar), expected);
    assert.deepStrictEqual(Buffer.from(node.extractPngAvatar(both)), Buffer.from(avatar));
    assert.ok(avatar.length < both.length / 100);
    const reimported = browser.writeCardPng(avatar, { name: '新卡' });
    assert.deepStrictEqual(browser.parseCardPng(reimported).card, { name: '新卡' });
});

test('角色卡输入解析：工厂实例彼此隔离', () => {
    const a = createInputParser({ clone: v => JSON.parse(JSON.stringify(v)) });
    const b = createInputParser({ clone: v => JSON.parse(JSON.stringify(v)) });
    assert.notStrictEqual(a, b);
    const card = { spec: 'chara_card_v2', data: { name: '隔离' } };
    const parsed = a.parseCard(card);
    parsed.data.name = '修改';
    assert.strictEqual(card.data.name, '隔离');
    assert.strictEqual(b.parseCard(card).data.name, '隔离');
});
