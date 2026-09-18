import assert from 'node:assert/strict';
import { sequenceCuts } from '../engine.js';

const EPS = 1e-5;
export const close = (a, b) => assert.ok(Math.abs(a - b) < EPS, `${a} != ${b}`);

// Replay the geometry independently of the solver: every blade spans its
// current piece, kerf is accounted for, and each finished part survives intact.
export function validate(original, tree, opt, { allowMoves = false } = {}) {
  const found = new Map();
  let leafArea = 0, kerfArea = 0;
  const walk = (n, previous = null, previousStage = 0) => {
    assert.ok(n.l > 0 && n.w > 0);
    if (n.kind !== 'int') {
      leafArea += n.l * n.w;
      if (n.kind === 'part') { assert.ok(!found.has(n.part.key)); found.set(n.part.key, n); }
      return;
    }
    const { dir, gauge, stage } = n.cut;
    const [g, r] = n.kids;
    const horizontal = dir === 'h';
    const size = horizontal ? 'w' : 'l', axis = horizontal ? 'y' : 'x';
    const span = horizontal ? 'l' : 'w';
    const kerf = horizontal ? opt.kerfH : opt.kerfV;
    assert.ok(gauge > 0 && gauge < n[size]);
    assert.equal(stage, previous === null ? 1 : previousStage + Number(previous !== dir));
    assert.ok(stage <= opt.maxStage);
    if (!previous && opt.firstCut !== 'auto') assert.equal(dir, opt.firstCut);
    close(g.x, n.x); close(g.y, n.y); close(g[size], gauge); close(g[span], n[span]);
    const consumed = Math.min(kerf, n[size] - gauge);
    kerfArea += consumed * n[span];
    if (r) {
      close(r[axis], n[axis] + gauge + kerf);
      close(r[size], n[size] - gauge - kerf);
      close(r[span], n[span]);
      close(r[horizontal ? 'x' : 'y'], n[horizontal ? 'x' : 'y']);
    } else close(n[size] - gauge - consumed, 0);
    if (opt.half && stage === opt.maxStage) {
      assert.equal(g.kind, 'part');
      if (r) { assert.equal(r.kind, 'free'); assert.equal(r.dead, true); }
    }
    walk(g, dir, stage);
    if (r) walk(r, dir, stage);
  };
  for (const key of ['x', 'y', 'l', 'w']) close(tree.root[key], original.root[key]);
  walk(tree.root);
  close(leafArea + kerfArea, tree.root.l * tree.root.w);
  assert.equal(found.size, original.placements.length);
  for (const p of original.placements) {
    const n = found.get(p.key);
    assert.ok(n, p.key);
    if (!allowMoves) {
      for (const key of ['x', 'y', 'l', 'w']) close(n[key], p[key]);
      assert.equal(n.part.rot, p.rot);
    } else if (n.part.rot !== p.rot) {
      assert.equal(p.canTurn, true, 'rotation must be allowed for this part');
      close(n.l, p.w); close(n.w, p.l);
    } else { close(n.l, p.l); close(n.w, p.w); }
    assert.equal(n.part.pid, p.pid);
    assert.equal(n.part.canTurn, p.canTurn);
  }
  assert.deepEqual([...tree.placedKeys].sort(), [...original.placedKeys].sort());
  assert.equal(tree.placements.length, found.size);
  for (const p of tree.placements) {
    const leaf = found.get(p.key);
    assert.ok(leaf);
    for (const key of ['x', 'y', 'l', 'w']) close(p[key], leaf[key]);
  }
  assert.ok(tree.cutsRaw.length <= original.cutsRaw.length);
  const rows = sequenceCuts(tree, { ...opt, ox: 0, oy: 0 }).rows;
  assert.ok(rows.every((r) => r.pieceName !== '?'));
  const available = [tree.root];
  for (const row of rows) {
    const index = available.findIndex((n) => ['x', 'y', 'l', 'w'].every((k) => Math.abs(n[k] - row.pieceRect[k]) < EPS));
    assert.ok(index >= 0, 'each cut must operate on an already separated piece');
    const [piece] = available.splice(index, 1);
    available.push(...piece.kids.filter(Boolean));
  }
}

