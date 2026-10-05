'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const vm = require('vm');
const createCardApi = require('../src/card-api');
const createJsSource = require('../src/js-source');
const { nativeRuntime } = require('./runtime-native');
const clone = value => JSON.parse(JSON.stringify(value));

test('转换接入：正则、模板、除法和参数辅助函数不吞登记结构', () => {
    const source = String.raw`
        const normalize = v => v.replace(/[（(]\s*tag\s*[)）]/gu, '');
        const hint = \`outer \${\`inner\${/[(]/.test('(')}\`}\`;
        const ratio = 12 / 3;
        const numeric = (low = 0, high = 10) => z.number().min(low).max(high);
        const rows = schema => z.record(z.string(), schema).prefault({});
        const Base = z.object({ count: numeric(1, 8) });
        const Schema = z.object({ enabled: z.boolean().default(false), rows: rows(z.object({ child: rows(Base.describe('nested')) })) });
        registerMvuSchema(Schema);
    `.replace(/\\`/g, '`').replace(/\\\$/g, '$');
    const parsed = core.parseRegisteredZodSchema(source);
    assert.ok(parsed); assert.strictEqual(parsed.root.fields.enabled.defaultValue, false);
    const count = parsed.root.fields.rows.value.fields.child.value.fields.count;
    assert.strictEqual(count.min, 1); assert.strictEqual(count.max, 8);
    const lexical = vm.runInNewContext('(' + createJsSource.toString() + ')')();
    assert.deepStrictEqual(clone(lexical.split("/[,)]/, `x${')'}`, 12 / 3")), ["/[,)]/", "`x${')'}`", '12 / 3']);
});

test('转换接入：声明的缺失根组和未知字段有物理存储，分叉引擎移除', async () => {
    const source = require('./synthetic-card')();
    source.data.extensions.tavern_helper.scripts.push({ name: 'reference', enabled: false,
        content: 'const Schema=z.object({ enabled:z.boolean(), optional:z.object({value:z.number()}).optional(), unknown:z.union([z.string(),z.object({})]) });registerMvuSchema(Schema);' });
    source.data.extensions.tavern_helper.scripts.push({ name: 'fork engine', content: "import 'https://testingcf.jsdelivr.net/gh/NLKASHEI/MagVarUpdate@e046515/artifact/bundle.js';" });
    const r = core.convert(source), layout = JSON.parse(r.card.data.extensions.mvu2shujuku.layout);
    assert.ok(!r.card.data.extensions.tavern_helper.scripts.some(s => s.name === 'fork engine'));
    const tables = clone(r.template), previous = core.statDataFromTables(layout, tables).stat_data;
    assert.ok(!Object.hasOwn(previous, 'enabled')); assert.ok(!Object.hasOwn(previous, 'unknown'));
    const next = { ...previous, enabled: false, optional: { value: 3 }, unknown: { extra: [0, false, null] } };
    const written = await core.writeStatDiffToDbResult(applyingApi(tables), layout, previous, next, tables);
    assert.strictEqual(written.ok, true); assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, next);
    const before = JSON.stringify(tables);
    const rejected = await core.writeStatDiffToDbResult(applyingApi(tables), layout, next, { ...next, newGroup: {} }, tables);
    assert.strictEqual(rejected.ok, false); assert.strictEqual(rejected.plannedChanges, 0); assert.match(rejected.failureReason, /newGroup/);
    assert.strictEqual(JSON.stringify(tables), before);
});

test('转换接入：候选 Schema 保留业务变换，拒绝无效、未登记及过期提交', async () => {
    let current = true; const metadata = { schemaKeys: ['one'] };
    const factory = vm.runInNewContext('(' + createCardApi.toString() + ')');
    const api = factory({ readMetadata: () => metadata, isCurrent: () => current });
    await assert.rejects(api.validate({ hp: 999 }), /尚未登记/);
    assert.strictEqual(api.registerSchema({ safeParse: () => ({ success: true, data: {} }) }, 'foreign'), false);
    const input = { hp: 999 }; api.registerSchema({ safeParse: data => { data.hp = Math.min(data.hp, 125); return { success: true, data }; } }, 'one');
    assert.deepStrictEqual(clone(await api.validate(input)), { hp: 125 }); assert.strictEqual(input.hp, 999);
    api.registerSchema({ safeParse: data => ({success:true,data:{hp:data.hp+1}}) }, 'one');
    const normalized = await api.validate({hp:1});
    assert.deepStrictEqual(clone(await api.validate(clone(normalized), api.proofOf(normalized))), {hp:2});
    assert.deepStrictEqual(clone(await api.validate({hp:3}, api.proofOf(normalized))), {hp:4});
    api.registerSchema({ safeParse: () => ({ success: false, error: { message: 'invalid' } }) }, 'one');
    await assert.rejects(api.validate(input), /invalid/);
    let release; api.registerSchema({ safeParse() {}, safeParseAsync: data => new Promise(resolve => { release = () => resolve({ success: true, data }); }) }, 'one');
    const pending = api.validate(input); await Promise.resolve(); current = false; release(); await assert.rejects(pending, /会话已变化/);
});

test('转换接入：世界书别名仅路由绑定书，原 API 不变，过期写入停止', async () => {
    let current = true; const calls = [];
    const original = Object.freeze({ getCharWorldbookNames: () => ({ primary: 'book_DB', additional: ['other'] }),
        getWorldbookNames: () => ['book_DB', 'other'], getWorldbook: name => { calls.push(name); return name; },
        replaceWorldbook: (name, entries) => { calls.push(name); return entries; } });
    const api = createCardApi({ readMetadata: () => ({ worldbookAliases: { book: 'book_DB' } }), isCurrent: () => current });
    const facade = api.facade(original);
    assert.deepStrictEqual(facade.getCharWorldbookNames(), { primary: 'book_DB', additional: ['other', 'book'] });
    assert.strictEqual(facade.getWorldbook('book'), 'book_DB'); facade.replaceWorldbook('other', []);
    assert.deepStrictEqual(calls, ['book_DB', 'other']); assert.deepStrictEqual(original.getWorldbookNames(), ['book_DB', 'other']);
    current = false; assert.throws(() => facade.replaceWorldbook('book', []), /会话已变化/);
});

test('转换接入：创建单条档案先校验再落库，失败不报告成功，普通消息原样委派', async () => {
    const events = []; let saved = true;
    const api = createCardApi({ readMetadata: () => ({}), isCurrent: () => true, unmapped: data => Object.hasOwn(data, 'unknown') ? ['unknown'] : [],
        readMvu: () => ({ replaceMvuData: async data => { events.push(['save', data.stat_data]); return saved; } }) });
    const create = api.wrapCreate(async messages => { events.push(['create', messages]); return 'result'; });
    assert.strictEqual(await create([{ role: 'system', data: { stat_data: { value: 3 } } }]), 'result');
    assert.deepStrictEqual(events.map(e => e[0]), ['create', 'save']);
    events.length = 0; await assert.rejects(create([{ data: { stat_data: { unknown: {} } } }]), /未映射/); assert.strictEqual(events.length, 0);
    saved = false; await assert.rejects(create([{ data: { stat_data: { value: 4 } } }]), /保存失败/);
    events.length = 0; await create([{ role: 'user', message: 'hello' }]); assert.deepStrictEqual(events.map(e => e[0]), ['create']);
});

test('转换接入：真实组装运行时在 parseMessage 应用已登记 Schema，并还原助手入口', async () => {
    const source = require('./synthetic-card')();
    source.data.extensions.tavern_helper.scripts.push({ name: 'schema', enabled: true,
        content: "import {registerMvuSchema} from 'https://example.test/schema.js';const Schema=z.object({状态:z.object({生命:z.number(),金币:z.number()}),背包:z.array(z.any())}).passthrough();registerMvuSchema(Schema);" });
    const nativeCreate = async () => 'native', nativeHelper = { getWorldbook: name => name, createChatMessages: nativeCreate };
    const h = await nativeRuntime(source, ({ win }) => { win.createChatMessages = nativeCreate; win.TavernHelper = nativeHelper; });
    const key = h.context.characters[0].extensions.mvu2shujuku.schemaKeys[0];
    assert.strictEqual(h.win.Mvu.registerSchema({ safeParse: stat => { stat.状态.生命 = Math.min(125, stat.状态.生命); return { success: true, data: stat }; } }, key), true);
    const before = h.win.Mvu.getMvuData();
    const parsed = await h.win.Mvu.parseMessage('<JSONPatch>[{"op":"replace","path":"/状态/生命","value":999}]</JSONPatch>', before);
    assert.strictEqual(parsed.stat_data.状态.生命, 125);
    const helper = h.win.TavernHelper;
    h.context.characters.push({ name: 'ordinary', avatar: 'ordinary.png', extensions: {} });
    h.context.characterId = 1; h.context.chatId = 'ordinary'; await h.advance(2500);
    assert.strictEqual(h.win.TavernHelper, nativeHelper); assert.strictEqual(h.win.createChatMessages, nativeCreate);
    await assert.rejects(helper.createChatMessages([{ data: { stat_data: {} } }]), /会话已变化/);
});

test('转换接入：本地 Schema 路径钩子保留点斜线键，解析后保存只变换一次', async () => {
    const source = require('./synthetic-card')();
    const definition = 'const Schema=z.object({状态:z.object({生命:z.number(),金币:z.number()}),背包:z.array(z.any())}).passthrough();';
    source.data.extensions.tavern_helper.scripts.push({name:'normalizer',enabled:true,content:
        "import {registerMvuSchema} from 'https://example.test/schema.js';" + definition +
        "eventOn('mag_command_parsed_for_zod', (_, commands) => { for (const cmd of commands) cmd.args[0] = cmd.args[0] === 'state.生命' ? '[\"状态\"][\"生命\"]' : '[\"状态\"][\"a.b/c\"]'; });registerMvuSchema(Schema);"});
    const bus = new Map();
    const h = await nativeRuntime(source, ({win}) => {
        win.eventOn = (name, callback) => { const list=bus.get(name)||[]; list.push(callback); bus.set(name,list); };
        win.eventEmit = async (name,...args) => { for (const cb of bus.get(name)||[]) await cb(...args); };
    });
    h.win.registerMvuSchema = () => {};
    h.win.fixtureSchema = {safeParse: data => { data.状态.生命++; return {success:true,data}; }};
    const script = core.convert(source).card.data.extensions.tavern_helper.scripts.find(s=>s.name==='normalizer');
    vm.runInContext(script.content.replace(/import\s*\{[^}]+\}\s*from\s*'[^']+';/,'').replace(definition,'const Schema=fixtureSchema;'),h.win);
    await h.advance(2200);
    const input = h.win.Mvu.getMvuData(); input.stat_data.状态['a.b/c'] = 0;
    const parsed = await h.win.Mvu.parseMessage('<JSONPatch>[{"op":"replace","path":"/state/生命","value":90},{"op":"replace","path":"/state/key","value":7}]</JSONPatch>',input);
    assert.strictEqual(parsed.stat_data.状态.生命,91); assert.strictEqual(parsed.stat_data.状态['a.b/c'],7,JSON.stringify(parsed.stat_data.状态));
    const writing = h.win.Mvu.replaceMvuData(parsed); await h.advance(2200);
    assert.strictEqual(await writing,true); assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态.生命,91);
    assert.strictEqual(h.win.Mvu.getMvuData().stat_data.状态['a.b/c'],7);
});

test('转换接入：未知联合的嵌套初值及写回保留数组、布尔和 null', async () => {
    for (const value of [{deep:[0,false,null]},[1,false],['x','说明'], 'text',false,null,17,{}]) {
        const source = require('./synthetic-card')();
        const stat = {状态:{生命:100,金币:10,opaque:value, nested:{opaque:value}},背包:[],records:{one:{opaque:value}}};
        source.data.first_mes = '<initvar>'+JSON.stringify(stat)+'</initvar>'; source.data.alternate_greetings=[];
        source.data.character_book.entries[0].content=JSON.stringify(stat);
        source.data.extensions.tavern_helper.scripts.push({name:'opaque',content:
            'const Opaque=z.union([z.string(),z.object({})]);const Schema=z.object({状态:z.object({生命:z.number(),金币:z.number(),opaque:Opaque,nested:z.object({opaque:Opaque})}),背包:z.array(z.any()),records:z.record(z.string(),z.object({opaque:Opaque}))});registerMvuSchema(Schema);'});
        const r=core.convert(source),layout=JSON.parse(r.card.data.extensions.mvu2shujuku.layout),tables=clone(r.template);
        const read=core.statDataFromTables(layout,tables).stat_data;
        assert.deepStrictEqual(read,stat,'初值完整读回：'+JSON.stringify(value));
        const next=clone(stat);next.状态.opaque={next:[false,null]};next.状态.nested.opaque=null;next.records.one.opaque=[false,null];
        assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables),layout,read,next,tables)).ok,true);
        assert.deepStrictEqual(core.statDataFromTables(layout,tables).stat_data,next);
    }
});
