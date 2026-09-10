'use strict';

const fs = require('fs');
const path = require('path');

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineDiff(beforeText, afterText) {
  if (beforeText === afterText) {
    return `<span>${escapeHtml(beforeText)}</span>`;
  }

  const bWords = beforeText.split(/(\s+)/);
  const aWords = afterText.split(/(\s+)/);
  const nb = bWords.length;
  const na = aWords.length;

  const dp = Array.from({ length: nb + 1 }, () => new Array(na + 1).fill(0));
  for (let i = nb - 1; i >= 0; i--) {
    for (let j = na - 1; j >= 0; j--) {
      dp[i][j] =
        bWords[i] === aWords[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts = [];
  let i = 0;
  let j = 0;
  while (i < nb && j < na) {
    if (bWords[i] === aWords[j]) {
      parts.push({ type: 'eq', text: bWords[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      parts.push({ type: 'del', text: bWords[i] });
      i++;
    } else {
      parts.push({ type: 'ins', text: aWords[j] });
      j++;
    }
  }
  while (i < nb) {
    parts.push({ type: 'del', text: bWords[i++] });
  }
  while (j < na) {
    parts.push({ type: 'ins', text: aWords[j++] });
  }

  return parts
    .map((p) => {
      if (p.type === 'eq') return escapeHtml(p.text);
      if (p.type === 'del')
        return `<del class="diff-del">${escapeHtml(p.text)}</del>`;
      return `<ins class="diff-ins">${escapeHtml(p.text)}</ins>`;
    })
    .join('');
}

function renderDiffHtml(beforeParas, afterParas, changes, acceptedIds, outPath) {
  const acceptedSet =
    acceptedIds === null
      ? new Set(changes.map((c) => c.id))
      : new Set(acceptedIds);

  const changeMap = new Map();
  for (const c of changes) {
    changeMap.set(c.id, c);
  }

  const paraRows = [];

  const maxLen = Math.max(beforeParas.length, afterParas.length);
  for (let idx = 0; idx < maxLen; idx++) {
    const b = beforeParas[idx] ?? null;
    const a = afterParas[idx] ?? null;
    paraRows.push({ idx, b, a });
  }

  const changeRows = changes.map((c) => {
    const isAccepted = acceptedSet.has(c.id);
    let badge = '';
    if (c.kind === 'delete') badge = '<span class="badge badge-del">删除</span>';
    else if (c.kind === 'insert') badge = '<span class="badge badge-ins">插入</span>';
    else badge = '<span class="badge badge-mod">修改</span>';

    const acceptBadge = isAccepted
      ? '<span class="badge badge-accepted">✓ 接受</span>'
      : '<span class="badge badge-skipped">— 跳过</span>';

    let inlineDiff = '';
    if (c.kind === 'text') {
      inlineDiff = renderInlineDiff(c.before.text, c.after.text);
    } else if (c.kind === 'delete') {
      inlineDiff = `<del class="diff-del">${escapeHtml(c.before.text)}</del>`;
    } else {
      inlineDiff = `<ins class="diff-ins">${escapeHtml(c.after.text)}</ins>`;
    }

    return `
      <tr class="${isAccepted ? 'row-accepted' : 'row-skipped'}">
        <td class="cell-id">${escapeHtml(c.id)}</td>
        <td>${badge} ${acceptBadge}</td>
        <td class="cell-inline">${inlineDiff}</td>
      </tr>`;
  });

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>Word 段落级 diff PoC — T-S0-04</title>
<style>
  :root {
    --bg: #f8f8f8;
    --surface: #ffffff;
    --border: #d0d0d0;
    --text: #1a1a1a;
    --muted: #666666;
    --ins-bg: #d4f4dd;
    --ins-fg: #1a6b2f;
    --del-bg: #fde8e8;
    --del-fg: #921a1a;
    --accepted-bg: #f0faf2;
    --skipped-bg: #fafafa;
    --radius: 6px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.6 system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 32px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  h2 { font-size: 15px; margin: 24px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f2f2f2; font-size: 12px; font-weight: 600; text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  td { padding: 9px 12px; vertical-align: top; border-bottom: 1px solid #eeeeee; font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  .cell-id { color: var(--muted); font-family: monospace; font-size: 12px; white-space: nowrap; }
  .cell-inline { font-family: monospace; }
  del.diff-del { background: var(--del-bg); color: var(--del-fg); text-decoration: line-through; padding: 0 2px; border-radius: 2px; }
  ins.diff-ins { background: var(--ins-bg); color: var(--ins-fg); text-decoration: none; padding: 0 2px; border-radius: 2px; }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; }
  .badge-del { background: var(--del-bg); color: var(--del-fg); }
  .badge-ins { background: var(--ins-bg); color: var(--ins-fg); }
  .badge-mod { background: #e8eef8; color: #1a3a6b; }
  .badge-accepted { background: #d4f4dd; color: #1a6b2f; }
  .badge-skipped { background: #f0f0f0; color: var(--muted); }
  .row-accepted td { background: var(--accepted-bg); }
  .row-skipped td { background: var(--skipped-bg); color: var(--muted); }
  .para-before { background: #fff8f8; }
  .para-after { background: #f8fff9; }
  .para-label { font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
  .para-text { font-family: monospace; font-size: 13px; white-space: pre-wrap; }
  .para-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .para-cell { padding: 10px 14px; border-bottom: 1px solid #eeeeee; }
  .para-cell:nth-child(odd) { border-right: 1px solid var(--border); }
</style>
</head>
<body>
<h1>Word 段落级 diff — T-S0-04 验证报告</h1>
<p class="subtitle">AtomicChange 渲染 · 部分接受 · 回滚验证</p>

<h2>原文 vs 改后（段落对比）</h2>
<div class="card">
  <div class="para-grid">
    <div class="para-cell para-before"><div class="para-label">原文（before）</div></div>
    <div class="para-cell para-after"><div class="para-label">改后（after）</div></div>
    ${paraRows
      .map(
        (r) => `
    <div class="para-cell para-before"><div class="para-text">${r.b !== null ? escapeHtml(r.b) : '<em style="color:#bbb">（无）</em>'}</div></div>
    <div class="para-cell para-after"><div class="para-text">${r.a !== null ? escapeHtml(r.a) : '<em style="color:#bbb">（无）</em>'}</div></div>`
      )
      .join('')}
  </div>
</div>

<h2>AtomicChange 列表（内联高亮 + 接受状态）</h2>
<div class="card">
  <table>
    <thead><tr><th>ID</th><th>类型 / 状态</th><th>内联 Diff</th></tr></thead>
    <tbody>${changeRows.join('')}</tbody>
  </table>
</div>
</body>
</html>`;

  fs.writeFileSync(outPath, html, 'utf8');
}

module.exports = { renderDiffHtml };
