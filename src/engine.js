import { orderCutNodes } from './cut-optimizer.js';
import { optimizeSheetLayout } from './sheet-optimizer.js';
import { DEFAULT_SETTINGS } from './settings.js';

// ============================================================================
// ShearPlan 2D — core engine (pure JS, no DOM)
// Guillotine cutting optimizer for rectangular parts on rectangular blanks.
// Units: decimal inches internally. Coordinates: x→right, y→down, origin at
// top-left of the usable area of a blank.
// Cut directions: 'h' = horizontal cut line (separates top/bottom, kerfH),
//                 'v' = vertical cut line (separates left/right, kerfV).
// ============================================================================

export const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Dimension parsing & formatting (inches, fractions, feet-inches)
// ---------------------------------------------------------------------------

export function parseDim(input) {
  if (input == null) return NaN;
  if (typeof input === 'number') return isFinite(input) && input >= 0 ? input : NaN;
  let t = String(input).trim().toLowerCase();
  if (!t) return NaN;
  t = t.replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'");
  t = t.replace(/(\d)\s*(ft|feet|foot)\b\.?/g, "$1'");
  t = t.replace(/(\d)\s*(in|inch|inches)\b\.?/g, '$1"');
  let feet = 0;
  let rest = t;
  const fm = t.match(/^(\d+(?:\.\d+)?)\s*'\s*-?\s*(.*)$/);
  if (fm) {
    feet = parseFloat(fm[1]);
    rest = fm[2] || '';
  }
  rest = rest.replace(/"/g, '').trim();
  let inches = 0;
  if (rest) {
    rest = rest.replace(/(\d)\s*-\s*(?=\d+\s*\/\s*\d+)/g, '$1 '); // 6-1/2 -> 6 1/2
    const chunks = rest.split(/\s+/).filter(Boolean);
    for (const c of chunks) {
      const frac = c.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (frac) {
        const den = parseInt(frac[2], 10);
        if (!den) return NaN;
        inches += parseInt(frac[1], 10) / den;
      } else if (/^\d*\.?\d+$/.test(c)) {
        inches += parseFloat(c);
      } else {
        return NaN;
      }
    }
  }
  const v = feet * 12 + inches;
  return isFinite(v) && v >= 0 ? v : NaN;
}

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

export function fmtDim(x, fmt = { dispFormat: 'frac', fracDen: 16 }) {
  if (x == null || !isFinite(x)) return '—';
  const den = fmt.fracDen || 16;
  if (fmt.dispFormat === 'dec') {
    const r = Math.round(x * 1000) / 1000;
    return `${r}"`;
  }
  let units = Math.round(x * den);
  const whole0 = Math.floor(units / den);
  const num0 = units % den;
  let fracStr = '';
  if (num0) {
    const g = gcd(num0, den);
    fracStr = `${num0 / g}/${den / g}`;
  }
  if (fmt.dispFormat === 'ftin') {
    const ft = Math.floor(whole0 / 12);
    const inch = whole0 % 12;
    if (ft === 0) {
      if (!inch && !fracStr) return `0"`;
      return `${inch ? inch : ''}${inch && fracStr ? ' ' : ''}${fracStr}"`;
    }
    let s = `${ft}'`;
    if (inch || fracStr) {
      s += `-${inch ? inch : fracStr && !inch ? '0' : ''}${inch && fracStr ? ' ' : ''}${!inch && fracStr ? ' ' + fracStr : inch && fracStr ? fracStr : ''}"`;
      // normalize: cases -> 4'-6", 4'-6 1/2", 4'-0 1/2"
      s = s.replace("-0 ", "-0 ").replace("' -", "'-");
    } else {
      s += `-0"`;
    }
    return s;
  }
  // fractional inches
  if (!whole0 && !fracStr) return `0"`;
  return `${whole0 ? whole0 : ''}${whole0 && fracStr ? ' ' : ''}${fracStr}"`;
}

export function fmtArea(sqIn) {
  if (!isFinite(sqIn)) return '—';
  const sqFt = sqIn / 144;
  return sqFt >= 10 ? `${sqFt.toFixed(1)} ft²` : `${sqFt.toFixed(2)} ft²`;
}

// ---------------------------------------------------------------------------
// Cutting types → stage limits
// ---------------------------------------------------------------------------
// stage of a cut: 1 for the first cut direction on the blank; +1 each time
// direction alternates going down the tree; same-direction re-cuts of a piece
// stay in the same stage (they are co-planar with sheet-level rips).
// half=true (x.5 types): a cut is allowed AT maxStage only when it directly
// separates a finished part, and the offcut it produces is frozen (no reuse).

export const CUT_TYPES = {
  free: { label: 'Guillotine — unlimited stages (best yield)', maxStage: 99, half: false },
  '3.5': { label: '3.5 stages (3 stages + finishing trim)', maxStage: 4, half: true },
  '3': { label: '3 stages (rip → cross-cut → trim)', maxStage: 3, half: false },
  '2.5': { label: '2.5 stages (2 stages + finishing trim)', maxStage: 3, half: true },
  '2': { label: '2 stages (rip strips → chop to length)', maxStage: 2, half: false },
};

// ---------------------------------------------------------------------------
// Single-blank decoder
// ---------------------------------------------------------------------------
// stockDims: {uL, uW} usable length/width (after trims)
// insts: array of {key, pid, label, l, w, canTurn} in placement-attempt order
// opt: {kerfH, kerfV, maxStage, half, firstCut: 'h'|'v'|null, choice:'BSSF'|'BAF', splitPref:'v'|'h'|'best'}
// Returns { placements, cutsRaw, frees, placedKeys, root } or null if unusable.

function stageOf(node, dir) {
  return node.cdir === null ? 1 : dir === node.cdir ? node.stage : node.stage + 1;
}

export function decodeSheet(stockDims, insts, opt) {
  const { uL, uW } = stockDims;
  if (uL <= EPS || uW <= EPS) return null;
  const { kerfH, kerfV, maxStage, half } = opt;
  let nid = 0;
  let cutIdx = 0;
  const root = { id: nid++, x: 0, y: 0, l: uL, w: uW, cdir: null, stage: 0, kind: 'free', dead: false };
  const frees = [root];
  const cutsRaw = [];
  const placements = [];
  const placedKeys = new Set();

  const stageAllowed = (s, yieldsPart) => {
    if (s > maxStage) return false;
    if (half && s === maxStage && !yieldsPart) return false;
    return true;
  };

  // Split node F with a cut; gauge child is nearest origin. Returns [gaugeChild, restChild|null]
  const doCut = (F, dir, gauge, s) => {
    const kerf = dir === 'h' ? kerfH : kerfV;
    let g, r;
    if (dir === 'h') {
      g = { id: nid++, x: F.x, y: F.y, l: F.l, w: gauge, cdir: dir, stage: s, kind: 'free', dead: false };
      const rw = F.w - gauge - kerf;
      r = rw > EPS ? { id: nid++, x: F.x, y: F.y + gauge + kerf, l: F.l, w: rw, cdir: dir, stage: s, kind: 'free', dead: false } : null;
    } else {
      g = { id: nid++, x: F.x, y: F.y, l: gauge, w: F.w, cdir: dir, stage: s, kind: 'free', dead: false };
      const rl = F.l - gauge - kerf;
      r = rl > EPS ? { id: nid++, x: F.x + gauge + kerf, y: F.y, l: rl, w: F.w, cdir: dir, stage: s, kind: 'free', dead: false } : null;
    }
    F.kind = 'int';
    F.cut = { dir, gauge, stage: s, ci: cutIdx++, node: F };
    F.kids = [g, r];
    cutsRaw.push(F);
    return [g, r];
  };

  const removeFree = (F) => {
    const i = frees.indexOf(F);
    if (i >= 0) frees.splice(i, 1);
  };

  const markPart = (node, inst, rot) => {
    node.kind = 'part';
    node.part = { pid: inst.pid, label: inst.label, key: inst.key, rot, canTurn: !!inst.canTurn };
    placements.push({ x: node.x, y: node.y, l: node.l, w: node.w, ...node.part, node });
  };

  // Evaluate placing (pl,pw) into F. Returns plan or null.
  const planFor = (F, pl, pw) => {
    if (pl > F.l + EPS || pw > F.w + EPS) return null;
    const exactL = Math.abs(F.l - pl) < EPS;
    const exactW = Math.abs(F.w - pw) < EPS;
    const rootLock = (dir) => !(F.cdir === null && opt.firstCut && dir !== opt.firstCut);
    if (exactL && exactW) return { kind: 'exact' };
    if (exactL) { // spans full length → single horizontal cut at pw
      const s = stageOf(F, 'h');
      if (!rootLock('h') || !stageAllowed(s, true)) return null;
      return { kind: 'one', dir: 'h', s };
    }
    if (exactW) {
      const s = stageOf(F, 'v');
      if (!rootLock('v') || !stageAllowed(s, true)) return null;
      return { kind: 'one', dir: 'v', s };
    }
    // two cuts; option A: first 'v' (column of width pl, then trim height)
    const opts = [];
    {
      const s1 = stageOf(F, 'v');
      const s2 = s1 + 1;
      if (rootLock('v') && stageAllowed(s1, false) && stageAllowed(s2, true)) {
        const areaRest = Math.max(0, F.l - pl - kerfV) * F.w;
        const areaTop = pl * Math.max(0, F.w - pw - kerfH);
        opts.push({ kind: 'two', first: 'v', s1, s2, maxChild: Math.max(areaRest, areaTop) });
      }
    }
    {
      const s1 = stageOf(F, 'h');
      const s2 = s1 + 1;
      if (rootLock('h') && stageAllowed(s1, false) && stageAllowed(s2, true)) {
        const areaRest = Math.max(0, F.w - pw - kerfH) * F.l;
        const areaSide = pw * Math.max(0, F.l - pl - kerfV);
        opts.push({ kind: 'two', first: 'h', s1, s2, maxChild: Math.max(areaRest, areaSide) });
      }
    }
    if (!opts.length) return null;
    if (opts.length === 1) return opts[0];
    if (opt.splitPref === 'v') return opts.find((o) => o.first === 'v') || opts[0];
    if (opt.splitPref === 'h') return opts.find((o) => o.first === 'h') || opts[0];
    return opts[0].maxChild >= opts[1].maxChild ? opts[0] : opts[1];
  };

  const applyPlan = (F, inst, pl, pw, rot, plan) => {
    removeFree(F);
    if (plan.kind === 'exact') {
      markPart(F, inst, rot);
      return;
    }
    if (plan.kind === 'one') {
      const gauge = plan.dir === 'h' ? pw : pl;
      const [g, r] = doCut(F, plan.dir, gauge, plan.s);
      markPart(g, inst, rot);
      if (r) {
        if (half && plan.s === maxStage) r.dead = true;
        frees.push(r);
      }
      return;
    }
    // two cuts
    if (plan.first === 'v') {
      const [col, rest] = doCut(F, 'v', pl, plan.s1);
      if (rest) frees.push(rest);
      const [g, off] = doCut(col, 'h', pw, plan.s2);
      markPart(g, inst, rot);
      if (off) {
        if (half && plan.s2 === maxStage) off.dead = true;
        frees.push(off);
      }
    } else {
      const [row, rest] = doCut(F, 'h', pw, plan.s1);
      if (rest) frees.push(rest);
      const [g, off] = doCut(row, 'v', pl, plan.s2);
      markPart(g, inst, rot);
      if (off) {
        if (half && plan.s2 === maxStage) off.dead = true;
        frees.push(off);
      }
    }
  };

  for (const inst of insts) {
    let best = null;
    const orients = inst.canTurn && Math.abs(inst.l - inst.w) > EPS
      ? [[inst.l, inst.w, false], [inst.w, inst.l, true]]
      : [[inst.l, inst.w, false]];
    for (const F of frees) {
      if (F.dead) continue;
      for (const [pl, pw, rot] of orients) {
        const plan = planFor(F, pl, pw);
        if (!plan) continue;
        const exactL = Math.abs(F.l - pl) < EPS;
        const exactW = Math.abs(F.w - pw) < EPS;
        let score;
        if (exactL && exactW) score = -1e12;
        else if (exactL || exactW) score = -1e9 + (opt.choice === 'BAF' ? F.l * F.w - pl * pw : Math.min(F.l - pl, F.w - pw));
        else score = opt.choice === 'BAF' ? F.l * F.w - pl * pw : Math.min(F.l - pl, F.w - pw);
        if (!best || score < best.score - EPS ||
          (Math.abs(score - best.score) <= EPS && F.stage > best.F.stage)) {
          best = { score, F, pl, pw, rot, plan };
        }
      }
    }
    if (best) {
      applyPlan(best.F, inst, best.pl, best.pw, best.rot, best.plan);
      placedKeys.add(inst.key);
    }
  }

  return { placements, cutsRaw, frees, placedKeys, root };
}

// ---------------------------------------------------------------------------
// Cut sequencing — turn the cut tree into an operator-readable ordered list
// ---------------------------------------------------------------------------

function pieceLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    i -= 1;
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26);
  }
  return s;
}

export function sequenceCuts(sheetRes, ctx) {
  // ctx: { minRemL, minRemW, ox, oy } offsets of usable area within blank
  const sorted = orderCutNodes(sheetRes);
  const names = new Map();
  names.set(sheetRes.root.id, 'BLANK');
  let letterIdx = 0;
  const rows = [];
  const isRem = (n) => {
    if (!ctx.remnantsEnabled || n.dead) return false;
    const a = Math.max(n.l, n.w), b = Math.min(n.l, n.w);
    const ra = Math.max(ctx.minRemL, ctx.minRemW), rb = Math.min(ctx.minRemL, ctx.minRemW);
    return a >= ra - EPS && b >= rb - EPS;
  };
  const describeLeaf = (n) =>
    n.kind === 'part' ? { type: 'part', label: n.part.label, rot: n.part.rot }
      : { type: isRem(n) ? 'remnant' : 'scrap' };

  let seq = 0;
  for (const node of sorted) {
    const { dir, gauge, stage } = node.cut;
    const [g, r] = node.kids;
    const pieceName = names.get(node.id) || '?';
    // name gauge child
    let resultName, resultInfo;
    if (g.kind === 'part') {
      resultName = g.part.label;
      resultInfo = describeLeaf(g);
    } else if (g.kind === 'int') {
      resultName = pieceLetter(letterIdx++);
      names.set(g.id, resultName);
      resultInfo = { type: 'piece' };
    } else { // free leaf as gauge child (shouldn't normally happen — gauge side is part/col)
      resultName = '';
      resultInfo = describeLeaf(g);
    }
    // remainder keeps parent name
    let remInfo = null;
    if (r) {
      names.set(r.id, pieceName);
      remInfo = r.kind === 'int' ? { type: 'piece' } : describeLeaf(r);
    }
    seq += 1;
    rows.push({
      seq, stage, dir, gauge,
      pieceName,
      pieceL: node.l, pieceW: node.w,
      pieceRect: { x: node.x + ctx.ox, y: node.y + ctx.oy, l: node.l, w: node.w },
      linePos: dir === 'h' ? node.y + gauge + ctx.oy : node.x + gauge + ctx.ox,
      resultName, resultDims: { l: g.l, w: g.w }, resultInfo,
      remName: r ? pieceName : null,
      remDims: r ? { l: r.l, w: r.w } : null,
      remInfo,
    });
  }
  // gauge-change count: consecutive rows with same (dir, gauge, stage) share a setting
  let gaugeSettings = 0;
  let prev = null;
  for (const row of rows) {
    if (!prev || prev.dir !== row.dir || Math.abs(prev.gauge - row.gauge) > EPS) gaugeSettings += 1;
    prev = row;
  }
  return { rows, gaugeSettings };
}

// ---------------------------------------------------------------------------
// Full-plan decoding (multi-blank, stock selection, qty limits)
// ---------------------------------------------------------------------------

export function expandInstances(parts) {
  const arr = [];
  for (const p of parts) {
    const q = Math.max(0, Math.floor(p.qty || 0));
    for (let i = 0; i < q; i++) {
      arr.push({ key: `${p.id}#${i}`, pid: p.id, label: p.label, l: p.len, w: p.wid, canTurn: !!p.canTurn });
    }
  }
  return arr;
}

export function decodePlan(stocks, orderedInsts, settings, variant) {
  const { kerfH, kerfV, trimL, trimR, trimT, trimB, cutType, minRemL, minRemW } = settings;
  const { maxStage, half } = CUT_TYPES[cutType] || CUT_TYPES['3'];
  const qtyLeft = new Map();
  for (const s of stocks) qtyLeft.set(s.id, s.qty == null ? Infinity : Math.max(0, Math.floor(s.qty)));
  const costMode = stocks.length > 0 && stocks.every((s) => s.cost != null && isFinite(s.cost));
  const costOf = (s) => (costMode ? s.cost : s.len * s.wid);

  let remaining = orderedInsts.slice();
  const sheets = [];
  let guard = 0;
  while (remaining.length && guard++ < 800) {
    let best = null;
    for (const s of stocks) {
      if ((qtyLeft.get(s.id) || 0) <= 0) continue;
      const uL = s.len - trimL - trimR;
      const uW = s.wid - trimT - trimB;
      if (uL <= EPS || uW <= EPS) continue;
      const res = decodeSheet({ uL, uW }, remaining, {
        kerfH, kerfV, maxStage, half,
        firstCut: variant.firstCut, choice: variant.choice, splitPref: variant.splitPref,
      });
      if (!res || res.placements.length === 0) continue;
      const placedArea = res.placements.reduce((a, p) => a + p.l * p.w, 0);
      const finishes = res.placements.length === remaining.length;
      const cost = costOf(s);
      const cand = { s, res, placedArea, finishes, cost, value: placedArea / Math.max(cost, EPS) };
      if (!best) best = cand;
      else if (cand.finishes !== best.finishes) { if (cand.finishes) best = cand; }
      else if (cand.finishes) { if (cand.cost < best.cost - EPS || (Math.abs(cand.cost - best.cost) <= EPS && cand.placedArea > best.placedArea)) best = cand; }
      else if (cand.value > best.value + 1e-12 || (Math.abs(cand.value - best.value) <= 1e-12 && cand.placedArea > best.placedArea)) best = cand;
    }
    if (!best) break;
    qtyLeft.set(best.s.id, (qtyLeft.get(best.s.id) || 0) - 1);
    remaining = remaining.filter((i) => !best.res.placedKeys.has(i.key));
    sheets.push({ stock: best.s, res: best.res, placedArea: best.placedArea });
  }

  return finalizePlan(stocks, remaining, sheets, settings);
}

// Shared post-processing for decodePlan and decodePlanGrouped: classify
// offcuts, compute stats, sequence cuts, group identical layouts, and build
// production runs (adjacent identical sheets merged, production order kept).
function layoutSignature(stock, placements) {
  return stock.id + '|' + placements
    .map((p) => [p.x, p.y, p.l, p.w, p.pid].map((v) => typeof v === 'number' ? Math.round(v * 1e4) : v).join(','))
    .sort().join(';');
}

export function finalizePlan(stocks, remaining, sheets, settings) {
  const { trimL, trimR, trimT, trimB, minRemL, minRemW } = settings;
  const costMode = stocks.length > 0 && stocks.every((s) => s.cost != null && isFinite(s.cost));
  const costOf = (s) => (costMode ? s.cost : s.len * s.wid);

  // classify offcuts, compute stats, sequence cuts, group repeats
  const isRem = (l, w) => {
    if (!settings.remnantsEnabled) return false;
    const a = Math.max(l, w), b = Math.min(l, w);
    const ra = Math.max(minRemL, minRemW), rb = Math.min(minRemL, minRemW);
    return a >= ra - EPS && b >= rb - EPS;
  };
  let usedArea = 0, placedArea = 0, remnantArea = 0, cutCount = 0;
  const sheetViews = sheets.map((sh) => {
    const { stock, res } = sh;
    const ox = trimL, oy = trimT;
    const offcuts = res.frees.map((f) => ({
      x: f.x + ox, y: f.y + oy, l: f.l, w: f.w,
      type: !f.dead && isRem(f.l, f.w) ? 'remnant' : 'scrap',
    }));
    const seqd = sequenceCuts(res, { minRemL, minRemW, ox, oy, remnantsEnabled: !!settings.remnantsEnabled });
    const remA = offcuts.filter((o) => o.type === 'remnant').reduce((a, o) => a + o.l * o.w, 0);
    const pA = sh.placedArea;
    const sA = stock.len * stock.wid;
    usedArea += sA; placedArea += pA; remnantArea += remA; cutCount += seqd.rows.length;
    const sig = layoutSignature(stock, res.placements);
    return {
      stock, ox, oy, trR: trimR, trB: trimB, sourceTree: res,
      placements: res.placements.map((p) => ({ x: p.x + ox, y: p.y + oy, l: p.l, w: p.w, pid: p.pid, label: p.label, rot: p.rot })),
      offcuts, cuts: seqd.rows, gaugeSettings: seqd.gaugeSettings,
      placedArea: pA, remnantArea: remA, stockArea: sA,
      grossYield: pA / sA, netYield: pA / Math.max(sA - remA, EPS), sig,
    };
  });

  // group identical layouts
  const groupsMap = new Map();
  for (const sv of sheetViews) {
    if (!groupsMap.has(sv.sig)) groupsMap.set(sv.sig, { layout: sv, repeat: 0 });
    groupsMap.get(sv.sig).repeat += 1;
  }
  const groups = [...groupsMap.values()].sort((a, b) => b.layout.netYield - a.layout.netYield);

  const uncutMap = new Map();
  for (const i of remaining) uncutMap.set(i.pid, (uncutMap.get(i.pid) || 0) + 1);

  const totalCost = costMode ? sheets.reduce((a, sh) => a + sh.stock.cost, 0) : null;
  const costBasis = sheets.reduce((a, sh) => a + costOf(sh.stock), 0);
  const remRate = settings.remnantsEnabled ? settings.remRate ?? 0 : 0;
  const avgCostPerArea = usedArea > 0 ? costBasis / usedArea : 1;
  const effCost = costBasis - (remRate / 99) * remnantArea * avgCostPerArea;

  return {
    sheets: sheetViews, groups,
    runs: buildProductionRuns(sheetViews),
    uncut: [...uncutMap.entries()].map(([pid, count]) => ({ pid, count })),
    uncutCount: remaining.length,
    stats: {
      usedArea, placedArea, remnantArea, cutCount,
      sheetsUsed: sheets.length,
      grossYield: usedArea > 0 ? placedArea / usedArea : 0,
      netYield: usedArea - remnantArea > 0 ? placedArea / (usedArea - remnantArea) : 0,
      totalCost, costMode,
      totalGaugeSettings: sheetViews.reduce((a, sv) => a + sv.gaugeSettings, 0),
    },
    fitness: [remaining.length, effCost, -remnantArea, cutCount],
  };
}

// Cache exact instances as well as geometry: identical repeated layouts carry
// different part keys, which must never be copied from another sheet.
function layoutCacheKey(sv, settings) {
  return JSON.stringify([sv.sig, settings,
    sv.sourceTree?.placements.map((p) => [p.key, p.rot, p.canTurn]).sort(),
    sv.cuts.map((c) => [c.dir, c.gauge, c.pieceRect, c.stage])]);
}

function optimizeSheetView(sv, settings, layoutCache) {
  if (!sv.sourceTree) return sv;
  const cacheKey = layoutCacheKey(sv, settings);
  if (layoutCache.has(cacheKey)) return layoutCache.get(cacheKey);
  const { maxStage, half } = CUT_TYPES[settings.cutType] || CUT_TYPES['3'];
  const tree = optimizeSheetLayout(sv.sourceTree, { ...settings, maxStage, half }, decodeSheet);
  const seq = sequenceCuts(tree, { ...settings, ox: sv.ox, oy: sv.oy });
  const offcuts = tree.frees.map((f) => ({
    x: f.x + sv.ox, y: f.y + sv.oy, l: f.l, w: f.w,
    type: settings.remnantsEnabled && !f.dead &&
      Math.max(f.l, f.w) >= Math.max(settings.minRemL, settings.minRemW) - EPS &&
      Math.min(f.l, f.w) >= Math.min(settings.minRemL, settings.minRemW) - EPS ? 'remnant' : 'scrap',
  }));
  const remnantArea = offcuts.filter((o) => o.type === 'remnant').reduce((a, o) => a + o.l * o.w, 0);
  const next = { ...sv, sourceTree: tree, cuts: seq.rows, gaugeSettings: seq.gaugeSettings,
    placements: tree.placements.map((p) => ({ x: p.x + sv.ox, y: p.y + sv.oy,
      l: p.l, w: p.w, pid: p.pid, label: p.label, rot: p.rot })),
    sig: layoutSignature(sv.stock, tree.placements),
    offcuts, remnantArea, netYield: sv.placedArea / Math.max(sv.stockArea - remnantArea, EPS),
    cutsBeforeOptimization: sv.cutsBeforeOptimization ?? sv.cuts.length };
  layoutCache.set(cacheKey, next);
  return next;
}

// Sheet assignments and production order remain fixed. Only the arrangements
// inside selected sheets are refined; grouping limits and material use cannot
// change. Rebuild layout references so drawings, runs and reports all agree.
export function optimizeSolutionCuts(sol, settings, layoutCache = new Map()) {
  if (!sol) return sol;
  const sheets = sol.sheets.map((sv) => optimizeSheetView(sv, settings, layoutCache));
  const groupsMap = new Map();
  for (const sv of sheets) {
    if (!groupsMap.has(sv.sig)) groupsMap.set(sv.sig, { layout: sv, repeat: 0 });
    groupsMap.get(sv.sig).repeat++;
  }
  const groups = [...groupsMap.values()].sort((a, b) => b.layout.netYield - a.layout.netYield);
  const runs = buildProductionRuns(sheets);
  const cleanup = new Set();
  for (const run of sol.runs) {
    if (run.cleanup) for (let i = run.startSheet; i <= run.endSheet; i++) cleanup.add(i);
  }
  for (const run of runs) run.cleanup = cleanup.has(run.startSheet);
  const remnantArea = sheets.reduce((a, s) => a + s.remnantArea, 0);
  const cutCount = sheets.reduce((a, s) => a + s.cuts.length, 0);
  const costBasis = sheets.reduce((a, s) => a + (sol.stats.costMode ? s.stock.cost : s.stockArea), 0);
  const effCost = costBasis - (settings.remnantsEnabled ? (settings.remRate ?? 0) / 99 : 0) *
    remnantArea * (sol.stats.usedArea > 0 ? costBasis / sol.stats.usedArea : 1);
  return { ...sol, sheets, groups, runs,
    stats: { ...sol.stats, remnantArea, cutCount,
      cutsBeforeOptimization: sol.stats.cutsBeforeOptimization ?? sol.stats.cutCount,
      netYield: sol.stats.usedArea > remnantArea ? sol.stats.placedArea / (sol.stats.usedArea - remnantArea) : 0,
      totalGaugeSettings: sheets.reduce((a, s) => a + s.gaugeSettings, 0) },
    fitness: [sol.uncutCount, effCost, -remnantArea, cutCount] };
}

export async function refineResultCuts(result, settings, { onProgress, shouldStop } = {}) {
  const solutions = new Map(), layouts = new Map();
  const pending = [result.sol, result.baselineSol, result.bestGrossYieldSol, result.benchmark?.sol,
    ...(result.levelResults || []).map((level) => level.sol)].filter(Boolean);
  const total = new Set(pending.flatMap((sol) => sol.sheets.map((sv) => layoutCacheKey(sv, settings)))).size;
  const refine = async (sol) => {
    if (!sol || solutions.has(sol)) return solutions.get(sol) || sol;
    for (const sv of sol.sheets) {
      const key = layoutCacheKey(sv, settings);
      if (layouts.has(key)) continue;
      await _sleep(0); // let the browser paint progress and handle Stop between sheets
      if (shouldStop?.()) layouts.set(key, sv);
      else layouts.set(key, optimizeSheetView(sv, settings, layouts));
      onProgress?.({ completed: layouts.size, total });
    }
    const refined = optimizeSolutionCuts(sol, settings, layouts);
    solutions.set(sol, refined);
    return refined;
  };
  const next = { ...result };
  for (const key of ['sol', 'baselineSol', 'bestGrossYieldSol']) {
    if (result[key]) next[key] = await refine(result[key]);
  }
  if (result.benchmark) next.benchmark = { ...result.benchmark, sol: await refine(result.benchmark.sol) };
  if (result.levelResults) {
    next.levelResults = [];
    for (const level of result.levelResults) {
      const sol = await refine(level.sol);
      next.levelResults.push({ ...level, sol, netYield: sol.stats.netYield, sig: planSignature(sol) });
    }
  }
  return next;
}

// Production runs: walk sheets in actual production order and merge ONLY
// adjacent sheets whose layout signatures match. Never sorted by yield —
// identical layouts separated by another family run stay separate runs.
export function buildProductionRuns(sheetViews) {
  const runs = [];
  sheetViews.forEach((sv, i) => {
    const last = runs[runs.length - 1];
    if (last && sv.sig != null && last.layout.sig === sv.sig && last.endSheet === i) {
      last.repeat += 1;
      last.endSheet = i + 1;
    } else {
      const areaByPid = new Map();
      for (const p of sv.placements) areaByPid.set(p.pid, (areaByPid.get(p.pid) || 0) + p.l * p.w);
      let dominantPid = null, dArea = -1;
      for (const [pid, a] of areaByPid) if (a > dArea + EPS) { dominantPid = pid; dArea = a; }
      runs.push({ layout: sv, repeat: 1, startSheet: i + 1, endSheet: i + 1, dominantPid, cleanup: false });
    }
  });
  return runs;
}

export function betterFitness(a, b) {
  // true if a strictly better than b
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-9) return true;
    if (a[i] > b[i] + 1e-9) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Search: deterministic multi-start + randomized improvement
// ---------------------------------------------------------------------------

export const ORDER_KEYS = {
  maxSide: (a, b) => Math.max(b.l, b.w) - Math.max(a.l, a.w) || Math.min(b.l, b.w) - Math.min(a.l, a.w) || (a.pid < b.pid ? -1 : 1),
  area: (a, b) => b.l * b.w - a.l * a.w || (a.pid < b.pid ? -1 : 1),
  length: (a, b) => b.l - a.l || b.w - a.w || (a.pid < b.pid ? -1 : 1),
  width: (a, b) => b.w - a.w || b.l - a.l || (a.pid < b.pid ? -1 : 1),
  minSide: (a, b) => Math.min(b.l, b.w) - Math.min(a.l, a.w) || (a.pid < b.pid ? -1 : 1),
};

export function initialVariants(settings) {
  const dirs = settings.firstCut === 'auto' ? ['h', 'v'] : [settings.firstCut];
  const out = [];
  for (const orderKey of Object.keys(ORDER_KEYS))
    for (const firstCut of dirs)
      for (const choice of ['BSSF', 'BAF'])
        for (const splitPref of ['best', 'v', 'h'])
          out.push({ orderKey, firstCut, choice, splitPref });
  return out;
}

export function mutateOrder(order, rng) {
  const arr = order.slice();
  const roll = rng();
  if (roll < 0.12) {
    // full shuffle
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  } else if (roll < 0.35 && arr.length > 3) {
    const i = Math.floor(rng() * arr.length);
    const j = Math.floor(rng() * arr.length);
    const [lo, hi] = i < j ? [i, j] : [j, i];
    const seg = arr.splice(lo, hi - lo + 1).reverse();
    arr.splice(lo, 0, ...seg);
  } else {
    const swaps = 1 + Math.floor(rng() * 6);
    for (let k = 0; k < swaps; k++) {
      const i = Math.floor(rng() * arr.length);
      const j = Math.floor(rng() * arr.length);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  return arr;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Which parts cannot fit ANY stock (within trims), in any allowed orientation
export function findOversize(parts, stocks, settings) {
  const out = [];
  for (const p of parts) {
    let fits = false;
    for (const s of stocks) {
      const uL = s.len - settings.trimL - settings.trimR;
      const uW = s.wid - settings.trimT - settings.trimB;
      if (p.len <= uL + EPS && p.wid <= uW + EPS) { fits = true; break; }
      if (p.canTurn && p.wid <= uL + EPS && p.len <= uW + EPS) { fits = true; break; }
    }
    if (!fits) out.push(p);
  }
  return out;
}

// ============================================================================
// ShearPlan 2D — yield-aware part-family grouping engine (pure JS, no DOM)
// ============================================================================
// A part family is one part row, keyed by the stable internal p.id (labels are
// display-only and may be blank or duplicated). The grouping feature works in
// the search / ordering / sheet-eligibility / candidate-comparison / output-
// sequencing layers. A final per-sheet pass may rearrange assigned parts, but
// never transfers them between blanks or changes the production sheet order,
// so family grouping constraints and comparisons remain valid.

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// All grouping tuning constants live here so they can be adjusted after real
// shop use without hunting through the solver.
export const GROUPING_SOLVER_VERSION = 4;
export const GROUPING_TUNING = {
  solverVersion: GROUPING_SOLVER_VERSION,
  // aggression → default maximum gross-yield loss (percentage points),
  // linearly interpolated between rows
  yieldLossByAggression: [
    [0, 0.0],
    [50, 2.5],
    [75, 5.0],
    [100, 8.0],
  ],
  // aggression → minimum utilization for a dedicated Auto bulk sheet
  bulkMinUtilByAggression: [
    [25, 0.92],
    [50, 0.82],
    [75, 0.70],
    [100, 0.55],
  ],
  // deterministic caps for the family-only analysis (kept time-independent so
  // comparison runs are repeatable)
  familyEstimateVariantCap: 12,
  familyEstimateVariantCapLarge: 4, // families with qty > familyEstimateLargeQty
  familyEstimateLargeQty: 120,
  archiveLimit: 220,
  presets: [
    { aggression: 0, label: 'Yield First' },
    { aggression: 50, label: 'Balanced' },
    { aggression: 75, label: 'Strong' },
    { aggression: 100, label: 'Ultra' },
  ],
};

// ---------------------------------------------------------------------------
// Deterministic hashing & seeds
// ---------------------------------------------------------------------------

export function hashString(str) {
  let h1 = 0xdeadbeef | 0;
  let h2 = 0x41c6ce57 | 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// Repeatable seeds for comparison runs, derived from the baseline optimization
// hash. Changing only the grouping slider re-derives the same seeds, so the
// same job produces repeatable comparisons.
export function deriveSeeds(baseHash) {
  return {
    baselineSeed: (hashString(baseHash + '|baseline') | 1) >>> 0,
    groupedSeed: (hashString(baseHash + '|grouped') | 1) >>> 0,
    familyEstimateSeed: (hashString(baseHash + '|families') | 1) >>> 0,
  };
}

// ---------------------------------------------------------------------------
// Optimization hashes
// ---------------------------------------------------------------------------
// The baseline hash covers everything that shapes the ungrouped search, so the
// ungrouped baseline can be cached and reused when only grouping knobs change.
// The full hash adds the grouping inputs and is used for stale detection.

export function baselineOptHashOf(stocks, parts, settings) {
  const s = settings;
  return JSON.stringify({
    v: GROUPING_SOLVER_VERSION,
    st: stocks.map((x) => [x.id, x.len, x.wid, x.qty, x.cost]),
    pt: parts.map((x) => [x.id, x.len, x.wid, x.qty, x.canTurn]),
    se: [
      s.kerfH, s.kerfV, s.trimL, s.trimR, s.trimT, s.trimB,
      s.cutType, s.firstCut, !!s.remnantsEnabled, s.minRemL, s.minRemW, s.remRate, s.effortSec,
    ],
  });
}

export function fullResultHashOf(stocks, parts, settings) {
  const s = settings;
  return JSON.stringify({
    base: baselineOptHashOf(stocks, parts, settings),
    g: [
      !!s.groupingEnabled, s.groupingAggression ?? DEFAULT_SETTINGS.groupingAggression,
      s.groupingMaxYieldLossPP ?? null, s.groupingMaxExtraSheets ?? 0,
      s.groupSingletonsLast !== false, s.groupAllowFinalSheetFill !== false,
    ],
    pol: parts.map((x) => [x.id, normalizeGroupPolicy(x.groupPolicy)]),
  });
}

// ---------------------------------------------------------------------------
// Interpolated tuning lookups
// ---------------------------------------------------------------------------

export function interpTable(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    const [x0, y0] = table[i - 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return table[table.length - 1][1];
}

export function yieldLossAllowancePP(aggression) {
  return interpTable(GROUPING_TUNING.yieldLossByAggression, aggression);
}

export function groupingAllowancePP(settings, aggression = settings.groupingAggression ?? DEFAULT_SETTINGS.groupingAggression) {
  const override = settings.groupingMaxYieldLossPP;
  return override != null && isFinite(override) ? Number(override) : yieldLossAllowancePP(aggression);
}

export function bulkMinUtil(aggression) {
  return interpTable(GROUPING_TUNING.bulkMinUtilByAggression, aggression);
}

// Gross-yield loss in percentage points (never relative percent change):
// 92.8% → 91.6% is a loss of 1.2 pp.
export function yieldLossPPOf(baselineGrossYield, candidateGrossYield) {
  return (baselineGrossYield - candidateGrossYield) * 100;
}

// ---------------------------------------------------------------------------
// Family metadata
// ---------------------------------------------------------------------------

export function normalizeGroupPolicy(v) {
  return v === 'keepTogether' || v === 'noPreference' || v === 'cleanup' ? v : 'auto';
}

// Grouping-aware instance expansion. One family per part row, keyed by p.id.
// Instance keys match expandInstances() exactly (`${p.id}#${i}`).
export function buildFamilies(parts, settings) {
  const singletonsLast = settings.groupSingletonsLast !== false;
  const families = [];
  const byPid = new Map();
  const cleanupPids = new Set();
  const ktPids = new Set();
  let familyOrder = 0;
  for (const p of parts) {
    const qty = Math.max(0, Math.floor(p.qty || 0));
    if (!qty) continue;
    const policy = normalizeGroupPolicy(p.groupPolicy);
    // Auto parts with quantity one become cleanup parts when the singleton
    // setting is on; explicit Cut Last is always cleanup.
    const cleanup = policy === 'cleanup' || (policy === 'auto' && qty === 1 && singletonsLast);
    if (cleanup) cleanupPids.add(p.id);
    if (policy === 'keepTogether') ktPids.add(p.id);
    const instances = [];
    for (let i = 0; i < qty; i++) {
      instances.push({
        key: `${p.id}#${i}`, pid: p.id, label: p.label, l: p.len, w: p.wid,
        canTurn: !!p.canTurn, familyQty: qty, groupPolicy: policy,
        cleanup, familyOrder, blockType: 'normal',
      });
    }
    const fam = {
      pid: p.id, label: p.label, qty,
      len: p.len, wid: p.wid, canTurn: !!p.canTurn,
      areaEach: p.len * p.wid, totalArea: qty * p.len * p.wid,
      policy, cleanup, isSingleton: qty === 1, instances,
    };
    families.push(fam);
    byPid.set(p.id, fam);
    familyOrder++;
  }
  return { families, byPid, cleanupPids, ktPids };
}

// ---------------------------------------------------------------------------
// Best-known family sheet count
// ---------------------------------------------------------------------------
// A quick family-only search with the existing decoder. The result is the
// best-known family sheet count — a heuristic result, not a proven lower
// bound. Deterministic: the variant rotation starts at a seed-derived index
// and the variant caps depend only on family size, never on wall-clock time.

export function estimateFamilySheets(family, stocks, settings, opts = {}) {
  const seed = (opts.seed ?? 0) >>> 0;
  if (family.isSingleton) {
    return {
      pid: family.pid, idealSheets: 1, firstSheetCapacity: 1,
      preferredVariant: null, preferredStockId: null, preferredStockArea: 0,
      complete: true, grossYield: 0,
    };
  }
  const dirs = settings.firstCut === 'auto' ? ['h', 'v'] : [settings.firstCut];
  const variants = [];
  for (const firstCut of dirs)
    for (const choice of ['BSSF', 'BAF'])
      for (const splitPref of ['best', 'v', 'h']) variants.push({ firstCut, choice, splitPref });
  const cap = Math.min(
    variants.length,
    family.qty > GROUPING_TUNING.familyEstimateLargeQty
      ? GROUPING_TUNING.familyEstimateVariantCapLarge
      : GROUPING_TUNING.familyEstimateVariantCap,
  );
  const start = variants.length ? hashString(seed + '|' + family.pid) % variants.length : 0;
  let best = null;
  for (let k = 0; k < cap; k++) {
    const v = variants[(start + k) % variants.length];
    const sol = decodePlan(stocks, family.instances.slice(), settings, v);
    if (!best) { best = { v, sol }; continue; }
    const a = sol, b = best.sol;
    if (a.uncutCount !== b.uncutCount) { if (a.uncutCount < b.uncutCount) best = { v, sol }; continue; }
    if (a.stats.sheetsUsed !== b.stats.sheetsUsed) { if (a.stats.sheetsUsed < b.stats.sheetsUsed) best = { v, sol }; continue; }
    if (a.stats.grossYield > b.stats.grossYield + 1e-9) best = { v, sol };
  }
  const sol = best.sol;
  const first = sol.sheets[0];
  return {
    pid: family.pid,
    idealSheets: Math.max(1, sol.stats.sheetsUsed || 1),
    firstSheetCapacity: first ? first.placements.length : 0,
    preferredVariant: best.v,
    preferredStockId: first ? first.stock.id : null,
    preferredStockArea: first ? first.stockArea : 0,
    complete: sol.uncutCount === 0,
    grossYield: sol.stats.grossYield,
  };
}

export function estimateAllFamilies(families, stocks, settings, opts = {}) {
  const out = new Map();
  for (const f of families) out.set(f.pid, estimateFamilySheets(f, stocks, settings, opts));
  return out;
}

// ---------------------------------------------------------------------------
// Family blocks
// ---------------------------------------------------------------------------
// Grouped orders are represented as blocks so mutation can never separate
// copies of the same family by accident. Instances inside a block are shallow
// copies stamped with the block type; decodeSheet only reads them.

export const FAMILY_ORDER_KEYS = {
  totalArea: (a, b) => b.totalArea - a.totalArea || (a.pid < b.pid ? -1 : 1),
  qty: (a, b) => b.qty - a.qty || b.totalArea - a.totalArea || (a.pid < b.pid ? -1 : 1),
  areaEach: (a, b) => b.areaEach - a.areaEach || b.qty - a.qty || (a.pid < b.pid ? -1 : 1),
  maxSide: (a, b) =>
    Math.max(b.len, b.wid) - Math.max(a.len, a.wid) ||
    Math.min(b.len, b.wid) - Math.min(a.len, a.wid) || (a.pid < b.pid ? -1 : 1),
  length: (a, b) => b.len - a.len || b.wid - a.wid || (a.pid < b.pid ? -1 : 1),
};

let __blockId = 0;
function newFamilyBlock(pid, type, cleanup, instances) {
  return {
    id: `blk${__blockId++}`,
    pid, type, cleanup,
    zone: cleanup ? 'c' : 'q',
    instances: instances.map((i) => ({ ...i, blockType: type })),
  };
}

// Build the initial block order for one strategy. Keep Together families lead,
// then quantity families, then residual blocks, then cleanup blocks.
export function buildBlocks(gctx, estimates, opts = {}) {
  const { strategy = 'soft', aggression = 50, orderKey = 'totalArea' } = opts;
  const cmp = FAMILY_ORDER_KEYS[orderKey] || FAMILY_ORDER_KEYS.totalArea;
  const kt = gctx.families.filter((f) => f.policy === 'keepTogether').sort(cmp);
  const qFams = gctx.families.filter((f) => f.policy !== 'keepTogether' && !f.cleanup).sort(cmp);
  const cFams = gctx.families.filter((f) => f.policy !== 'keepTogether' && f.cleanup).sort(cmp);
  const blocks = [];
  for (const f of kt) blocks.push(newFamilyBlock(f.pid, 'normal', false, f.instances));
  const residuals = [];
  for (const f of qFams) {
    let handled = false;
    if (strategy === 'bulkResidual' && f.policy === 'auto' && f.qty > 1 && estimates) {
      const est = estimates.get(f.pid);
      const cap = est ? est.firstSheetCapacity : 0;
      if (est && cap >= 2 && est.preferredStockArea > EPS) {
        // Do not peel off a dedicated bulk sheet when its utilization is poor.
        const util = (cap * f.areaEach) / est.preferredStockArea;
        if (util + 1e-9 >= bulkMinUtil(aggression)) {
          const bulkCount = Math.floor(f.qty / cap) * cap;
          if (bulkCount === f.qty) {
            blocks.push(newFamilyBlock(f.pid, 'bulk', false, f.instances));
            handled = true;
          } else if (bulkCount >= cap) {
            blocks.push(newFamilyBlock(f.pid, 'bulk', false, f.instances.slice(0, bulkCount)));
            residuals.push(newFamilyBlock(f.pid, 'residual', false, f.instances.slice(bulkCount)));
            handled = true;
          }
        }
      }
    }
    if (!handled) blocks.push(newFamilyBlock(f.pid, 'normal', false, f.instances));
  }
  blocks.push(...residuals);
  for (const f of cFams)
    blocks.push(newFamilyBlock(f.pid, f.isSingleton ? 'singleton' : 'normal', true, f.instances));
  return blocks;
}

// Block-level mutation for strongly grouped candidates. Instance-level
// mutateOrder() would separate copies of a family, so grouped orders are
// mutated as whole blocks. Keep Together blocks are never split.
export function mutateGroupedBlocks(blocks, rng, opts = {}) {
  const aggression = opts.aggression ?? 50;
  const ktPids = opts.ktPids || new Set();
  let arr = blocks.slice();
  if (arr.length < 2) return arr;
  const qIdx = () => arr.map((b, i) => ({ b, i })).filter((x) => x.b.zone === 'q');
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const roll = rng();
  if (roll < 0.16) {
    // swap two family blocks
    const q = qIdx();
    if (q.length >= 2) { const a = pick(q), b = pick(q); const t = arr[a.i]; arr[a.i] = arr[b.i]; arr[b.i] = t; }
  } else if (roll < 0.32) {
    // move one block to another position
    const q = qIdx();
    if (q.length >= 2) {
      const a = pick(q);
      const [blk] = arr.splice(a.i, 1);
      const j = Math.floor(rng() * (arr.length + 1));
      arr.splice(j, 0, blk);
    }
  } else if (roll < 0.44) {
    // reverse a range of blocks (quantity zone positions only)
    const q = qIdx();
    if (q.length >= 3) {
      const i1 = Math.floor(rng() * q.length), i2 = Math.floor(rng() * q.length);
      const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
      const idxs = q.slice(lo, hi + 1).map((x) => x.i);
      const seg = idxs.map((i) => arr[i]).reverse();
      idxs.forEach((i, k) => { arr[i] = seg[k]; });
    }
  } else if (roll < 0.58) {
    // swap two quantity-family runs (all blocks of each family, pairwise)
    const pids = [...new Set(arr.filter((b) => b.zone === 'q').map((b) => b.pid))];
    if (pids.length >= 2) {
      const pa = pick(pids);
      let pb = pick(pids);
      if (pb === pa) pb = pids[(pids.indexOf(pa) + 1) % pids.length];
      const ia = arr.map((b, i) => (b.pid === pa && b.zone === 'q' ? i : -1)).filter((i) => i >= 0);
      const ib = arr.map((b, i) => (b.pid === pb && b.zone === 'q' ? i : -1)).filter((i) => i >= 0);
      const n = Math.min(ia.length, ib.length);
      for (let k = 0; k < n; k++) { const t = arr[ia[k]]; arr[ia[k]] = arr[ib[k]]; arr[ib[k]] = t; }
    }
  } else if (roll < 0.70) {
    // move a residual block into or out of the cleanup area
    const res = arr.map((b, i) => (b.type === 'residual' ? i : -1)).filter((i) => i >= 0);
    if (res.length) {
      const i = pick(res);
      arr[i] = { ...arr[i], zone: arr[i].zone === 'q' ? 'c' : 'q' };
    }
  } else if (roll < 0.84) {
    // change which family is processed first
    const pids = [...new Set(arr.filter((b) => b.zone === 'q').map((b) => b.pid))];
    if (pids.length >= 2) {
      const p = pick(pids);
      const mine = arr.filter((b) => b.pid === p && b.zone === 'q');
      const rest = arr.filter((b) => !(b.pid === p && b.zone === 'q'));
      arr = [...mine, ...rest];
    }
  } else if (aggression <= 35) {
    // at low aggression only: split or merge Auto blocks (never Keep Together)
    const cands = arr
      .map((b, i) => ({ b, i }))
      .filter((x) => x.b.zone === 'q' && !ktPids.has(x.b.pid) && x.b.type === 'normal');
    if (rng() < 0.5) {
      const splittable = cands.filter((x) => x.b.instances.length >= 4);
      if (splittable.length) {
        const x = pick(splittable);
        const at = 1 + Math.floor(rng() * (x.b.instances.length - 2));
        const b1 = { ...x.b, id: x.b.id + 'a', instances: x.b.instances.slice(0, at) };
        const b2 = { ...x.b, id: x.b.id + 'b', instances: x.b.instances.slice(at) };
        arr.splice(x.i, 1, b1, b2);
      }
    } else {
      const byPid = new Map();
      for (const x of cands) {
        if (!byPid.has(x.b.pid)) byPid.set(x.b.pid, []);
        byPid.get(x.b.pid).push(x);
      }
      const mult = [...byPid.values()].filter((v) => v.length >= 2);
      if (mult.length) {
        const grp = pick(mult);
        const merged = { ...grp[0].b, instances: grp[0].b.instances.concat(grp[1].b.instances) };
        arr[grp[0].i] = merged;
        arr.splice(grp[1].i, 1);
      }
    }
  } else {
    const q = qIdx();
    if (q.length >= 2) { const a = pick(q), b = pick(q); const t = arr[a.i]; arr[a.i] = arr[b.i]; arr[b.i] = t; }
  }
  // repair: cleanup-zone blocks always follow quantity-zone blocks (stable)
  const q2 = arr.filter((b) => b.zone === 'q');
  const c2 = arr.filter((b) => b.zone !== 'q');
  return [...q2, ...c2];
}

// ---------------------------------------------------------------------------
// Grouped multi-blank decoder
// ---------------------------------------------------------------------------
// Phase-aware wrapper around decodeSheet(). Sorting cleanup instances to the
// end of an array is NOT enough — decodeSheet tries every remaining instance
// while filling a sheet — so eligibility is enforced per phase here.
//
// Strategies:
//   soft         — one phase, family blocks contiguous, everything eligible
//   phase        — quantity phase (cleanup excluded), then cleanup phase
//   bulkResidual — bulk blocks first; residual blocks later (own phase at
//                  aggression ≥ 75), then cleanup
//   finishFamily — active family decoded alone per blank; fillers accepted
//                  only if the whole family still fits on that blank
//   strict       — one family at a time; fillers on its final sheet only when
//                  the final-sheet-fill setting permits
// Keep Together families are always processed first, strictly, regardless of
// strategy, and are never used as fillers.

export function decodePlanGrouped(stocks, blocks, settings, variant, gopts = {}) {
  const { kerfH, kerfV, trimL, trimR, trimT, trimB, cutType } = settings;
  const { maxStage, half } = CUT_TYPES[cutType] || CUT_TYPES['3'];
  const opt = {
    kerfH, kerfV, maxStage, half,
    firstCut: variant.firstCut, choice: variant.choice, splitPref: variant.splitPref,
  };
  const strategy = gopts.strategy || 'soft';
  const aggression = gopts.aggression ?? 50;
  const allowFill = gopts.allowFinalSheetFill !== false;
  const ktPids = gopts.ktPids || new Set();

  const qtyLeft = new Map();
  for (const s of stocks) qtyLeft.set(s.id, s.qty == null ? Infinity : Math.max(0, Math.floor(s.qty)));
  const costMode = stocks.length > 0 && stocks.every((s) => s.cost != null && isFinite(s.cost));
  const costOf = (s) => (costMode ? s.cost : s.len * s.wid);

  let remaining = blocks.flatMap((b) => b.instances);
  const dead = [];
  const sheets = [];
  let guard = 0;
  const GUARD = 800;

  const decodeOn = (s, order) => {
    const uL = s.len - trimL - trimR;
    const uW = s.wid - trimT - trimB;
    if (uL <= EPS || uW <= EPS || !order.length) return null;
    return decodeSheet({ uL, uW }, order, opt);
  };

  // Rerun a chosen sheet with extra instances appended. decodeSheet is
  // deterministic, so an identical prefix reproduces identical placements;
  // each stage is still verified and accepted only if everything previously
  // placed remains on the blank.
  const augment = (stock, order0, res0, stages) => {
    let order = order0, res = res0;
    for (const extra of stages) {
      if (!extra || !extra.length) continue;
      const tryOrder = order.concat(extra);
      const r2 = decodeOn(stock, tryOrder);
      if (!r2) continue;
      let ok = true;
      for (const k of res.placedKeys) if (!r2.placedKeys.has(k)) { ok = false; break; }
      if (ok) { order = tryOrder; res = r2; }
    }
    return { order, res };
  };

  const commit = (stock, res) => {
    qtyLeft.set(stock.id, (qtyLeft.get(stock.id) || 0) - 1);
    remaining = remaining.filter((i) => !res.placedKeys.has(i.key));
    const placedArea = res.placements.reduce((a, p) => a + p.l * p.w, 0);
    sheets.push({ stock, res, placedArea });
  };

  // Group-aware stock selection. With an active family, prefer a stock that
  // finishes the family, then one that places more of it, then fall back to
  // the existing finishes / cost / placed-area comparison. Validity and stock
  // quantity limits always apply.
  const pickStock = (elig, activePid) => {
    let best = null;
    const activeTotal = activePid == null ? 0 : elig.reduce((a, i) => a + (i.pid === activePid ? 1 : 0), 0);
    for (const s of stocks) {
      if ((qtyLeft.get(s.id) || 0) <= 0) continue;
      const res = decodeOn(s, elig);
      if (!res || res.placements.length === 0) continue;
      const placedArea = res.placements.reduce((a, p) => a + p.l * p.w, 0);
      const finishes = res.placements.length === elig.length;
      const cost = costOf(s);
      const cand = { s, res, placedArea, finishes, cost, value: placedArea / Math.max(cost, EPS) };
      if (activePid != null) {
        cand.activeFamilyPlaced = res.placements.reduce((a, p) => a + (p.pid === activePid ? 1 : 0), 0);
        cand.activeFamilyPlacedArea = res.placements.reduce((a, p) => a + (p.pid === activePid ? p.l * p.w : 0), 0);
        cand.activeFamilyRemaining = activeTotal - cand.activeFamilyPlaced;
        cand.activeFamilyFinished = cand.activeFamilyRemaining === 0;
      }
      if (!best) { best = cand; continue; }
      if (activePid != null) {
        if (cand.activeFamilyFinished !== best.activeFamilyFinished) {
          if (cand.activeFamilyFinished) best = cand;
          continue;
        }
        if (cand.activeFamilyPlaced !== best.activeFamilyPlaced) {
          if (cand.activeFamilyPlaced > best.activeFamilyPlaced) best = cand;
          continue;
        }
        if (Math.abs(cand.activeFamilyPlacedArea - best.activeFamilyPlacedArea) > EPS) {
          if (cand.activeFamilyPlacedArea > best.activeFamilyPlacedArea) best = cand;
          continue;
        }
      }
      if (cand.finishes !== best.finishes) { if (cand.finishes) best = cand; }
      else if (cand.finishes) {
        if (cand.cost < best.cost - EPS || (Math.abs(cand.cost - best.cost) <= EPS && cand.placedArea > best.placedArea)) best = cand;
      } else if (cand.value > best.value + 1e-12 || (Math.abs(cand.value - best.value) <= 1e-12 && cand.placedArea > best.placedArea)) {
        best = cand;
      }
    }
    return best;
  };

  const nonCleanup = () => remaining.filter((i) => !i.cleanup);
  const cleanupLeft = () => remaining.filter((i) => i.cleanup);

  // Process one family strictly: mid-run sheets carry the family alone; the
  // sheet where the family finishes may take fillers.
  const runFamilyStrict = (pid, fillOpts) => {
    for (;;) {
      if (guard++ > GUARD) return;
      const active = remaining.filter((i) => i.pid === pid);
      if (!active.length) return;
      const best = pickStock(active, pid);
      if (!best) {
        for (const i of active) dead.push(i);
        remaining = remaining.filter((i) => i.pid !== pid);
        return;
      }
      let cur = { order: active, res: best.res };
      if (best.activeFamilyFinished && fillOpts.fillersAllowed) {
        const fillers = remaining.filter((i) => i.pid !== pid && !i.cleanup && !ktPids.has(i.pid));
        cur = augment(best.s, cur.order, cur.res, [fillers]);
        if (fillOpts.cleanupOnFinalQty) {
          const leftNC = remaining.filter((i) => !i.cleanup && !cur.res.placedKeys.has(i.key));
          if (leftNC.length === 0) {
            const cl = cleanupLeft();
            if (cl.length) cur = augment(best.s, cur.order, cur.res, [cl]);
          }
        }
      }
      commit(best.s, cur.res);
    }
  };

  // Fill sheets from a phase-eligible subset of the remaining instances.
  const phasedFill = (eligProvider, opts2) => {
    for (;;) {
      if (guard++ > GUARD) return;
      const elig = eligProvider();
      if (!elig.length) return;
      const best = pickStock(elig, null);
      if (!best) {
        const ek = new Set(elig.map((i) => i.key));
        for (const i of elig) dead.push(i);
        remaining = remaining.filter((i) => !ek.has(i.key));
        return;
      }
      let cur = { order: elig, res: best.res };
      if (opts2 && opts2.quantityPhase && allowFill) {
        // Final quantity sheet: when this candidate completes every remaining
        // quantity part, rerun it with cleanup parts appended and use that
        // version only if every quantity part still fits.
        const leftNC = nonCleanup().filter((i) => !cur.res.placedKeys.has(i.key));
        if (leftNC.length === 0) {
          const cl = cleanupLeft();
          if (cl.length) cur = augment(best.s, cur.order, cur.res, [cl]);
        }
      }
      commit(best.s, cur.res);
    }
  };

  // Keep Together families first, strictly, in block order — every strategy.
  const ktSeq = [];
  for (const b of blocks) if (ktPids.has(b.pid) && !ktSeq.includes(b.pid)) ktSeq.push(b.pid);
  for (const pid of ktSeq) {
    runFamilyStrict(pid, { fillersAllowed: true, cleanupOnFinalQty: allowFill });
  }

  if (strategy === 'phase') {
    phasedFill(nonCleanup, { quantityPhase: true });
    phasedFill(() => remaining, {});
  } else if (strategy === 'bulkResidual') {
    if (aggression >= 75) {
      phasedFill(() => remaining.filter((i) => !i.cleanup && i.blockType !== 'residual'), { quantityPhase: true });
      phasedFill(nonCleanup, { quantityPhase: true });
    } else {
      phasedFill(nonCleanup, { quantityPhase: true });
    }
    phasedFill(() => remaining, {});
  } else if (strategy === 'finishFamily' || strategy === 'strict') {
    const fillersAllowed = strategy === 'finishFamily' ? true : allowFill;
    for (;;) {
      if (guard++ > GUARD) break;
      const nc = nonCleanup();
      if (!nc.length) break;
      runFamilyStrict(nc[0].pid, { fillersAllowed, cleanupOnFinalQty: allowFill });
    }
    phasedFill(() => remaining, {});
  } else {
    // soft: one phase, everything eligible, family blocks contiguous in order
    phasedFill(() => remaining, {});
  }

  return finalizePlan(stocks, remaining.concat(dead), sheets, settings);
}

// ---------------------------------------------------------------------------
// Sheet sequencing (post-processing)
// ---------------------------------------------------------------------------
// Sheet order may be changed after decoding — it does not alter sheet geometry
// or cut trees. Individual cuts within a sheet are never reordered beyond the
// existing sequenceCuts() behavior. The sort is stable so results stay
// deterministic and decoder-formed runs are preserved.

export function resequenceSheets(sol, ctx) {
  const sheets = sol.sheets;
  if (sheets.length <= 1) return sol;
  const ktOrder = ctx.ktOrder || [];
  const info = sheets.map((sv, i) => {
    const areaByPid = new Map();
    for (const p of sv.placements) areaByPid.set(p.pid, (areaByPid.get(p.pid) || 0) + p.l * p.w);
    let ktPid = null;
    for (const pid of ktOrder) if (areaByPid.has(pid)) { ktPid = pid; break; }
    let domQty = null, dArea = -1;
    for (const [pid, a] of areaByPid) {
      if (ctx.quantityPids.has(pid) && a > dArea + EPS) { domQty = pid; dArea = a; }
    }
    const hasNonCleanup = sv.placements.some((p) => !ctx.cleanupPids.has(p.pid));
    let cls, key;
    if (ktPid != null) { cls = 0; key = ktPid; }        // Keep Together family run
    else if (domQty != null) { cls = 1; key = domQty; } // quantity-family run
    else if (hasNonCleanup) { cls = 2; key = ''; }      // mixed residual
    else { cls = 3; key = ''; }                          // cleanup
    return { sv, i, cls, key };
  });
  const firstIdx = new Map();
  for (const r of info) {
    const k = r.cls + '|' + r.key;
    if (!firstIdx.has(k)) firstIdx.set(k, r.i);
  }
  const ordered = info.slice().sort((a, b) => {
    if (a.cls !== b.cls) return a.cls - b.cls;
    const fa = firstIdx.get(a.cls + '|' + a.key);
    const fb = firstIdx.get(b.cls + '|' + b.key);
    if (fa !== fb) return fa - fb;
    return a.i - b.i;
  });
  let same = true;
  for (let i = 0; i < sheets.length; i++) if (ordered[i].sv !== sheets[i]) { same = false; break; }
  if (same) return sol;
  const newSheets = ordered.map((r) => r.sv);
  return { ...sol, sheets: newSheets, runs: buildProductionRuns(newSheets) };
}

export function tagRunsCleanup(sol, cleanupPids) {
  if (!sol || !sol.runs) return sol;
  for (const run of sol.runs) {
    run.cleanup = run.layout.placements.length > 0 &&
      run.layout.placements.every((p) => cleanupPids.has(p.pid));
  }
  return sol;
}

export function placedCountOf(sol) {
  return sol.sheets.reduce((a, sv) => a + sv.placements.length, 0);
}

export function planSignature(sol) {
  return sol.sheets.map((sv) => sv.sig).join('||');
}

// ---------------------------------------------------------------------------
// Grouping metrics
// ---------------------------------------------------------------------------
// Uses sol.sheets in actual production order (never grouped layout
// signatures). familySheetTouches is the shop metric: each additional
// family-sheet appearance is another batch location that must be identified,
// handled, and sorted.

export function analyzeGrouping(sol, familyList, idealByPid, opts = {}) {
  const ktPids = opts.ktPids || new Set();
  const cleanupPids = opts.cleanupPids || new Set();
  const baselineByPid = opts.baselineByPid || null;
  const sheets = sol.sheets;
  const perPid = new Map();
  sheets.forEach((sv, i) => {
    for (const p of sv.placements) {
      if (!perPid.has(p.pid)) perPid.set(p.pid, new Set());
      perPid.get(p.pid).add(i + 1);
    }
  });
  let lastQuantitySheet = 0;
  sheets.forEach((sv, i) => {
    if (sv.placements.some((p) => !cleanupPids.has(p.pid))) lastQuantitySheet = i + 1;
  });

  const families = [];
  let touches = 0, weightedExcess = 0, atMin = 0, aboveMin = 0, runBreaks = 0;
  let cleanupEarly = 0, singletonsOnFinalTwo = 0, hardViolations = 0;
  let cleanupSingletonCount = 0, cleanupSingletonsNotEarly = 0, quantityFamilyCount = 0;

  for (const f of familyList) {
    const idxSet = perPid.get(f.pid);
    const sheetIndexes = idxSet ? [...idxSet].sort((a, b) => a - b) : [];
    const sheetsUsed = sheetIndexes.length;
    const ideal = Math.max(1, (idealByPid && idealByPid.get(f.pid)) || 1);
    let sheetRuns = 0;
    for (let k = 0; k < sheetIndexes.length; k++) {
      if (k === 0 || sheetIndexes[k] !== sheetIndexes[k - 1] + 1) sheetRuns++;
    }
    const excessSheets = Math.max(0, sheetsUsed - ideal);
    const isCleanup = cleanupPids.has(f.pid);
    const familyWeight = 1 + Math.log2(Math.max(1, f.qty));
    const rec = {
      pid: f.pid, label: f.label, qty: f.qty, policy: f.policy,
      sheetIndexes, sheetsUsed, idealSheets: ideal, excessSheets, sheetRuns,
      firstSheet: sheetIndexes[0] || 0,
      lastSheet: sheetIndexes[sheetIndexes.length - 1] || 0,
      baselineSheetsUsed: baselineByPid ? baselineByPid.get(f.pid) || 0 : null,
      improvement: baselineByPid ? (baselineByPid.get(f.pid) || 0) - sheetsUsed : null,
      cleanup: isCleanup,
      keepTogether: ktPids.has(f.pid),
    };
    families.push(rec);
    if (!isCleanup) quantityFamilyCount++;
    if (isCleanup && f.qty === 1) cleanupSingletonCount++;
    if (!sheetsUsed) continue;
    touches += sheetsUsed;
    if (isCleanup) {
      if (rec.firstSheet < lastQuantitySheet) cleanupEarly++;
      else if (f.qty === 1) cleanupSingletonsNotEarly++;
      if (f.qty === 1 && rec.firstSheet >= Math.max(1, sheets.length - 1)) singletonsOnFinalTwo++;
    } else {
      // mild quantity weight so one high-volume part cannot drown out the rest
      weightedExcess += familyWeight * excessSheets;
      if (sheetsUsed <= ideal) atMin++;
      else aboveMin++;
      runBreaks += Math.max(0, sheetRuns - 1);
    }
    if (ktPids.has(f.pid) && (sheetRuns > 1 || sheetsUsed > ideal)) hardViolations++;
  }

  let mixedSheetCount = 0, cleanupSheetCount = 0;
  for (const sv of sheets) {
    const pids = new Set(sv.placements.map((p) => p.pid));
    if (pids.size > 1) mixedSheetCount++;
    if (sv.placements.length && [...pids].every((pid) => cleanupPids.has(pid))) cleanupSheetCount++;
  }

  return {
    families,
    plan: {
      familySheetTouches: touches,
      weightedExcessTouches: weightedExcess,
      familiesAtBestKnownMinimum: atMin,
      familiesAboveBestKnownMinimum: aboveMin,
      familyRunBreaks: runBreaks,
      mixedSheetCount,
      cleanupSheetCount,
      singletonEarlyCount: cleanupEarly,
      singletonsOnFinalTwoSheets: singletonsOnFinalTwo,
      cleanupSingletonCount,
      cleanupSingletonsNotEarly,
      quantityFamilyCount,
      hardPolicyViolations: hardViolations,
      lastQuantitySheet,
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate archive
// ---------------------------------------------------------------------------
// A bounded set of complete solutions that are not clearly dominated across
// material use, cost, sheet count, and the grouping metrics. Deduplicated by
// ordered plan signature. Candidates from the ungrouped baseline are always
// retained so every aggression level has a valid fallback.

const DOM_TOL = 1e-6;

function domVec(c) {
  return [
    c.sol.uncutCount,
    c.metrics.plan.hardPolicyViolations,
    c.sol.stats.usedArea,
    c.sol.stats.costMode ? c.sol.stats.totalCost : c.sol.stats.usedArea,
    c.sol.stats.sheetsUsed,
    c.metrics.plan.weightedExcessTouches,
    c.metrics.plan.familyRunBreaks,
    c.metrics.plan.singletonEarlyCount,
  ];
}

export function dominatesCandidate(a, b) {
  const va = domVec(a), vb = domVec(b);
  let strict = false;
  for (let i = 0; i < va.length; i++) {
    if (va[i] > vb[i] + DOM_TOL) return false;
    if (va[i] < vb[i] - DOM_TOL) strict = true;
  }
  return strict;
}

export function archiveConsider(archive, cand, opts = {}) {
  const limit = opts.limit ?? GROUPING_TUNING.archiveLimit;
  for (const c of archive) if (c.sig === cand.sig) return false;
  if (cand.source === 'grouped') {
    for (const c of archive) if (dominatesCandidate(c, cand)) return false;
  }
  for (let i = archive.length - 1; i >= 0; i--) {
    const c = archive[i];
    if (c.source === 'grouped' && dominatesCandidate(cand, c)) archive.splice(i, 1);
  }
  archive.push(cand);
  if (archive.length > limit) pruneArchive(archive, limit, opts);
  return true;
}

export function pruneArchive(archive, limit, opts = {}) {
  const protectedSigs = new Set(archive.filter((c) => c.source !== 'grouped').map((c) => c.sig));
  if (opts.protect) for (const s of opts.protect(archive)) protectedSigs.add(s);
  const scored = archive.map((c) => ({
    c,
    score:
      c.sol.uncutCount * 1e6 +
      c.metrics.plan.hardPolicyViolations * 1e4 +
      c.metrics.plan.weightedExcessTouches * 3 +
      c.metrics.plan.familyRunBreaks +
      c.metrics.plan.singletonEarlyCount +
      c.sol.stats.sheetsUsed * 2 -
      c.sol.stats.grossYield * 10,
  }));
  scored.sort((a, b) => a.score - b.score || (a.c.sig < b.c.sig ? -1 : a.c.sig > b.c.sig ? 1 : 0));
  const keep = [];
  for (const s of scored) if (protectedSigs.has(s.c.sig)) keep.push(s.c);
  for (const s of scored) {
    if (keep.length >= limit) break;
    if (!protectedSigs.has(s.c.sig)) keep.push(s.c);
  }
  archive.length = 0;
  archive.push(...keep);
}

// ---------------------------------------------------------------------------
// Selecting a plan for an aggression level
// ---------------------------------------------------------------------------
// Guardrails first (same placed quantity as the ungrouped benchmark, hard
// Keep Together, extra-sheet limit, gross-yield-loss allowance), then a
// lexicographic comparison — material units, sheet counts, and grouping
// counts are never collapsed into one weighted number.

export function compareGroupedCandidates(a, b) {
  const cmp = (x, y, e = 1e-9) => (x < y - e ? -1 : x > y + e ? 1 : 0);
  return (
    cmp(a.sol.uncutCount, b.sol.uncutCount) ||
    cmp(a.metrics.plan.hardPolicyViolations, b.metrics.plan.hardPolicyViolations) ||
    cmp(a.metrics.plan.weightedExcessTouches, b.metrics.plan.weightedExcessTouches) ||
    cmp(a.metrics.plan.familiesAboveBestKnownMinimum, b.metrics.plan.familiesAboveBestKnownMinimum) ||
    cmp(a.metrics.plan.familyRunBreaks, b.metrics.plan.familyRunBreaks) ||
    cmp(a.metrics.plan.singletonEarlyCount, b.metrics.plan.singletonEarlyCount) ||
    cmp(a.metrics.plan.familySheetTouches, b.metrics.plan.familySheetTouches) ||
    cmp(a.sol.fitness[1], b.sol.fitness[1]) ||
    cmp(a.sol.stats.sheetsUsed, b.sol.stats.sheetsUsed) ||
    cmp(-a.sol.stats.remnantArea, -b.sol.stats.remnantArea) ||
    cmp(a.sol.stats.cutCount, b.sol.stats.cutCount) ||
    (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0)
  );
}

export function selectForAllowance(archive, allowancePP, maxExtraSheets, benchmark, opts = {}) {
  if (!archive.length) return null;
  const b = benchmark.sol.stats;
  const bPlaced = benchmark.placedCount;
  const inGuard = (c) =>
    c.sol.stats.grossYield >= b.grossYield - allowancePP / 100 - 1e-9 &&
    c.sol.stats.sheetsUsed - b.sheetsUsed <= maxExtraSheets;
  const eligible = archive.filter((c) => c.placedCount >= bPlaced);
  if (!eligible.length) return null;
  const better = eligible.filter((c) => c.placedCount > bPlaced);
  let pool = null;
  let relaxedForKT = false, unresolvedKT = false, comparisonValid = true;
  if (better.length) {
    pool = better;
    comparisonValid = false; // different placed quantity — never show yield deltas
  } else {
    const clean = eligible.filter((c) => c.metrics.plan.hardPolicyViolations === 0);
    const cleanIn = clean.filter(inGuard);
    if (cleanIn.length) pool = cleanIn;
    else if (opts.ktRequired && clean.length) {
      // Keep Together is a hard user instruction: honor it beyond the normal
      // guardrails and report the cost.
      pool = clean;
      relaxedForKT = true;
    } else {
      unresolvedKT = !!opts.ktRequired;
      const anyIn = eligible.filter(inGuard);
      pool = anyIn.length ? anyIn : eligible;
    }
  }
  const sorted = pool.slice().sort(compareGroupedCandidates);
  return { cand: sorted[0], relaxedForKT, unresolvedKT, comparisonValid };
}

function ktWarningsFor(sel, benchmark) {
  const warnings = [];
  if (!sel || !sel.cand) return warnings;
  const chosen = sel.cand;
  const ktFams = chosen.metrics.families.filter((f) => f.keepTogether);
  if (sel.relaxedForKT && ktFams.length) {
    const lossPP = yieldLossPPOf(benchmark.sol.stats.grossYield, chosen.sol.stats.grossYield);
    const extra = chosen.sol.stats.sheetsUsed - benchmark.sol.stats.sheetsUsed;
    const names = ktFams.map((f) => f.label || f.pid).join(', ');
    const bits = [];
    if (lossPP > 0.05) bits.push(`reduced gross yield by ${lossPP.toFixed(1)} percentage points`);
    if (extra > 0) bits.push(`added ${extra} blank${extra === 1 ? '' : 's'}`);
    if (bits.length) warnings.push(`Keeping ${names} together ${bits.join(' and ')}.`);
  }
  for (const f of ktFams) {
    if (f.sheetRuns > 1 || f.sheetsUsed > f.idealSheets) {
      warnings.push(
        `Could not keep ${f.label || f.pid} on ${f.idealSheets} consecutive blank${f.idealSheets === 1 ? '' : 's'} ` +
        `with the current stock — best found uses ${f.sheetsUsed} blank${f.sheetsUsed === 1 ? '' : 's'} in ${f.sheetRuns} run${f.sheetRuns === 1 ? '' : 's'}.`,
      );
    }
  }
  return warnings;
}

function levelResultOf(lv, allowancePP, sel, benchmark) {
  const b = benchmark.sol.stats;
  const cand = sel && sel.cand;
  const sol = cand ? cand.sol : benchmark.sol;
  const st = sol.stats;
  const metrics = cand ? cand.metrics : benchmark.metrics;
  const comparisonValid = cand ? sel.comparisonValid : true;
  const warnings = ktWarningsFor(sel, benchmark);
  const bm = benchmark.metrics.plan;
  const mp = metrics.plan;
  if (comparisonValid) {
    const improved =
      mp.weightedExcessTouches < bm.weightedExcessTouches - 1e-9 ||
      mp.familyRunBreaks < bm.familyRunBreaks ||
      mp.singletonEarlyCount < bm.singletonEarlyCount ||
      mp.familySheetTouches < bm.familySheetTouches ||
      mp.familiesAtBestKnownMinimum > bm.familiesAtBestKnownMinimum;
    if (!improved) warnings.push('No grouping improvement was found within the selected yield and sheet limits.');
  } else {
    warnings.push('This plan places a different part quantity than the ungrouped benchmark — yield deltas are not comparable.');
  }
  return {
    aggression: lv.aggression,
    label: lv.label,
    custom: !!lv.custom,
    allowancePP,
    sol,
    grossYield: st.grossYield,
    netYield: st.netYield,
    yieldLossPP: comparisonValid ? yieldLossPPOf(b.grossYield, st.grossYield) : null,
    usedArea: st.usedArea,
    usedAreaDeltaPct: comparisonValid && b.usedArea > 0 ? ((st.usedArea - b.usedArea) / b.usedArea) * 100 : null,
    totalCost: st.totalCost,
    costDelta: comparisonValid && st.costMode && b.costMode ? st.totalCost - b.totalCost : null,
    sheetsUsed: st.sheetsUsed,
    additionalSheets: comparisonValid ? st.sheetsUsed - b.sheetsUsed : null,
    groupingMetrics: metrics,
    warnings,
    comparisonValid,
    source: cand ? cand.source : 'benchmark',
    sig: cand ? cand.sig : null,
  };
}

export function buildLevelResults({ archive, benchmark, settings, sliderAggression, ktRequired }) {
  const maxExtra = Math.max(0, Math.floor(settings.groupingMaxExtraSheets ?? 0));
  const levels = GROUPING_TUNING.presets.map((p) => ({ ...p, custom: false }));
  if (
    sliderAggression != null &&
    !GROUPING_TUNING.presets.some((p) => p.aggression === sliderAggression)
  ) {
    levels.push({ aggression: sliderAggression, label: `Custom — ${sliderAggression}`, custom: true });
    levels.sort((a, b) => a.aggression - b.aggression);
  }
  return levels.map((lv) => {
    const allowancePP = groupingAllowancePP(settings, lv.aggression);
    const sel = selectForAllowance(archive, allowancePP, maxExtra, benchmark, { ktRequired });
    return levelResultOf(lv, allowancePP, sel, benchmark);
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
// The reusable async search. Modes:
//   existing — the original optimizer loop, byte-for-byte selection behavior
//   baseline — same search, grouping off, additionally tracking the
//              highest-gross-yield complete plan as the comparison benchmark
//   grouped  — grouping-aware candidate orders feeding the bounded archive

function progressOf(sol) {
  return sol
    ? {
      gross: sol.stats.grossYield,
      net: sol.stats.netYield,
      sheets: sol.stats.sheetsUsed,
      uncut: sol.uncutCount,
    }
    : null;
}

export async function runSearch({
  stocks, parts, settings, mode = 'existing', budgetMs = null, seed = null,
  baseline = null, familyEstimates = null, familySeed = null,
  onProgress = null, shouldStop = null, maxIters = null,
}) {
  const t0 = _now();
  const stop = () => (shouldStop ? !!shouldStop() : false);
  const timeUp = () => budgetMs != null && _now() - t0 > budgetMs;
  const itersUp = (n) => maxIters != null && n >= maxIters;
  const tick = async (extra) => {
    if (onProgress) onProgress({ elapsed: _now() - t0, ...extra });
    await _sleep(0);
  };

  if (mode === 'existing' || mode === 'baseline') {
    const insts = expandInstances(parts);
    let best = null, bestOrder = null, bestGY = null;
    const considerGY = (sol) => {
      if (mode !== 'baseline') return;
      if (!bestGY) { bestGY = sol; return; }
      const a = sol, b = bestGY;
      // benchmark tie-break: fewer uncut, higher gross yield, lower used
      // stock area, lower total cost (cost mode), then existing fitness
      if (a.uncutCount !== b.uncutCount) { if (a.uncutCount < b.uncutCount) bestGY = a; return; }
      if (Math.abs(a.stats.grossYield - b.stats.grossYield) > 1e-9) {
        if (a.stats.grossYield > b.stats.grossYield) bestGY = a;
        return;
      }
      if (Math.abs(a.stats.usedArea - b.stats.usedArea) > DOM_TOL) {
        if (a.stats.usedArea < b.stats.usedArea) bestGY = a;
        return;
      }
      if (a.stats.costMode && b.stats.costMode && Math.abs(a.stats.totalCost - b.stats.totalCost) > 1e-9) {
        if (a.stats.totalCost < b.stats.totalCost) bestGY = a;
        return;
      }
      if (betterFitness(a.fitness, b.fitness)) bestGY = a;
    };
    const consider = (sol, order) => {
      considerGY(sol);
      if (!best || betterFitness(sol.fitness, best.fitness)) {
        best = sol;
        bestOrder = order;
        return true;
      }
      return false;
    };
    let iters = 0;
    for (const v of initialVariants(settings)) {
      if (stop() || timeUp() || itersUp(iters)) break;
      const order = insts.slice().sort(ORDER_KEYS[v.orderKey]);
      consider(decodePlan(stocks, order, settings, v), order);
      iters++;
      if (iters % 6 === 0) await tick({ iters, best: progressOf(best) });
    }
    const rng = mulberry32(((seed == null ? (Date.now() & 0xffff) : seed) | 1) >>> 0);
    let cur = bestOrder || insts.slice();
    while (!stop() && !timeUp() && !itersUp(iters)) {
      const order = mutateOrder(cur, rng);
      const v = {
        firstCut: settings.firstCut === 'auto' ? (rng() < 0.5 ? 'h' : 'v') : settings.firstCut,
        choice: rng() < 0.5 ? 'BSSF' : 'BAF',
        splitPref: ['best', 'best', 'v', 'h'][Math.floor(rng() * 4)],
      };
      const improved = consider(decodePlan(stocks, order, settings, v), order);
      if (improved || rng() < 0.2) cur = order;
      iters++;
      if (iters % 12 === 0) await tick({ iters, best: progressOf(best) });
    }
    return {
      sol: best,
      order: bestOrder,
      bestGrossYieldSol: mode === 'baseline' ? bestGY || best : null,
      iters,
      ms: _now() - t0,
    };
  }

  // -------------------------------------------------- grouped mode
  const gctx = buildFamilies(parts, settings);
  const estimates = familyEstimates || estimateAllFamilies(gctx.families, stocks, settings, { seed: familySeed ?? seed ?? 0 });
  const idealByPid = new Map();
  for (const [pid, e] of estimates) idealByPid.set(pid, e.idealSheets);
  const aggression = Math.max(0, Math.min(100, Math.round(settings.groupingAggression ?? DEFAULT_SETTINGS.groupingAggression)));
  const allowFinalSheetFill = settings.groupAllowFinalSheetFill !== false;
  const ktRequired = gctx.ktPids.size > 0;
  const famCtxList = gctx.families.map((f) => ({ pid: f.pid, label: f.label, qty: f.qty, policy: f.policy }));
  const seqCtx = {
    ktPids: gctx.ktPids,
    cleanupPids: gctx.cleanupPids,
    quantityPids: new Set(gctx.families.filter((f) => f.qty > 1 && !f.cleanup && f.policy !== 'keepTogether').map((f) => f.pid)),
    ktOrder: gctx.families.filter((f) => f.policy === 'keepTogether').map((f) => f.pid),
  };
  const benchmarkSol = baseline && baseline.bestGrossYieldSol;
  const benchmark = benchmarkSol
    ? {
      sol: benchmarkSol,
      metrics: analyzeGrouping(benchmarkSol, famCtxList, idealByPid, { ktPids: gctx.ktPids, cleanupPids: gctx.cleanupPids }),
      placedCount: placedCountOf(benchmarkSol),
    }
    : null;
  const maxExtra = Math.max(0, Math.floor(settings.groupingMaxExtraSheets ?? 0));
  const protect = (arch) => {
    if (!benchmark) return [];
    const sigs = [];
    const aggrs = GROUPING_TUNING.presets.map((p) => p.aggression).concat([aggression]);
    for (const a of aggrs) {
      const allowance = groupingAllowancePP(settings, a);
      const sel = selectForAllowance(arch, allowance, maxExtra, benchmark, { ktRequired });
      if (sel && sel.cand) sigs.push(sel.cand.sig);
    }
    return sigs;
  };
  const archive = [];
  const addCandidate = (sol, source, strategy) => {
    if (!sol) return false;
    // Never retain candidates with more uncut parts than a baseline that cuts
    // every requested part.
    if (benchmarkSol && benchmarkSol.uncutCount === 0 && sol.uncutCount > 0) return false;
    const seq = resequenceSheets(sol, seqCtx);
    tagRunsCleanup(seq, gctx.cleanupPids);
    const metrics = analyzeGrouping(seq, famCtxList, idealByPid, { ktPids: gctx.ktPids, cleanupPids: gctx.cleanupPids });
    const cand = {
      sig: planSignature(seq),
      sol: seq,
      metrics,
      source,
      strategy: strategy || null,
      placedCount: placedCountOf(seq),
    };
    return archiveConsider(archive, cand, { limit: GROUPING_TUNING.archiveLimit, protect });
  };
  if (baseline) {
    if (baseline.baselineSol) addCandidate(baseline.baselineSol, 'baseline', null);
    if (baseline.bestGrossYieldSol && baseline.bestGrossYieldSol !== baseline.baselineSol) {
      addCandidate(baseline.bestGrossYieldSol, 'bestYield', null);
    }
  }

  const dirs = settings.firstCut === 'auto' ? ['h', 'v'] : [settings.firstCut];
  const initVariants = [];
  for (const firstCut of dirs) for (const choice of ['BSSF', 'BAF']) initVariants.push({ firstCut, choice, splitPref: 'best' });
  const stratList = ['soft', 'phase', 'bulkResidual', 'finishFamily', 'strict'];
  const famKeys = Object.keys(FAMILY_ORDER_KEYS);
  const rng = mulberry32(((seed == null ? 1 : seed) | 1) >>> 0);
  let iters = 0;
  const curBlocks = new Map();
  const gargs = (strat, aggr) => ({
    strategy: strat, aggression: aggr, allowFinalSheetFill, ktPids: gctx.ktPids,
  });

  // deterministic initial passes across every strategy so the comparison
  // table can be filled from one shared archive
  outer:
  for (const strategy of stratList) {
    const aggrsFor = strategy === 'bulkResidual' ? [25, 50, 75, 100] : [aggression];
    for (const blockAggr of aggrsFor) {
      for (const fk of famKeys) {
        for (const v of initVariants) {
          if (stop() || timeUp() || itersUp(iters)) break outer;
          const blocks = buildBlocks(gctx, estimates, { strategy, aggression: blockAggr, orderKey: fk });
          const stratKey = strategy === 'bulkResidual' ? `${strategy}@${blockAggr}` : strategy;
          if (!curBlocks.has(stratKey)) curBlocks.set(stratKey, { blocks, blockAggr, strategy });
          addCandidate(decodePlanGrouped(stocks, blocks, settings, v, gargs(strategy, blockAggr)), 'grouped', strategy);
          iters++;
          if (iters % 4 === 0) await tick({ iters, best: progressOf(archive.length ? archive[0].sol : null) });
        }
      }
    }
  }

  // randomized block-level improvement; each strategy keeps its own current
  // order instead of hill-climbing from one shared instance order
  const stratKeys = [...curBlocks.keys()];
  while (!stop() && !timeUp() && !itersUp(iters) && stratKeys.length) {
    const sk = stratKeys[Math.floor(rng() * stratKeys.length)];
    const cur = curBlocks.get(sk);
    const blocks = mutateGroupedBlocks(cur.blocks, rng, { aggression: cur.blockAggr, ktPids: gctx.ktPids });
    const v = {
      firstCut: settings.firstCut === 'auto' ? (rng() < 0.5 ? 'h' : 'v') : settings.firstCut,
      choice: rng() < 0.5 ? 'BSSF' : 'BAF',
      splitPref: ['best', 'best', 'v', 'h'][Math.floor(rng() * 4)],
    };
    const useful = addCandidate(
      decodePlanGrouped(stocks, blocks, settings, v, gargs(cur.strategy, cur.blockAggr)),
      'grouped', cur.strategy,
    );
    if (useful || rng() < 0.2) curBlocks.set(sk, { ...cur, blocks });
    iters++;
    if (iters % 8 === 0) await tick({ iters });
  }

  return {
    archive, benchmark, families: gctx, estimates, idealByPid,
    iters, ms: _now() - t0,
  };
}
