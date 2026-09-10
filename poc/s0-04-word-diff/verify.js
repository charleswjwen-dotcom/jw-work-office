'use strict';

const path = require('path');
const fs = require('fs');
const { computeParagraphDiff, applyChanges, invertChanges } = require('./diff_engine');
const { renderDiffHtml } = require('./diff_renderer');

const OUT_DIR = path.join(__dirname, 'verify_out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function arrEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

console.log('\n══════════════════════════════════════════');
console.log('  T-S0-04  Word 段落级 diff PoC 验证');
console.log('══════════════════════════════════════════\n');

const BEFORE = [
  '项目背景：本系统旨在提升办公效率，服务个人用户。',
  '核心功能包括文档处理、智能问答与文件管理。',
  '技术栈选用 Electron + React + TypeScript。',
  '数据存储使用 SQLite，通过 Drizzle ORM 访问。',
  '部署方式为本地桌面应用，不依赖云端服务器。',
];

const AFTER = [
  '项目背景：本系统旨在提升办公效率，服务个人及企业用户。',
  '核心功能包括文档处理、智能问答与文件管理。',
  '技术栈选用 Electron + React + TypeScript 5。',
  '引入 python-pptx 处理 PPT 改写，随包分发 Python 运行时。',
  '数据存储使用 SQLite，通过 Drizzle ORM 访问。',
  '部署方式为本地桌面应用，不依赖云端服务器。',
];

console.log('【1】AtomicChange 序列化');
const changes = computeParagraphDiff(BEFORE, AFTER);
assert('diff 结果非空', changes.length > 0);
assert('每条变更含 id', changes.every((c) => typeof c.id === 'string' && c.id.length > 0));
assert(
  '每条变更含 location.type=paragraph',
  changes.every((c) => c.location && c.location.type === 'paragraph')
);
assert(
  'kind 合法值',
  changes.every((c) => ['text', 'insert', 'delete'].includes(c.kind))
);
const modChange = changes.find((c) => c.kind === 'text');
assert('text 类型变更含 before 和 after', modChange != null && modChange.before != null && modChange.after != null);
console.log(`  → 共生成 ${changes.length} 条 AtomicChange：`);
for (const c of changes) {
  const bText = c.before ? c.before.text.slice(0, 30) : '—';
  const aText = c.after ? c.after.text.slice(0, 30) : '—';
  console.log(`    [${c.id}] ${c.kind.padEnd(6)} idx=${c.location.index}  before="${bText}"  after="${aText}"`);
}

console.log('\n【2】全量接受 → 应用后等于 AFTER');
const fullApplied = applyChanges(BEFORE, changes, null);
assert('全量接受后段落数与 AFTER 相同', fullApplied.length === AFTER.length, `got ${fullApplied.length}, want ${AFTER.length}`);
assert('全量接受后内容与 AFTER 完全一致', arrEq(fullApplied, AFTER));

console.log('\n【3】部分接受：只接受第一条变更');
const firstId = changes[0].id;
const partialApplied = applyChanges(BEFORE, changes, [firstId]);
assert('部分接受后结果不等于 BEFORE', !arrEq(partialApplied, BEFORE));
assert('部分接受后结果不等于 AFTER（因为有跳过的变更）', !arrEq(partialApplied, AFTER));
const firstChange = changes[0];
if (firstChange.kind === 'text') {
  const idx = firstChange.location.index;
  assert(
    '部分接受——被接受行已更新',
    partialApplied[idx] === firstChange.after.text,
    `idx=${idx} got "${partialApplied[idx]}"`
  );
} else if (firstChange.kind === 'delete') {
  assert('部分接受——被删行已消失', !partialApplied.includes(firstChange.before.text));
} else {
  assert('部分接受——被插入行已出现', partialApplied.includes(firstChange.after.text));
}
console.log(`  → 仅接受 [${firstId}]，段落数 ${BEFORE.length} → ${partialApplied.length}`);

console.log('\n【4】回滚：全量应用后反向 diff 恢复原文');
const inverted = invertChanges(fullApplied, BEFORE);
assert('invertChanges 返回非空数组', inverted.length > 0);
const rolledBack = applyChanges(fullApplied, inverted, null);
assert('回滚后段落数与 BEFORE 相同', rolledBack.length === BEFORE.length, `got ${rolledBack.length}, want ${BEFORE.length}`);
assert('回滚后内容与 BEFORE 完全一致', arrEq(rolledBack, BEFORE));

console.log('\n【5】HTML 渲染输出');
const htmlAllPath = path.join(OUT_DIR, 'diff_all_accepted.html');
const htmlPartialPath = path.join(OUT_DIR, 'diff_partial.html');
renderDiffHtml(BEFORE, AFTER, changes, null, htmlAllPath);
renderDiffHtml(BEFORE, AFTER, changes, [firstId], htmlPartialPath);
assert('全量接受 HTML 已生成', fs.existsSync(htmlAllPath));
assert('部分接受 HTML 已生成', fs.existsSync(htmlPartialPath));
const htmlContent = fs.readFileSync(htmlAllPath, 'utf8');
assert('HTML 含内联高亮 del 标签', htmlContent.includes('diff-del'));
assert('HTML 含内联高亮 ins 标签', htmlContent.includes('diff-ins'));
console.log(`  → ${htmlAllPath}`);
console.log(`  → ${htmlPartialPath}`);

console.log('\n【6】边界用例（往返一致性：apply=after，回滚=before）');
const edgeCases = [
  { name: '纯插入（尾部追加）', b: ['A', 'B'], a: ['A', 'B', 'C', 'D'] },
  { name: '纯插入（头部插入）', b: ['B', 'C'], a: ['A', 'B', 'C'] },
  { name: '纯删除', b: ['A', 'B', 'C', 'D'], a: ['A', 'D'] },
  { name: '整体替换', b: ['X', 'Y'], a: ['P', 'Q', 'R'] },
  { name: 'before 为空', b: [], a: ['A', 'B'] },
  { name: 'after 为空', b: ['A', 'B'], a: [] },
  { name: '无变化', b: ['A', 'B'], a: ['A', 'B'] },
];
for (const ec of edgeCases) {
  const cs = computeParagraphDiff(ec.b, ec.a);
  const applied = applyChanges(ec.b, cs, null);
  const inv = invertChanges(applied, ec.b);
  const back = applyChanges(applied, inv, null);
  const ok = arrEq(applied, ec.a) && arrEq(back, ec.b);
  assert(`${ec.name}：apply=after 且回滚=before`, ok, `applied=${JSON.stringify(applied)}`);
}

console.log('\n══════════════════════════════════════════');
const total = passed + failed;
console.log(`  结果：${passed}/${total} 通过${failed > 0 ? `，${failed} 失败` : ''}`);
console.log('══════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
