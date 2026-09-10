'use strict';

function computeParagraphDiff(beforeParas, afterParas) {
  const n = beforeParas.length;
  const m = afterParas.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (beforeParas[i] === afterParas[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const changes = [];
  let i = 0;
  let j = 0;
  let seq = 0;
  let order = 0;
  const nextId = () => `ac-${String(++seq).padStart(3, '0')}`;

  const pushDelete = (anchor) => {
    changes.push({
      id: nextId(),
      location: { type: 'paragraph', index: anchor },
      order: order++,
      kind: 'delete',
      before: { text: beforeParas[i] },
      renderHint: 'inline',
    });
    i++;
  };
  const pushInsert = (anchor) => {
    changes.push({
      id: nextId(),
      location: { type: 'paragraph', index: anchor },
      order: order++,
      kind: 'insert',
      after: { text: afterParas[j] },
      renderHint: 'inline',
    });
    j++;
  };

  while (i < n && j < m) {
    if (beforeParas[i] === afterParas[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      const anchor = i;
      pushDelete(anchor);
      while (j < m && i < n && beforeParas[i] !== afterParas[j] && dp[i + 1][j] < dp[i][j + 1]) {
        pushInsert(anchor);
      }
    } else {
      pushInsert(i);
    }
  }
  while (i < n) pushDelete(i);
  while (j < m) pushInsert(i);

  return coalesceReplacements(changes);
}

function coalesceReplacements(changes) {
  const result = [];
  for (let k = 0; k < changes.length; k++) {
    const cur = changes[k];
    const nxt = changes[k + 1];
    if (
      cur &&
      nxt &&
      cur.kind === 'delete' &&
      nxt.kind === 'insert' &&
      cur.location.index === nxt.location.index
    ) {
      result.push({
        id: cur.id,
        location: cur.location,
        kind: 'text',
        before: cur.before,
        after: nxt.after,
        renderHint: 'inline',
      });
      k++;
    } else {
      result.push(cur);
    }
  }
  return result;
}

function applyChanges(beforeParas, changes, acceptedIds) {
  const accepted = acceptedIds === null
    ? new Set(changes.map((c) => c.id))
    : new Set(acceptedIds);

  const ops = changes
    .filter((c) => accepted.has(c.id))
    .map((c) => ({ ...c }));

  const byIndex = new Map();
  for (const op of ops) {
    const idx = op.location.index;
    if (!byIndex.has(idx)) byIndex.set(idx, []);
    byIndex.get(idx).push(op);
  }
  for (const group of byIndex.values()) {
    group.sort((a, b) => a.order - b.order);
  }

  const sortedIndices = Array.from(byIndex.keys()).sort((a, b) => b - a);
  const out = beforeParas.slice();

  for (const idx of sortedIndices) {
    const group = byIndex.get(idx);
    const deleteOp = group.find((c) => c.kind === 'delete' || c.kind === 'text');
    const insertOps = group.filter((c) => c.kind === 'insert');
    const textOp = group.find((c) => c.kind === 'text');

    if (textOp) {
      const extras = insertOps.map((c) => c.after.text);
      out.splice(idx, 1, textOp.after.text, ...extras);
    } else if (deleteOp) {
      out.splice(idx, 1, ...insertOps.map((c) => c.after.text));
    } else {
      out.splice(idx, 0, ...insertOps.map((c) => c.after.text));
    }
  }
  return out;
}

function invertChanges(afterParas, beforeParas) {
  return computeParagraphDiff(afterParas, beforeParas);
}

module.exports = {
  computeParagraphDiff,
  applyChanges,
  invertChanges,
};
