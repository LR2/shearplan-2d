import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeCutTree } from './cut-optimizer.js';
import { CUT_TYPES, decodeSheet, sequenceCuts, finalizePlan, optimizeSolutionCuts,
  baselineOptHashOf, mulberry32, runSearch, refineResultCuts } from './engine.js';
import { DEFAULT_SETTINGS } from './settings.js';

const EPS = 1e-5;
const close = (a, b) => assert.ok(Math.abs(a - b) < EPS, `${a} != ${b}`);
const instances = (n, l, w) => Array.from({ length: n }, (_, i) => ({
  key: `p#${i}`, pid: 'p', label: 'P', l, w, canTurn: false,
}));
const options = (extra = {}) => ({ ...DEFAULT_SETTINGS, maxStage: 3, half: false,
  choice: 'BSSF', splitPref: 'v', ...extra });

// Replay the geometry independently of the solver: every blade spans its
// current piece, kerf is accounted for, and each finished part survives intact.
function validate(original, tree, opt) {
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
  walk(tree.root);
  close(leafArea + kerfArea, tree.root.l * tree.root.w);
  assert.equal(found.size, original.placements.length);
  for (const p of original.placements) {
    const n = found.get(p.key);
    assert.ok(n, p.key);
    for (const key of ['x', 'y', 'l', 'w']) close(n[key], p[key]);
    assert.equal(n.part.pid, p.pid); assert.equal(n.part.rot, p.rot);
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

test('shared boundary trims reduce the six-part example from 12 cuts to 7', () => {
  const opt = options();
  const original = decodeSheet({ uL: 132, uW: 48 }, instances(6, 20, 40), { ...opt, firstCut: 'v' });
  assert.equal(original.cutsRaw.length, 12);
  const next = optimizeCutTree(original, opt);
  assert.equal(next.cutsRaw.length, 7);
  validate(original, next, opt);
});

test('two-stage plans find the shared long-side trim first', () => {
  const opt = options({ maxStage: 2 });
  const original = decodeSheet({ uL: 132, uW: 48 }, instances(6, 20, 40), { ...opt, firstCut: 'v' });
  const next = optimizeCutTree(original, opt);
  assert.equal(next.cutsRaw.length, 7);
  assert.equal(next.root.cut.dir, 'h');
  close(next.root.cut.gauge, 40);
  validate(original, next, opt);
});

test('respects a locked first cut and asymmetric nonzero kerf', () => {
  for (const firstCut of ['h', 'v']) {
    const opt = options({ firstCut, kerfH: 0.1875, kerfV: 0.375 });
    const original = decodeSheet({ uL: 132, uW: 48 }, instances(6, 20, 40), opt);
    validate(original, optimizeCutTree(original, opt), opt);
  }
});

test('bounded search keeps the valid original when it cannot finish a solution', () => {
  const opt = options();
  const original = decodeSheet({ uL: 132, uW: 48 }, instances(6, 20, 40), opt);
  assert.equal(optimizeCutTree(original, { ...opt, maxStates: 0 }), original);
});

test('saved drops survive as intact or larger rectangles', () => {
  const opt = options({ remnantsEnabled: true, minRemL: 8, minRemW: 8 });
  const original = decodeSheet({ uL: 132, uW: 48 }, instances(6, 20, 40), { ...opt, firstCut: 'v' });
  const next = optimizeCutTree(original, opt);
  validate(original, next, opt);
  for (const f of original.frees.filter((f) => !f.dead && Math.min(f.l, f.w) >= 8)) {
    assert.ok(next.frees.some((g) => g.x <= f.x + EPS && g.y <= f.y + EPS &&
      g.x + g.l >= f.x + f.l - EPS && g.y + g.w >= f.y + f.w - EPS));
  }
});

test('random layouts preserve all parts, geometry, kerf and stage constraints', () => {
  const rng = mulberry32(481516);
  for (const cutType of ['2', '2.5', '3', '3.5', 'free']) {
    for (let i = 0; i < 8; i++) {
      const opt = options({ ...CUT_TYPES[cutType], kerfH: i % 2 ? 0.25 : 0,
        kerfV: i % 2 ? 0.5 : 0, firstCut: ['h', 'v', 'auto'][i % 3] });
      const parts = Array.from({ length: 18 }, (_, k) => ({ key: `p${k}`, pid: `p${k}`,
        label: String(k), l: 5 + Math.floor(rng() * 30), w: 5 + Math.floor(rng() * 20), canTurn: true }));
      const original = decodeSheet({ uL: 120, uW: 48 }, parts, { ...opt, firstCut: opt.firstCut === 'auto' ? null : opt.firstCut });
      validate(original, optimizeCutTree(original, opt), opt);
    }
  }
});

test('disabling remnants removes the yield and cost credits, report labels, and preference', () => {
  const stock = { id: 'stock', len: 132, wid: 48, qty: 1, cost: 100 };
  const res = decodeSheet({ uL: 132, uW: 48 }, instances(6, 20, 40), options());
  const make = (settings) => finalizePlan([stock], [], [{ stock, res, placedArea: 4800 }], settings);
  const on = make({ ...DEFAULT_SETTINGS, remnantsEnabled: true, minRemL: 8, minRemW: 8 });
  const off = make({ ...DEFAULT_SETTINGS, remnantsEnabled: false, remRate: 99, minRemL: 8, minRemW: 8 });
  assert.ok(on.stats.remnantArea > 0);
  assert.equal(off.stats.remnantArea, 0);
  close(off.stats.netYield, off.stats.grossYield);
  assert.equal(off.fitness[1], 100);
  assert.ok(off.sheets[0].offcuts.every((o) => o.type === 'scrap'));
  assert.ok(off.sheets[0].cuts.every((c) => c.resultInfo.type !== 'remnant' && c.remInfo?.type !== 'remnant'));
  assert.equal(make({ ...DEFAULT_SETTINGS, remRate: 0 }).fitness[1], off.fitness[1]);
  const refined = optimizeSolutionCuts(off, DEFAULT_SETTINGS);
  assert.equal(refined.stats.cutCount, refined.sheets[0].cuts.length);
  assert.equal(refined.runs[0].layout, refined.sheets[0]);
  assert.equal(refined.groups[0].layout, refined.sheets[0]);
  assert.equal(refined.stats.remnantArea, 0);
  assert.notEqual(baselineOptHashOf([], [], DEFAULT_SETTINGS),
    baselineOptHashOf([], [], { ...DEFAULT_SETTINGS, remnantsEnabled: true }));
});

test('search results refine consistently across grouping comparison references', async () => {
  const stocks = [{ id: 's', len: 132, wid: 48, qty: null, cost: null }];
  const parts = [{ id: 'p', label: 'P', len: 20, wid: 40, qty: 6, canTurn: false }];
  const found = await runSearch({ stocks, parts, settings: DEFAULT_SETTINGS, maxIters: 12, seed: 1 });
  const result = await refineResultCuts({ sol: found.sol, benchmark: { sol: found.sol },
    levelResults: [{ sol: found.sol, netYield: found.sol.stats.netYield }] }, DEFAULT_SETTINGS);
  assert.equal(result.sol, result.benchmark.sol);
  assert.equal(result.sol, result.levelResults[0].sol);
  assert.equal(result.sol.stats.cutCount, 7);
  assert.ok(result.sol.stats.cutCount <= found.sol.stats.cutCount);
});
