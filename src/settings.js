export const DEFAULT_SETTINGS = {
  kerfH: 0, kerfV: 0,
  trimL: 0, trimR: 0, trimT: 0, trimB: 0,
  cutType: '3', firstCut: 'auto',
  remnantsEnabled: false,
  minRemL: 12, minRemW: 12, remRate: 50,
  effortSec: 10,
  dispFormat: 'frac', fracDen: 16,
  groupingEnabled: true,
  groupingAggression: 50,
  groupingMaxYieldLossPP: null,
  groupingMaxExtraSheets: 0,
  groupSingletonsLast: true,
  groupAllowFinalSheetFill: true,
  groupCompareLevels: true,
};

// Source: Blade and Edges Presets.xlsx, Sheet1!A2:C16. All values are inches.
export const BLADE_PRESETS = [
  { id: 'gauge', label: 'Gauge Material', kerf: 0.1875, trim: 0.25 },
  { id: '1-8', label: '1/8"', kerf: 0.1875, trim: 0.25 },
  { id: '3-16', label: '3/16"', kerf: 0.1875, trim: 0.25 },
  { id: '1-4', label: '1/4"', kerf: 0.375, trim: 0.5 },
  { id: '5-16', label: '5/16"', kerf: 0.375, trim: 0.5 },
  { id: '3-8', label: '3/8"', kerf: 0.375, trim: 0.5 },
  { id: '1-2', label: '1/2"', kerf: 0.375, trim: 0.5 },
  { id: '5-8', label: '5/8"', kerf: 0.5, trim: 0.5 },
  { id: '3-4', label: '3/4"', kerf: 0.5, trim: 0.5 },
  { id: '7-8', label: '7/8"', kerf: 0.5, trim: 0.5 },
  { id: '1', label: '1"', kerf: 0.5, trim: 0.5 },
  { id: '1.25', label: '1.25"', kerf: 0.5, trim: 0.5 },
  { id: '1.5', label: '1.5"', kerf: 0.5, trim: 0.5 },
  { id: '1.75', label: '1.75"', kerf: 0.5, trim: 0.5 },
  { id: '2', label: '2"', kerf: 0.5, trim: 0.5 },
];

export function presetSettings(id) {
  const preset = BLADE_PRESETS.find((p) => p.id === id);
  if (!preset) return { bladePresetId: '' };
  return { bladePresetId: id, kerfH: preset.kerf, kerfV: preset.kerf,
    trimL: preset.trim, trimR: preset.trim, trimT: preset.trim, trimB: preset.trim };
}

export function matchingPreset(settings) {
  const preset = BLADE_PRESETS.find((p) => p.id === settings.bladePresetId);
  return preset && ['kerfH', 'kerfV'].every((k) => settings[k] === preset.kerf) &&
    ['trimL', 'trimR', 'trimT', 'trimB'].every((k) => settings[k] === preset.trim) ? preset.id : '';
}
