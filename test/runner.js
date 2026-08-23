/*
 * 测试注册与运行器：支持按名称过滤单独跑（--grep / TEST_FILTER）与列出测试（--list）。
 * 用法：
 *   node test/run-tests.js                 # 全量
 *   node test/run-tests.js --grep 桥       # 只跑名称含“桥”的测试（正则，忽略大小写）
 *   node test/run-tests.js --grep "扩展|切卡"
 *   TEST_FILTER=扩展 node test/run-tests.js
 *   node test/run-tests.js --list [--grep 关键词]
 *   node test/run-tests.js --verbose       # 显示每条用例与 VM/数据桥日志
 */
'use strict';

let passed = 0;
let failed = 0;
let skipped = 0;
const pendingTests = [];
const util = require('util');

function test(name, fn) {
    pendingTests.push({ name, fn });
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = { grep: null, list: false, help: false, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--grep' || a === '-g') args.grep = argv[++i];
        else if (a.startsWith('--grep=')) args.grep = a.slice('--grep='.length);
        else if (a === '--list' || a === '-l') args.list = true;
        else if (a === '--verbose' || a === '-v') args.verbose = true;
        else if (a === '--help' || a === '-h') args.help = true;
    }
    if (!args.grep && process.env.TEST_FILTER) args.grep = process.env.TEST_FILTER;
    if (!args.verbose && /^(?:1|true|yes)$/i.test(String(process.env.TEST_VERBOSE || ''))) args.verbose = true;
    return args;
}

function matches(name, grep) {
    if (!grep) return true;
    try {
        return new RegExp(grep, 'i').test(name);
    } catch (e) {
        // 非法正则退化为子串匹配（如 --grep "扩展安全门控"）
        return String(name).toLowerCase().includes(String(grep).toLowerCase());
    }
}

async function runTests(args = {}) {
    const grep = args.grep || null;
    const filtered = pendingTests.filter(t => matches(t.name, grep));
    if (args.help) {
        console.log('用法：node test/run-tests.js [--grep <正则|关键词>] [--list] [--verbose] [--help]');
        console.log('  --grep/-g <p>   只跑名称匹配 p 的测试（忽略大小写，非法正则按子串匹配）');
        console.log('  --list/-l       只列出匹配的测试名，不执行');
        console.log('  --verbose/-v    显示通过用例及 VM/数据桥完整日志');
        console.log('  环境变量 TEST_FILTER 等价于 --grep');
        console.log('  环境变量 TEST_VERBOSE=1 等价于 --verbose');
        process.exit(0);
    }
    if (args.list) {
        for (const t of filtered) console.log(t.name);
        console.log(`\n共 ${pendingTests.length} 个测试${grep ? `，匹配 ${filtered.length} 个（grep=${grep}）` : ''}`);
        process.exit(0);
    }
    console.log(grep
        ? `\n运行 ${filtered.length}/${pendingTests.length} 个测试（grep=${grep}）\n`
        : `\n运行全部 ${pendingTests.length} 个测试\n`);
    for (const t of filtered) {
        const captured = [];
        const originals = {};
        if (!args.verbose) {
            for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
                originals[level] = console[level];
                console[level] = (...items) => {
                    let line = '';
                    try { line = util.format(...items); } catch (e) { line = items.map(String).join(' '); }
                    if (line.length > 2000) line = line.slice(0, 2000) + '…[单条截断]';
                    captured.push(`[${level}] ${line}`);
                    if (captured.length > 20) captured.shift();
                };
            }
        }
        const restoreConsole = () => {
            if (args.verbose) return;
            for (const level of Object.keys(originals)) console[level] = originals[level];
        };
        try {
            await t.fn();
            restoreConsole();
            passed += 1;
            if (args.verbose) console.log('  ✓', t.name);
        } catch (e) {
            restoreConsole();
            if (e && e.code === 'SKIP_NO_FIXTURE') {
                skipped += 1;
                console.log('  - 跳过（无参考卡 fixture，仅保留通用性测试）', t.name);
                continue;
            }
            failed += 1;
            console.error('  ✗', t.name);
            console.error('    ', e && e.stack ? e.stack : (e && e.message ? e.message : e));
            if (captured.length) {
                console.error(`    —— 该用例最后 ${captured.length} 条被抑制日志（完整输出用 --verbose） ——`);
                for (const line of captured) console.error('    ' + line.replace(/\n/g, '\n    '));
            }
        }
    }
    console.log(`\n结果：${passed} 通过，${failed} 失败${skipped ? `，${skipped} 跳过` : ''}${grep ? `（过滤：${grep}）` : ''}`);
    // VM 内桥使用真实定时器（合并写入/重试），测试结束后直接退出，避免未清理定时器拖住进程
    process.exit(failed ? 1 : 0);
}

module.exports = { test, runTests, parseArgs, matches, pendingTests };
