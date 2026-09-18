import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { optimizeSheetLayout } from './sheet-optimizer.js';
import { rebuildCutTree, cutTreeScore } from './cut-optimizer.js';
import { CUT_TYPES, decodeSheet, sequenceCuts, finalizePlan, optimizeSolutionCuts, refineResultCuts,
  runSearch, buildLevelResults, analyzeGrouping, mulberry32 } from './engine.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { close, validate } from './test-utils/geometry.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mixed-family-sheet.json', import.meta.url)));
const options = (extra = {}) => ({ ...DEFAULT_SETTINGS, ...CUT_TYPES['3'], ...extra });
function suppliedSheet(opt = options()) {
  const placements = fixture.placements.map((p) => ({ ...p,
    label: fixture.parts.find((part) => part.id === p.pid).label, canTurn: true }));
  return rebuildCutTree({ root: { x: 0, y: 0, l: 120, w: 48 }, placements,
    frees: [], placedKeys: new Set(placements.map((p) => p.key)) }, opt);
}
const counts = (sheet) => [...sheet.sourceTree.placedKeys].sort();

test('the supplied mixed-family sheet improves from 18 cuts to 12 without changing yield', () => {
  const opt = options();
  const original = suppliedSheet(opt);
  assert.equal(original.cutsRaw.length, 18);
  const next = optimizeSheetLayout(original, opt, decodeSheet);
  validate(original, next, opt, { allowMoves: true });
  const [cuts, travel, gauges] = cutTreeScore(next);
  assert.equal(cuts, fixture.cutlogicReference.cuts);
  assert.ok(travel <= fixture.cutlogicReference.cutLength);
  assert.ok(gauges <= 8);
  assert.ok(next.placements.filter((p) => p.pid === 'c').every((p) => p.rot && p.w === 12));
  assert.equal(next.placements.reduce((sum, p) => sum + p.l * p.w, 0), 5272);
  assert.ok(next.cutsRaw.every((n) => n.cut.stage <= 3));
  const sol = finalizePlan([fixture.stock], [], [{ stock: fixture.stock, res: original, placedArea: 5272 }], opt);
  const refined = optimizeSolutionCuts(sol, opt);
  close(refined.stats.grossYield, 5272 / 5760);
  assert.equal(refined.stats.usedArea, sol.stats.usedArea);
  assert.equal(refined.stats.cutCount, 12);
  assert.notEqual(refined.sheets[0].sig, sol.sheets[0].sig);
  assert.equal(refined.runs[0].layout, refined.sheets[0]);
  assert.equal(refined.groups[0].layout, refined.sheets[0]);
  assert.equal(refined.sheets[0].cuts.length, next.cutsRaw.length);
});

test('repacking preserves parts and restrictions for every stage type, kerf and rotation lock', () => {
  const rng = mulberry32(9418);
  for (const cutType of Object.keys(CUT_TYPES)) {
    for (const firstCut of ['h', 'v', 'auto']) {
      const opt = options({ ...CUT_TYPES[cutType], cutType, firstCut, kerfH: 0.1875, kerfV: 0.375,
        remnantsEnabled: firstCut === 'v', minRemL: 6, minRemW: 6 });
      const instances = Array.from({ length: 15 }, (_, i) => ({
        pid: `p${i % 4}`, key: `p${i}`, label: `P${i % 4}`,
        l: 8 + Math.floor(rng() * 25), w: 6 + Math.floor(rng() * 15), canTurn: i % 3 !== 0,
      }));
      const original = decodeSheet({ uL: 119, uW: 47 }, instances,
        { ...opt, firstCut: firstCut === 'auto' ? null : firstCut, choice: 'BSSF', splitPref: 'best' });
      const next = optimizeSheetLayout(original, opt, decodeSheet);
      validate(original, next, opt, { allowMoves: true });
      for (const p of original.placements.filter((p) => !p.canTurn)) {
        assert.equal(next.placements.find((q) => q.key === p.key).rot, false);
      }
      if (opt.remnantsEnabled) for (const f of original.frees.filter((f) => !f.dead && Math.min(f.l, f.w) >= 6)) {
        assert.ok(next.frees.some((g) => !g.dead && g.x <= f.x + 1e-5 && g.y <= f.y + 1e-5 &&
          g.x + g.l >= f.x + f.l - 1e-5 && g.y + g.w >= f.y + f.w - 1e-5));
      }
    }
  }
});

test('existing saved drops remain intact and report coordinates include edge trims', () => {
  const opt = options({ remnantsEnabled: true, minRemL: 6, minRemW: 6,
    trimL: 1, trimR: 2, trimT: 0.5, trimB: 1.5, kerfH: 0.25, kerfV: 0.375 });
  const stock = { id: 's', len: 120, wid: 48, qty: 1, cost: 100 };
  const insts = Array.from({ length: 6 }, (_, i) => ({ key: `p#${i}`, pid: 'p', label: 'P', l: 20, w: 30, canTurn: true }));
  const original = decodeSheet({ uL: 117, uW: 46 }, insts,
    { ...opt, firstCut: 'v', splitPref: 'v', choice: 'BSSF' });
  const sol = finalizePlan([stock], [], [{ stock, res: original, placedArea: original.placements.length * 600 }], opt);
  const next = optimizeSolutionCuts(sol, opt);
  const tree = next.sheets[0].sourceTree;
  validate(original, tree, opt, { allowMoves: true });
  for (const f of original.frees.filter((f) => !f.dead && Math.min(f.l, f.w) >= 6)) {
    assert.ok(tree.frees.some((g) => g.x <= f.x + 1e-5 && g.y <= f.y + 1e-5 &&
      g.x + g.l >= f.x + f.l - 1e-5 && g.y + g.w >= f.y + f.w - 1e-5));
  }
  assert.ok(next.stats.remnantArea >= sol.stats.remnantArea - 1e-5);
  assert.equal(next.stats.totalCost, 100);
  const view = next.sheets[0];
  for (const [i, p] of tree.placements.entries()) {
    close(view.placements[i].x, p.x + opt.trimL);
    close(view.placements[i].y, p.y + opt.trimT);
  }
  assert.deepEqual(view.cuts, sequenceCuts(tree, { ...opt, ox: opt.trimL, oy: opt.trimT }).rows);
});

test('identical sheet layouts retain their own instance keys and merge into valid production runs', () => {
  const opt = options();
  const original = suppliedSheet(opt);
  const second = rebuildCutTree({ ...original,
    placements: original.placements.map((p) => ({ ...p, key: `${p.key}-second` })),
    placedKeys: new Set(original.placements.map((p) => `${p.key}-second`)) }, opt);
  const sheets = [original, second].map((res) => ({ stock: fixture.stock, res, placedArea: 5272 }));
  const sol = finalizePlan([fixture.stock], [], sheets, opt);
  sol.runs[0].cleanup = true;
  const next = optimizeSolutionCuts(sol, opt);
  assert.deepEqual(next.sheets.map(counts), sol.sheets.map(counts));
  assert.equal(next.runs.length, 1);
  assert.equal(next.runs[0].repeat, 2);
  assert.equal(next.runs[0].cleanup, true);
  assert.equal(next.groups[0].repeat, 2);
  assert.equal(next.stats.cutCount, 24);
});

test('the full grouped example retains sheet assignments and grouping metrics at every level', async () => {
  const stocks = [fixture.stock, { id: 's96', len: 96, wid: 48, qty: 10, cost: null }].map((s, i) => ({ ...s, qty: i ? 10 : null }));
  const parts = fixture.parts.map((p) => ({ ...p, qty: p.id === 'p' ? 8 : p.id === 'w' ? 20 : 40 }))
    .concat([{ id: 'r', label: 'RUNNER', len: 60, wid: 10, qty: 12, canTurn: false, groupPolicy: 'keepTogether' },
      { id: 'pan', label: 'PAN', len: 24, wid: 24, qty: 6, canTurn: true }]);
  const settings = { ...DEFAULT_SETTINGS };
  const baseline = await runSearch({ stocks, parts, settings, mode: 'baseline', seed: 31, maxIters: 32 });
  const grouped = await runSearch({ stocks, parts, settings, mode: 'grouped', seed: 31, maxIters: 40,
    baseline: { baselineSol: baseline.sol, bestGrossYieldSol: baseline.bestGrossYieldSol } });
  const levels = buildLevelResults({ archive: grouped.archive, benchmark: grouped.benchmark,
    settings, sliderAggression: 75, ktRequired: true });
  const active = levels.find((l) => l.aggression === 75).sol;
  const progress = [];
  const next = await refineResultCuts({ sol: active, benchmark: grouped.benchmark, levelResults: levels }, settings,
    { onProgress: (p) => progress.push(p) });
  assert.ok(progress.length > 0);
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  assert.equal(next.sol, next.levelResults.find((l) => l.aggression === 75).sol);
  for (const [i, level] of next.levelResults.entries()) {
    const before = levels[i].sol, after = level.sol;
    assert.equal(after.uncutCount, 0);
    assert.equal(after.stats.placedArea, before.stats.placedArea);
    assert.equal(after.stats.usedArea, before.stats.usedArea);
    assert.equal(after.stats.grossYield, before.stats.grossYield);
    assert.deepEqual(after.sheets.map(counts), before.sheets.map(counts));
    assert.deepEqual(after.sheets.map((s) => s.stock.id), before.sheets.map((s) => s.stock.id));
    assert.ok(after.stats.cutCount <= before.stats.cutCount);
    const metrics = analyzeGrouping(after, grouped.families.families, grouped.idealByPid,
      { ktPids: grouped.families.ktPids, cleanupPids: grouped.families.cleanupPids });
    assert.deepEqual(metrics.plan, levels[i].groupingMetrics.plan);
    for (const [j, sheet] of after.sheets.entries()) validate(before.sheets[j].sourceTree,
      sheet.sourceTree, options(), { allowMoves: true });
  }
});

test('stopping refinement keeps a complete valid result and a zero search budget preserves the layout', async () => {
  const opt = options();
  const original = suppliedSheet(opt);
  const bounded = optimizeSheetLayout(original, { ...opt, maxPackingTrials: 0 }, decodeSheet);
  validate(original, bounded, opt);
  const sol = finalizePlan([fixture.stock], [], [{ stock: fixture.stock, res: original, placedArea: 5272 }], opt);
  const stopped = await refineResultCuts({ sol }, opt, { shouldStop: () => true });
  assert.equal(stopped.sol.sheets[0], sol.sheets[0]);
  assert.equal(stopped.sol.stats.cutCount, 18);
});
