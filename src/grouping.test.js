import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLevelResults, groupingAllowancePP, selectForAllowance,
  archiveConsider, fmtYieldDeltaPP } from './engine.js';
import { DEFAULT_SETTINGS } from './settings.js';

// Every candidate places the same parts on one blank. Progressively better
// grouping uses more material, so selection must respect each loss cap.
function candidate(lossPP, touches) {
  const grossYield = 0.9 - lossPP / 100;
  return {
    sig: String(lossPP), source: 'fixture', placedCount: 10,
    sol: {
      uncutCount: 0, fitness: [0, 90 / grossYield],
      stats: { grossYield, netYield: grossYield, sheetsUsed: 1,
        usedArea: 90 / grossYield, remnantArea: 0, totalCost: 0, cutCount: 10, totalGaugeSettings: 5 },
    },
    metrics: {
      families: [],
      plan: { hardPolicyViolations: 0, weightedExcessTouches: touches,
        familiesAboveBestKnownMinimum: 0, familyRunBreaks: 0,
        singletonEarlyCount: 0, familySheetTouches: touches,
        familiesAtBestKnownMinimum: 0 },
    },
  };
}

const archive = [0, 2.5, 5, 5.01, 8, 8.01].map((loss, i) => candidate(loss, 10 - i));
const benchmark = archive[0];
const levels = (settings = DEFAULT_SETTINGS, sliderAggression = settings.groupingAggression) =>
  buildLevelResults({ archive, benchmark, settings, sliderAggression, ktRequired: false });

test('grouping presets select the best candidate within the 0, 2.5, 5 and 8 pp caps', () => {
  const results = levels();
  assert.deepEqual(results.map((level) => [level.label, level.allowancePP, level.sig]), [
    ['Yield First', 0, '0'],
    ['Balanced', 2.5, '2.5'],
    ['Strong', 5, '5'],
    ['Ultra', 8, '8'],
  ]);
  assert.equal(results.find((level) => level.aggression === DEFAULT_SETTINGS.groupingAggression).label, 'Strong');
});

test('custom slider values interpolate caps; manual caps do not relax Yield First', () => {
  assert.equal(groupingAllowancePP({}), 5);
  assert.equal(groupingAllowancePP({ groupingAggression: 25 }), 1.25);
  assert.equal(groupingAllowancePP({ groupingAggression: 76 }), 5.12);
  const custom = levels(DEFAULT_SETTINGS, 76).find((level) => level.custom);
  assert.equal(custom.allowancePP, 5.12);
  assert.equal(custom.sig, '5.01');

  for (const [cap, selectedLoss] of [[4, '2.5'], [5, '5'], [6, '5.01']]) {
    const settings = { ...DEFAULT_SETTINGS, groupingAggression: 100, groupingMaxYieldLossPP: cap };
    assert.equal(groupingAllowancePP(settings), cap);
    const results = levels(settings);
    assert.equal(results[0].allowancePP, 0);
    assert.equal(results[0].sig, '0');
    assert.ok(results.slice(1).every((level) => level.allowancePP === cap && level.sig === selectedLoss));
  }
});

test('Yield First selects the highest gross yield across both searches, ahead of grouping, net yield and cost', () => {
  const higher = { ...candidate(-4, 9), source: 'grouped' };
  const easier = { ...candidate(-1, 1), source: 'grouped' };
  easier.sol.stats.netYield = 0.99;
  easier.sol.fitness[1] = 1;
  const results = buildLevelResults({ archive: [benchmark, easier, higher], benchmark,
    settings: DEFAULT_SETTINGS, sliderAggression: 75, ktRequired: false });
  assert.equal(results[0].sig, higher.sig);
  assert.equal(results[0].yieldLossPP.toFixed(2), '-4.00');
  assert.ok(results.every((l) => l.grossYield <= results[0].grossYield));
  assert.equal(results.at(-1).sig, easier.sig);
});

test('equal-yield candidates use grouping, cuts, then gauge settings to break ties', () => {
  const choices = [candidate(-1, 5), candidate(-1, 2), candidate(-1, 2), candidate(-1, 2)]
    .map((c, i) => ({ ...c, sig: 'tie-' + i }));
  choices[0].sol.stats.cutCount = 1;
  choices[1].sol.stats.cutCount = 12;
  choices[2].sol.stats.totalGaugeSettings = 4;
  choices[3].sol.stats.totalGaugeSettings = 3;
  for (let n = 2; n <= choices.length; n++) {
    const sel = selectForAllowance(choices.slice(0, n), 0, 0, benchmark, { yieldFirst: true });
    assert.equal(sel.cand.sig, choices[n - 1].sig);
  }
});

test('Yield First respects quantities, extra-sheet limits and hard Keep Together', () => {
  const winner = candidate(-1, 7);
  const incomplete = candidate(-8, 1);
  incomplete.placedCount = 9; incomplete.sol.uncutCount = 1;
  const tooManySheets = candidate(-7, 1);
  tooManySheets.sol.stats.sheetsUsed = 2;
  const brokenPolicy = candidate(-6, 1);
  brokenPolicy.metrics.plan.hardPolicyViolations = 1;
  const sel = selectForAllowance([benchmark, incomplete, tooManySheets, brokenPolicy, winner],
    0, 0, benchmark, { yieldFirst: true, ktRequired: true });
  assert.equal(sel.cand, winner);
  assert.equal(sel.comparisonValid, true);
  assert.equal(sel.relaxedForKT, false);

  const hardBaseline = candidate(0, 10);
  hardBaseline.metrics.plan.hardPolicyViolations = 1;
  const compliant = candidate(1, 5);
  const relaxed = selectForAllowance([hardBaseline, compliant], 0, 0, hardBaseline,
    { yieldFirst: true, ktRequired: true });
  assert.equal(relaxed.cand, compliant);
  assert.equal(relaxed.relaxedForKT, true);
});

test('archive pruning preserves the Yield First winner despite better-grouped alternatives', () => {
  const retained = [benchmark];
  const highest = { ...candidate(-4, 20), source: 'grouped' };
  const protect = (pool) => buildLevelResults({ archive: pool, benchmark,
    settings: DEFAULT_SETTINGS, sliderAggression: 75, ktRequired: false }).map((l) => l.sig);
  for (const c of [highest, ...Array.from({ length: 20 }, (_, i) => ({
    ...candidate(-3 + i / 10, 19 - i / 2), source: 'grouped',
  }))]) archiveConsider(retained, c, { limit: 4, protect });
  assert.ok(retained.includes(highest));
  assert.equal(selectForAllowance(retained, 0, 0, benchmark, { yieldFirst: true }).cand, highest);
});

test('yield changes display gains, losses and zero consistently in results and reports', () => {
  assert.equal(fmtYieldDeltaPP(-0.1086968), '+0.11 pp');
  assert.equal(fmtYieldDeltaPP(2.9476774), '−2.95 pp');
  assert.equal(fmtYieldDeltaPP(-0.00001), '±0.00 pp');
  assert.equal(fmtYieldDeltaPP(null), '—');
});
