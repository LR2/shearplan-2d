const EPS = 1e-6;

// Rebuild a guillotine tree for a FIXED layout. Candidate lines follow part
// edges (including the kerf band). Memoized rectangular subproblems compare
// cut count first, then total blade travel. Bounds keep large jobs responsive;
// the decoder's valid tree is always the fallback, never a partial solution.
export function optimizeCutTree(original, options) {
  const { kerfH = 0, kerfV = 0, maxStage = 99, half = false,
    firstCut = 'auto', remnantsEnabled = false, minRemL = 0, minRemW = 0,
    maxStates = 6000, maxChecks = 300000 } = options;
  if (!original.root || !original.cutsRaw.length) return original;
  const isRemnant = (n) => !n.dead &&
    Math.max(n.l, n.w) >= Math.max(minRemL, minRemW) - EPS &&
    Math.min(n.l, n.w) >= Math.min(minRemL, minRemW) - EPS;
  const items = original.placements.map((p) => ({ ...p, isPart: true }));
  // Kept drops are protected rectangles, so a faster sequence cannot cut
  // through a remnant the operator intended to save.
  if (remnantsEnabled) items.push(...original.frees.filter(isRemnant));
  const memo = new Map();
  let checks = 0;
  let states = 0;
  const better = (a, b) => a && (!b || a.count < b.count ||
    (a.count === b.count && a.travel < b.travel - EPS));
  const solve = (rect, contents, previous, previousStage) => {
    const parts = contents.filter((p) => p.isPart);
    if (!parts.length) return { rect, kind: 'free', count: 0, travel: 0 };
    if (parts.length === 1 && contents.length === 1) {
      const p = parts[0];
      if (['x', 'y', 'l', 'w'].every((k) => Math.abs(p[k] - rect[k]) < EPS)) {
        return { rect, kind: 'part', part: p, count: 0, travel: 0 };
      }
    }
    const key = [rect.x, rect.y, rect.l, rect.w, previous, previousStage].join('|');
    if (memo.has(key)) return memo.get(key);
    if (++states > maxStates || checks > maxChecks) return null;
    const candidates = [];
    for (const dir of ['h', 'v']) {
      if (!previous && firstCut !== 'auto' && firstCut && firstCut !== dir) continue;
      const stage = previous === null ? 1 : previousStage + (dir !== previous ? 1 : 0);
      if (stage > maxStage) continue;
      const axis = dir === 'h' ? 'y' : 'x';
      const size = dir === 'h' ? 'w' : 'l';
      const kerf = dir === 'h' ? kerfH : kerfV;
      const end = rect[axis] + rect[size];
      const positions = [...new Set(contents.flatMap((p) => [p[axis] + p[size], p[axis] - kerf]))];
      for (const pos of positions) {
        if (pos <= rect[axis] + EPS || pos >= end - EPS) continue;
        const after = Math.min(end, pos + kerf);
        const left = [], right = [];
        let valid = true;
        for (const p of contents) {
          if (++checks > maxChecks) { valid = false; break; }
          if (p[axis] + p[size] <= pos + EPS) left.push(p);
          else if (p[axis] >= after - EPS) right.push(p);
          else { valid = false; break; } // would cut through a part or saved drop
        }
        if (!valid) continue;
        const g = { ...rect, [size]: pos - rect[axis] };
        const r = end - after > EPS ? { ...rect, [axis]: after, [size]: end - after } : null;
        candidates.push({ dir, stage, gauge: g[size], g, r, left, right,
          trim: !left.some((p) => p.isPart) || !right.some((p) => p.isPart) });
      }
    }
    // Try shared boundary trims before separating individual parts. Balanced
    // divisions then shorten the search on large grids.
    candidates.sort((a, b) => Number(b.trim) - Number(a.trim) ||
      Math.abs(a.left.length - a.right.length) - Math.abs(b.left.length - b.right.length));
    let best = null;
    for (const c of candidates) {
      if (checks > maxChecks) break;
      const g = solve(c.g, c.left, c.dir, c.stage);
      if (!g) continue;
      if (half && c.stage === maxStage &&
          (g.kind !== 'part' || c.right.some((p) => p.isPart))) continue;
      const r = c.r ? solve(c.r, c.right, c.dir, c.stage) : null;
      if (c.r && !r) continue;
      const candidate = { rect, kind: 'int', ...c, kids: [g, r],
        count: 1 + g.count + (r?.count || 0),
        travel: (c.dir === 'h' ? rect.l : rect.w) + g.travel + (r?.travel || 0) };
      if (better(candidate, best)) best = candidate;
    }
    memo.set(key, best);
    return best;
  };
  const r = original.root;
  const best = solve({ x: r.x, y: r.y, l: r.l, w: r.w }, items, null, 0);
  const oldScore = { count: original.cutsRaw.length,
    travel: original.cutsRaw.reduce((sum, n) => sum + (n.cut.dir === 'h' ? n.l : n.w), 0) };
  if (!better(best, oldScore)) return original;

  const cutsRaw = [], frees = [], placements = [];
  let nextId = 0;
  const materialize = (item, cdir = null, stage = 0, dead = false) => {
    const n = { ...item.rect, id: nextId++, kind: item.kind, cdir, stage, dead };
    if (item.kind === 'part') {
      const { pid, label, key, rot } = item.part;
      n.part = { pid, label, key, rot };
      placements.push({ ...item.rect, ...n.part, node: n });
    } else if (item.kind === 'free') frees.push(n);
    else {
      n.cut = { dir: item.dir, gauge: item.gauge, stage: item.stage, ci: cutsRaw.length, node: n };
      cutsRaw.push(n);
      n.kids = [materialize(item.kids[0], item.dir, item.stage),
        item.kids[1] ? materialize(item.kids[1], item.dir, item.stage, half && item.stage === maxStage) : null];
    }
    return n;
  };
  const root = materialize(best);
  return { root, cutsRaw, frees, placements, placedKeys: new Set(original.placedKeys) };
}
