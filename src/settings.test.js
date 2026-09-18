import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, BLADE_PRESETS, presetSettings, matchingPreset } from './settings.js';

test('new jobs default to Strong grouping and remnants disabled', () => {
  assert.equal(DEFAULT_SETTINGS.groupingEnabled, true);
  assert.equal(DEFAULT_SETTINGS.groupingAggression, 75);
  assert.equal(DEFAULT_SETTINGS.remnantsEnabled, false);
});

test('all 15 spreadsheet presets apply both kerfs and all four edge trims', () => {
  assert.equal(BLADE_PRESETS.length, 15);
  for (const [index, preset] of BLADE_PRESETS.entries()) {
    const expectedKerf = index < 3 ? 0.1875 : index < 7 ? 0.375 : 0.5;
    const expectedTrim = index < 3 ? 0.25 : 0.5;
    const settings = { ...DEFAULT_SETTINGS, ...presetSettings(preset.id) };
    for (const key of ['kerfH', 'kerfV']) assert.equal(settings[key], expectedKerf);
    for (const key of ['trimL', 'trimR', 'trimT', 'trimB']) assert.equal(settings[key], expectedTrim);
    assert.equal(matchingPreset(settings), preset.id);
    assert.equal(matchingPreset({ ...settings, trimL: 0.123 }), '');
  }
});

test('saved jobs retain explicit settings, and Custom does not reset allowances', () => {
  const saved = { ...DEFAULT_SETTINGS, ...presetSettings('1-4'), groupingEnabled: false, remnantsEnabled: true };
  const loaded = { ...DEFAULT_SETTINGS, ...JSON.parse(JSON.stringify(saved)) };
  assert.equal(loaded.groupingEnabled, false);
  assert.equal(loaded.remnantsEnabled, true);
  assert.equal(matchingPreset(loaded), '1-4');
  const custom = { ...loaded, ...presetSettings('') };
  assert.equal(custom.kerfH, 0.375);
  assert.equal(matchingPreset(custom), '');
});
