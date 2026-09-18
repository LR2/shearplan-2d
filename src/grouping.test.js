import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLevelResults, groupingAllowancePP } from './engine.js';
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
        usedArea: 90 / grossYield, remnantArea: 0, totalCost: 0, cutCount: 10 },
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

test('custom slider values interpolate caps and manual caps govern every comparison', () => {
  assert.equal(groupingAllowancePP({}), 5);
  assert.equal(groupingAllowancePP({ groupingAggression: 25 }), 1.25);
  assert.equal(groupingAllowancePP({ groupingAggression: 76 }), 5.12);
  const custom = levels(DEFAULT_SETTINGS, 76).find((level) => level.custom);
  assert.equal(custom.allowancePP, 5.12);
  assert.equal(custom.sig, '5.01');

  for (const [cap, selectedLoss] of [[4, '2.5'], [5, '5'], [6, '5.01']]) {
    const settings = { ...DEFAULT_SETTINGS, groupingAggression: 100, groupingMaxYieldLossPP: cap };
    assert.equal(groupingAllowancePP(settings), cap);
    assert.ok(levels(settings).every((level) => level.allowancePP === cap && level.sig === selectedLoss));
  }
});
