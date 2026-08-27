import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Scissors, Play, Square, Printer, Upload, Download, Save, FolderOpen,
  Plus, Trash2, ChevronLeft, ChevronRight, X, FileText, ClipboardPaste,
} from 'lucide-react';

// ============================================================================
// ShearPlan 2D — core engine (pure JS, no DOM)
// Guillotine cutting optimizer for rectangular parts on rectangular blanks.
// Units: decimal inches internally. Coordinates: x→right, y→down, origin at
// top-left of the usable area of a blank.
// Cut directions: 'h' = horizontal cut line (separates top/bottom, kerfH),
//                 'v' = vertical cut line (separates left/right, kerfV).
// ============================================================================

const EPS = 1e-6;

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
    node.part = { pid: inst.pid, label: inst.label, key: inst.key, rot };
    placements.push({ x: node.x, y: node.y, l: node.l, w: node.w, pid: inst.pid, label: inst.label, key: inst.key, rot, node });
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
  const { cutsRaw } = sheetRes;
  const sorted = [...cutsRaw].sort((a, b) =>
    a.cut.stage - b.cut.stage || a.cut.ci - b.cut.ci);
  const names = new Map();
  names.set(sheetRes.root.id, 'BLANK');
  let letterIdx = 0;
  const rows = [];
  const isRem = (n) => {
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
export function finalizePlan(stocks, remaining, sheets, settings) {
  const { trimL, trimR, trimT, trimB, minRemL, minRemW } = settings;
  const costMode = stocks.length > 0 && stocks.every((s) => s.cost != null && isFinite(s.cost));
  const costOf = (s) => (costMode ? s.cost : s.len * s.wid);

  // classify offcuts, compute stats, sequence cuts, group repeats
  const isRem = (l, w) => {
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
    const seqd = sequenceCuts(res, { minRemL, minRemW, ox, oy });
    const remA = offcuts.filter((o) => o.type === 'remnant').reduce((a, o) => a + o.l * o.w, 0);
    const pA = sh.placedArea;
    const sA = stock.len * stock.wid;
    usedArea += sA; placedArea += pA; remnantArea += remA; cutCount += seqd.rows.length;
    const sig = stock.id + '|' + res.placements
      .map((p) => [p.x, p.y, p.l, p.w, p.pid].map((v) => typeof v === 'number' ? Math.round(v * 1e4) : v).join(','))
      .sort().join(';');
    return {
      stock, ox, oy, trR: trimR, trB: trimB,
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
  const remRate = settings.remRate ?? 0;
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
// sequencing layers only: it never moves parts after decodeSheet() has run.
// Every alternative arrangement comes from re-running the decoder with a
// different valid order or eligibility phase.

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// All grouping tuning constants live here so they can be adjusted after real
// shop use without hunting through the solver.
export const GROUPING_SOLVER_VERSION = 1;
export const GROUPING_TUNING = {
  solverVersion: GROUPING_SOLVER_VERSION,
  // aggression → default maximum gross-yield loss (percentage points),
  // linearly interpolated between rows
  yieldLossByAggression: [
    [0, 0.0],
    [25, 0.25],
    [50, 1.0],
    [75, 2.5],
    [100, 5.0],
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
    { aggression: 25, label: 'Light' },
    { aggression: 50, label: 'Balanced' },
    { aggression: 75, label: 'Strong' },
    { aggression: 100, label: 'Grouping First' },
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
      s.cutType, s.firstCut, s.minRemL, s.minRemW, s.remRate, s.effortSec,
    ],
  });
}

export function fullResultHashOf(stocks, parts, settings) {
  const s = settings;
  return JSON.stringify({
    base: baselineOptHashOf(stocks, parts, settings),
    g: [
      !!s.groupingEnabled, s.groupingAggression ?? 50,
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
  const override = settings.groupingMaxYieldLossPP;
  const hasOverride = override != null && isFinite(override);
  const levels = GROUPING_TUNING.presets.map((p) => ({ ...p, custom: false }));
  if (
    sliderAggression != null &&
    !GROUPING_TUNING.presets.some((p) => p.aggression === sliderAggression)
  ) {
    levels.push({ aggression: sliderAggression, label: `Custom — ${sliderAggression}`, custom: true });
    levels.sort((a, b) => a.aggression - b.aggression);
  }
  return levels.map((lv) => {
    const allowancePP = hasOverride ? override : yieldLossAllowancePP(lv.aggression);
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
  const aggression = Math.max(0, Math.min(100, Math.round(settings.groupingAggression ?? 50)));
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
  const override = settings.groupingMaxYieldLossPP;
  const hasOverride = override != null && isFinite(override);
  const protect = (arch) => {
    if (!benchmark) return [];
    const sigs = [];
    const aggrs = GROUPING_TUNING.presets.map((p) => p.aggression).concat([aggression]);
    for (const a of aggrs) {
      const allowance = hasOverride ? override : yieldLossAllowancePP(a);
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
// ============================================================================
// ShearPlan 2D — UI
// ============================================================================

const PART_COLORS = [
  '#cfe0f4', '#f4ddc4', '#d6e9cc', '#f0d6e6', '#e4ddf2', '#f4ecc4', '#cde8e6',
  '#f0d2cc', '#dde5cb', '#e3dacd', '#ccd6e8', '#e8daf0', '#d2e6da', '#f2e0d0',
];

let __uid = 1;
const uid = (p) => `${p}${Date.now().toString(36)}${(__uid++).toString(36)}`;
const cls = (...a) => a.filter(Boolean).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CUT_TYPE_ORDER = ['3', '3.5', '2', '2.5', 'free'];
const EFFORTS = [
  { v: 3, label: 'Quick — 3 s' },
  { v: 10, label: 'Standard — 10 s' },
  { v: 30, label: 'Thorough — 30 s' },
  { v: 120, label: 'Extended — 2 min' },
];

const DEFAULT_SETTINGS = {
  kerfH: 0, kerfV: 0,
  trimL: 0, trimR: 0, trimT: 0, trimB: 0,
  cutType: '3', firstCut: 'auto',
  minRemL: 12, minRemW: 12, remRate: 50,
  effortSec: 10,
  dispFormat: 'frac', fracDen: 16,
  // Part-family grouping (see grouping engine above). Defaults keep grouping
  // off so existing jobs behave exactly as before.
  groupingEnabled: false,
  groupingAggression: 50,
  groupingMaxYieldLossPP: null,
  groupingMaxExtraSheets: 0,
  groupSingletonsLast: true,
  groupAllowFinalSheetFill: true,
  groupCompareLevels: true,
};

const SAMPLE_STOCKS = [
  { label: '120 × 48', len: 120, wid: 48, qty: null, cost: null },
  { label: '96 × 48', len: 96, wid: 48, qty: 10, cost: null },
];
const SAMPLE_PARTS = [
  { label: 'PLENUM', len: 46, wid: 22, qty: 8, canTurn: true },
  { label: 'WRAP', len: 30, wid: 14, qty: 20, canTurn: true },
  { label: 'CAP', len: 12, wid: 8, qty: 40, canTurn: true },
  { label: 'RUNNER', len: 60, wid: 10, qty: 12, canTurn: false },
  { label: 'PAN', len: 24, wid: 24, qty: 6, canTurn: true },
];

function newStock(over = {}) {
  return { id: uid('s'), label: '', len: NaN, wid: NaN, qty: null, cost: null, ...over };
}
function newPart(i, over = {}) {
  return { id: uid('p'), label: '', len: NaN, wid: NaN, qty: 1, canTurn: true, groupPolicy: 'auto', color: PART_COLORS[i % PART_COLORS.length], ...over };
}

// Hashes for staleness + baseline caching. The full hash covers everything
// that shapes the displayed result (including grouping knobs and per-part
// grouping policies); the baseline hash deliberately excludes those so the
// ungrouped baseline search can be cached and reused when only grouping
// settings change. Both use valid rows only, matching what the optimizer sees.
function planHashes(plan) {
  const stocks = plan.stocks.filter((x) => x.len > 0 && x.wid > 0 && (x.qty === null || x.qty > 0));
  const parts = plan.parts.filter((x) => x.len > 0 && x.wid > 0 && x.qty > 0);
  return {
    full: fullResultHashOf(stocks, parts, plan.settings),
    baseline: baselineOptHashOf(stocks, parts, plan.settings),
  };
}

// Normalize per-part grouping policy on any part list coming from outside
// (imported files, saved plans) so old jobs load cleanly.
function normalizeParts(arr) {
  return (arr || []).map((x) => ({ ...x, groupPolicy: normalizeGroupPolicy(x.groupPolicy) }));
}

// ---------------------------------------------------------------------------
// Small inputs
// ---------------------------------------------------------------------------

function DimInput({ value, onCommit, fmt, className, placeholder, allowEmpty }) {
  const [draft, setDraft] = useState(null);
  const shown = draft != null ? draft : (value == null || Number.isNaN(value) ? '' : fmtDim(value, fmt));
  const bad = draft != null && draft.trim() !== '' && Number.isNaN(parseDim(draft));
  return (
    <input
      type="text"
      inputMode="text"
      value={shown}
      placeholder={placeholder || ''}
      onFocus={(e) => { setDraft(shown); e.target.select(); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null) {
          const t = draft.trim();
          if (t === '') { if (allowEmpty) onCommit(NaN); }
          else { const v = parseDim(t); if (!Number.isNaN(v)) onCommit(v); }
        }
        setDraft(null);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className={cls(
        'w-full rounded border px-2 py-1 text-right font-mono text-sm tabular-nums outline-none',
        bad ? 'border-red-400 bg-red-50 text-red-700' : 'border-slate-300 bg-white focus:border-blue-600',
        className,
      )}
    />
  );
}

function IntInput({ value, onCommit, className, min = 0, disabled }) {
  const [draft, setDraft] = useState(null);
  const shown = draft != null ? draft : (value == null ? '' : String(value));
  return (
    <input
      type="text"
      inputMode="numeric"
      disabled={disabled}
      value={shown}
      onFocus={(e) => { setDraft(shown); e.target.select(); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null) {
          const n = parseInt(draft, 10);
          if (!Number.isNaN(n) && n >= min) onCommit(n);
        }
        setDraft(null);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className={cls(
        'w-full rounded border border-slate-300 bg-white px-2 py-1 text-right font-mono text-sm tabular-nums outline-none focus:border-blue-600',
        disabled && 'bg-slate-100 text-slate-400',
        className,
      )}
    />
  );
}

function FloatInput({ value, onCommit, className, placeholder }) {
  const [draft, setDraft] = useState(null);
  const shown = draft != null ? draft : (value == null || Number.isNaN(value) ? '' : String(value));
  return (
    <input
      type="text"
      inputMode="decimal"
      value={shown}
      placeholder={placeholder || ''}
      onFocus={(e) => { setDraft(shown); e.target.select(); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null) {
          const t = draft.trim().replace(/[$,]/g, '');
          if (t === '') onCommit(null);
          else { const v = parseFloat(t); if (!Number.isNaN(v) && v >= 0) onCommit(v); }
        }
        setDraft(null);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className={cls('w-full rounded border border-slate-300 bg-white px-2 py-1 text-right font-mono text-sm tabular-nums outline-none focus:border-blue-600', className)}
    />
  );
}

function TextInput({ value, onCommit, className, placeholder }) {
  const [draft, setDraft] = useState(null);
  return (
    <input
      type="text"
      value={draft != null ? draft : (value || '')}
      placeholder={placeholder}
      onFocus={() => setDraft(value || '')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft != null) onCommit(draft.trim()); setDraft(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className={cls('w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-blue-600', className)}
    />
  );
}

function Th({ children, className }) {
  return <th className={cls('px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-500', className)}>{children}</th>;
}

// ---------------------------------------------------------------------------
// Layout drawing (SVG)
// ---------------------------------------------------------------------------

function LayoutSVG({ layout, fmt, colorOf, selCut, onPickPart, pickedKey, showCutNumbers, interactive, maxH }) {
  const patId = useMemo(() => 'pat' + Math.random().toString(36).slice(2, 8), []);
  const { stock } = layout;
  const L = stock.len, W = stock.wid;
  const M = Math.max(L, W) * 0.075;
  const fs0 = Math.min(L, W) / 22;
  const cutRow = selCut >= 0 ? layout.cuts[selCut] : null;

  const partLabel = (p, i) => {
    const chars = Math.max((p.label || '?').length + (p.rot ? 1 : 0), 2);
    const vert = p.w > p.l * 1.5;
    const boxL = vert ? p.w : p.l, boxW = vert ? p.l : p.w;
    let fs = Math.min(fs0, boxW * 0.45, (boxL * 0.9) / (chars * 0.62));
    if (fs < fs0 * 0.22) return null;
    const dims = `${fmtDim(p.l, fmt)} × ${fmtDim(p.w, fmt)}`;
    let fsD = Math.min(fs * 0.8, (boxL * 0.94) / (dims.length * 0.58));
    const showDims = fsD > fs0 * 0.2 && boxW > fs * 2.6;
    const cx = p.x + p.l / 2, cy = p.y + p.w / 2;
    return (
      <g key={'t' + i} transform={vert ? `rotate(-90 ${cx} ${cy})` : undefined} pointerEvents="none">
        <text x={cx} y={showDims ? cy - fs * 0.25 : cy} textAnchor="middle" dominantBaseline="middle"
          fontSize={fs} fontWeight="600" fill="#1e293b" fontFamily="ui-monospace, Menlo, Consolas, monospace">
          {p.label}{p.rot ? '*' : ''}
        </text>
        {showDims && (
          <text x={cx} y={cy + fs * 0.75} textAnchor="middle" dominantBaseline="middle"
            fontSize={fsD} fill="#475569" fontFamily="ui-monospace, Menlo, Consolas, monospace">
            {dims}
          </text>
        )}
      </g>
    );
  };

  const offLabel = (o, i) => {
    const vert = o.w > o.l * 1.5;
    const boxL = vert ? o.w : o.l, boxW = vert ? o.l : o.w;
    const txt = o.type === 'remnant' ? `REM ${fmtDim(o.l, fmt)} × ${fmtDim(o.w, fmt)}` : '';
    if (!txt) return null;
    let fs = Math.min(fs0 * 0.85, boxW * 0.5, (boxL * 0.9) / (txt.length * 0.58));
    if (fs < fs0 * 0.2) return null;
    const cx = o.x + o.l / 2, cy = o.y + o.w / 2;
    return (
      <text key={'o' + i} x={cx} y={cy} transform={vert ? `rotate(-90 ${cx} ${cy})` : undefined}
        textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill="#3f6212"
        fontFamily="ui-monospace, Menlo, Consolas, monospace" pointerEvents="none">{txt}</text>
    );
  };

  return (
    <svg viewBox={`${-M * 1.6} ${-M * 1.4} ${L + M * 2.4} ${W + M * 2.2}`}
      className="w-full" style={{ maxHeight: maxH || 460, display: 'block' }}>
      <defs>
        <pattern id={patId + 'w'} width={fs0} height={fs0} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={fs0} height={fs0} fill="#f1f5f9" />
          <line x1="0" y1="0" x2="0" y2={fs0} stroke="#cbd5e1" strokeWidth={fs0 / 7} />
        </pattern>
        <pattern id={patId + 't'} width={fs0 * 0.7} height={fs0 * 0.7} patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width={fs0 * 0.7} height={fs0 * 0.7} fill="#fef2f2" />
          <line x1="0" y1="0" x2="0" y2={fs0 * 0.7} stroke="#fca5a5" strokeWidth={fs0 / 10} />
        </pattern>
      </defs>

      {/* edge dimensions */}
      <g stroke="#94a3b8" strokeWidth="1" style={{ vectorEffect: 'non-scaling-stroke' }}>
        <line x1={0} y1={-M * 0.55} x2={L} y2={-M * 0.55} vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={-M * 0.8} x2={0} y2={-M * 0.3} vectorEffect="non-scaling-stroke" />
        <line x1={L} y1={-M * 0.8} x2={L} y2={-M * 0.3} vectorEffect="non-scaling-stroke" />
        <line x1={-M * 0.55} y1={0} x2={-M * 0.55} y2={W} vectorEffect="non-scaling-stroke" />
        <line x1={-M * 0.8} y1={0} x2={-M * 0.3} y2={0} vectorEffect="non-scaling-stroke" />
        <line x1={-M * 0.8} y1={W} x2={-M * 0.3} y2={W} vectorEffect="non-scaling-stroke" />
      </g>
      <text x={L / 2} y={-M * 0.75} textAnchor="middle" fontSize={fs0 * 0.95} fill="#475569"
        fontFamily="ui-monospace, Menlo, Consolas, monospace">{fmtDim(L, fmt)}</text>
      <text x={-M * 0.78} y={W / 2} textAnchor="middle" fontSize={fs0 * 0.95} fill="#475569"
        fontFamily="ui-monospace, Menlo, Consolas, monospace" transform={`rotate(-90 ${-M * 0.78} ${W / 2})`}>{fmtDim(W, fmt)}</text>

      {/* blank */}
      <rect x={0} y={0} width={L} height={W} fill="#ffffff" stroke="#334155" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {/* trims */}
      {layout.ox > 0 && <rect x={0} y={0} width={layout.ox} height={W} fill={`url(#${patId}t)`} />}
      {layout.trR > 0 && <rect x={L - layout.trR} y={0} width={layout.trR} height={W} fill={`url(#${patId}t)`} />}
      {layout.oy > 0 && <rect x={0} y={0} width={L} height={layout.oy} fill={`url(#${patId}t)`} />}
      {layout.trB > 0 && <rect x={0} y={W - layout.trB} width={L} height={layout.trB} fill={`url(#${patId}t)`} />}

      {/* offcuts */}
      {layout.offcuts.map((o, i) => (
        <rect key={'of' + i} x={o.x} y={o.y} width={o.l} height={o.w}
          fill={o.type === 'remnant' ? '#ecf5e4' : `url(#${patId}w)`}
          stroke={o.type === 'remnant' ? '#65a30d' : '#cbd5e1'}
          strokeWidth="1" strokeDasharray={o.type === 'remnant' ? '5 3' : undefined}
          vectorEffect="non-scaling-stroke" />
      ))}
      {layout.offcuts.map(offLabel)}

      {/* parts */}
      {layout.placements.map((p, i) => (
        <rect key={'p' + i} x={p.x} y={p.y} width={p.l} height={p.w}
          fill={colorOf(p.pid)} stroke={pickedKey === i ? '#1d4ed8' : '#475569'}
          strokeWidth={pickedKey === i ? 2.5 : 1} vectorEffect="non-scaling-stroke"
          style={interactive ? { cursor: 'pointer' } : undefined}
          onClick={interactive ? () => onPickPart(i) : undefined} />
      ))}
      {layout.placements.map(partLabel)}

      {/* cut numbers */}
      {showCutNumbers && layout.cuts.map((c) => {
        const r = c.pieceRect;
        const fs = fs0 * 0.72;
        const x = c.dir === 'h' ? r.x + fs * 0.2 : c.linePos + fs * 0.15;
        const y = c.dir === 'h' ? c.linePos - fs * 0.25 : r.y + fs * 0.95;
        return (
          <text key={'cn' + c.seq} x={x} y={y} fontSize={fs} fill="#dc2626" fontWeight="700"
            fontFamily="ui-monospace, Menlo, Consolas, monospace">{c.seq}</text>
        );
      })}

      {/* active cut */}
      {cutRow && (
        <g>
          <rect x={cutRow.pieceRect.x} y={cutRow.pieceRect.y} width={cutRow.pieceRect.l} height={cutRow.pieceRect.w}
            fill="none" stroke="#dc2626" strokeWidth="1.5" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
          {cutRow.dir === 'h'
            ? <line x1={cutRow.pieceRect.x} y1={cutRow.linePos} x2={cutRow.pieceRect.x + cutRow.pieceRect.l} y2={cutRow.linePos}
              stroke="#dc2626" strokeWidth="3" vectorEffect="non-scaling-stroke" />
            : <line x1={cutRow.linePos} y1={cutRow.pieceRect.y} x2={cutRow.linePos} y2={cutRow.pieceRect.y + cutRow.pieceRect.w}
              stroke="#dc2626" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DRO cut stepper
// ---------------------------------------------------------------------------

function CutDRO({ layout, selCut, setSelCut, fmt }) {
  const n = layout.cuts.length;
  const row = selCut >= 0 ? layout.cuts[selCut] : null;
  let runLen = 0;
  if (row) {
    for (let i = selCut; i < n; i++) {
      const r = layout.cuts[i];
      if (r.dir === row.dir && Math.abs(r.gauge - row.gauge) < 1e-6) runLen++; else break;
    }
  }
  const typeTag = (info, dims) => {
    if (!info) return null;
    if (info.type === 'part') return null;
    if (info.type === 'piece') return null;
    return info.type === 'remnant' ? ' — remnant' : ' — scrap';
  };
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-slate-200 shadow-inner">
      <div className="flex items-stretch gap-3">
        <div className="flex flex-col items-center justify-center gap-1">
          <button onClick={() => setSelCut(Math.max(-1, selCut - 1))}
            className="rounded border border-slate-600 bg-slate-800 p-1.5 hover:bg-slate-700" title="Previous cut">
            <ChevronLeft size={16} />
          </button>
          <div className="text-xs font-semibold tracking-widest text-slate-400">
            {selCut >= 0 ? `${selCut + 1}/${n}` : `0/${n}`}
          </div>
          <button onClick={() => setSelCut(Math.min(n - 1, selCut + 1))}
            className="rounded border border-slate-600 bg-slate-800 p-1.5 hover:bg-slate-700" title="Next cut">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center rounded border border-slate-700 bg-black px-4 py-2">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Set back gauge</div>
          <div className="font-mono text-4xl font-bold tabular-nums text-red-500" style={{ textShadow: '0 0 12px rgba(220,38,38,0.55)' }}>
            {row ? fmtDim(row.gauge, fmt) : '— — —'}
          </div>
          {row && runLen > 1 && (
            <div className="text-xs text-amber-400">{runLen} cuts in a row at this setting</div>
          )}
        </div>
        <div className="hidden min-w-0 flex-1 flex-col justify-center gap-1 text-sm sm:flex">
          {row ? (
            <>
              <div className="truncate">
                <span className="text-slate-400">Take </span>
                <span className="font-mono font-semibold text-white">{row.pieceName}</span>
                <span className="font-mono text-slate-400"> ({fmtDim(row.pieceL, fmt)} × {fmtDim(row.pieceW, fmt)})</span>
              </div>
              <div className="text-xs uppercase tracking-wider text-slate-400">
                {row.dir === 'h' ? 'Horizontal cut' : 'Vertical cut'} · stage {row.stage}
              </div>
              <div className="truncate font-mono text-xs">
                <span className="text-emerald-400">→ {row.resultName || row.resultInfo.type} ({fmtDim(row.resultDims.l, fmt)} × {fmtDim(row.resultDims.w, fmt)})</span>
                {row.remDims && (
                  <span className="text-slate-400">
                    {' · rem '}
                    {row.remInfo && row.remInfo.type === 'part' ? `= ${row.remInfo.label} ` : `${row.remName} `}
                    {fmtDim(row.remDims.l, fmt)} × {fmtDim(row.remDims.w, fmt)}{typeTag(row.remInfo)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="font-semibold text-white">Ready</div>
              <div className="text-xs text-slate-400">{n} cuts · {layout.gaugeSettings} gauge settings. Step through with the arrows or click a row below.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CutTable({ layout, fmt, selCut, setSelCut, compact }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && selCut >= 0) {
      const el = ref.current.querySelector(`[data-cut="${selCut}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selCut]);
  const statusTxt = (info, name) => {
    if (!info) return '—';
    if (info.type === 'part') return name;
    if (info.type === 'piece') return name ? `piece ${name}` : 'piece';
    return info.type;
  };
  return (
    <div ref={ref} className={cls('overflow-auto rounded border border-slate-200', compact ? '' : '')} style={{ maxHeight: compact ? undefined : 230 }}>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-slate-100">
          <tr>
            <Th className="w-8">#</Th>
            <Th className="w-8">St</Th>
            <Th>Take</Th>
            <Th className="text-right">Piece</Th>
            <Th className="w-10">Cut</Th>
            <Th className="text-right">Gauge</Th>
            <Th>Drops</Th>
            <Th>Remainder</Th>
          </tr>
        </thead>
        <tbody>
          {layout.cuts.map((c, i) => {
            const prev = layout.cuts[i - 1];
            const newSetting = !prev || prev.dir !== c.dir || Math.abs(prev.gauge - c.gauge) > 1e-6;
            return (
              <tr key={c.seq} data-cut={i}
                onClick={setSelCut ? () => setSelCut(i) : undefined}
                className={cls(
                  newSetting && i > 0 && 'border-t-2 border-slate-300',
                  selCut === i ? 'bg-red-50' : setSelCut ? 'cursor-pointer hover:bg-slate-50' : '',
                )}>
                <td className="px-2 py-1 font-mono text-slate-500">{c.seq}</td>
                <td className="px-2 py-1 font-mono text-slate-500">{c.stage}</td>
                <td className="px-2 py-1 font-mono font-semibold">{c.pieceName}</td>
                <td className="px-2 py-1 text-right font-mono text-slate-500">{fmtDim(c.pieceL, fmt)} × {fmtDim(c.pieceW, fmt)}</td>
                <td className="px-2 py-1 uppercase text-slate-500">{c.dir === 'h' ? 'hor' : 'ver'}</td>
                <td className={cls('px-2 py-1 text-right font-mono font-bold tabular-nums', newSetting ? 'text-red-700' : 'text-slate-400')}>
                  {fmtDim(c.gauge, fmt)}
                </td>
                <td className="px-2 py-1 font-mono">
                  {statusTxt(c.resultInfo, c.resultName)}
                  <span className="text-slate-400"> {fmtDim(c.resultDims.l, fmt)} × {fmtDim(c.resultDims.w, fmt)}</span>
                </td>
                <td className="px-2 py-1 font-mono text-slate-500">
                  {c.remDims
                    ? c.remInfo && c.remInfo.type === 'part'
                      ? `= ${c.remInfo.label} ${fmtDim(c.remDims.l, fmt)} × ${fmtDim(c.remDims.w, fmt)}`
                      : `${c.remName} ${fmtDim(c.remDims.l, fmt)} × ${fmtDim(c.remDims.w, fmt)}${c.remInfo && c.remInfo.type !== 'piece' ? ` (${c.remInfo.type})` : ''}`
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import modal
// ---------------------------------------------------------------------------

const FIELD_OPTS_PARTS = [
  ['skip', '— skip —'], ['label', 'Label'], ['len', 'Length'], ['wid', 'Width'],
  ['qty', 'Qty'], ['turn', 'Can turn'],
];
const FIELD_OPTS_STOCKS = [
  ['skip', '— skip —'], ['label', 'Label'], ['len', 'Length'], ['wid', 'Width'],
  ['qty', 'Qty'], ['cost', 'Cost/pc'],
];

function detectDelim(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  const count = (ch) => lines.reduce((a, l) => a + (l.split(ch).length - 1), 0);
  const t = count('\t'), c = count(','), s = count(';');
  if (t >= c && t >= s && t > 0) return '\t';
  if (c >= s && c > 0) return ',';
  if (s > 0) return ';';
  return null; // whitespace
}

function splitLine(line, d) {
  if (d === null) return line.trim().split(/\s{2,}|\t/).map((s) => s.trim());
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"' && cur === '') {
      q = true; // quoting only counts at the start of a field — a mid-field " is an inch mark
    } else if (ch === d) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADER_MAP = [
  [/^(label|name|part|mark|item|id|#|no\.?|tag)$/i, 'label'],
  [/^(len(gth)?|l|long)$/i, 'len'],
  [/^(wid(th)?|w|wide)$/i, 'wid'],
  [/^(qty|quantity|pcs?|count|q)$/i, 'qty'],
  [/^(turn|rotate|rot|canturn|can[ _]?turn|grain)$/i, 'turn'],
  [/^(cost|price|\$)$/i, 'cost'],
];

function parseImportText(text, kind) {
  const rawLines = text.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, ' ')).filter((l) => l.trim());
  if (!rawLines.length) return null;
  const delim = detectDelim(text);
  let rows = rawLines.map((l) => splitLine(l, delim));
  const ncol = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => { while (r.length < ncol) r.push(''); return r; });
  // header? only when at least one cell matches a known field name AND no cell is a dimension
  const first = rows[0];
  const headerHits = first.filter((c) => HEADER_MAP.some(([re]) => re.test((c || '').trim()))).length;
  const dimCells = first.filter((c) => c && !Number.isNaN(parseDim(c))).length;
  const looksHeader = headerHits >= 1 && dimCells === 0;
  let mapping = new Array(ncol).fill('skip');
  if (looksHeader) {
    first.forEach((c, i) => {
      for (const [re, f] of HEADER_MAP) if (re.test(c.trim())) { mapping[i] = f; break; }
    });
  }
  const body = looksHeader ? rows.slice(1) : rows;
  // auto-guess unmapped columns
  const has = (f) => mapping.includes(f);
  const colStats = [];
  for (let i = 0; i < ncol; i++) {
    let dimOk = 0, intOk = 0, texty = 0, nonEmpty = 0;
    for (const r of body) {
      const c = r[i];
      if (!c) continue;
      nonEmpty++;
      if (!Number.isNaN(parseDim(c))) dimOk++;
      if (/^\d+$/.test(c)) intOk++;
      if (/[a-z]/i.test(c) && Number.isNaN(parseDim(c))) texty++;
    }
    colStats.push({ dimOk, intOk, texty, nonEmpty });
  }
  for (let i = 0; i < ncol; i++) {
    if (mapping[i] !== 'skip') continue;
    const st = colStats[i];
    if (!st.nonEmpty) continue;
    if (st.texty > st.nonEmpty / 2) { if (!has('label')) mapping[i] = 'label'; continue; }
    if (st.dimOk >= 1 && st.dimOk * 2 >= st.nonEmpty) {
      if (!has('len')) { mapping[i] = 'len'; continue; }
      if (!has('wid')) { mapping[i] = 'wid'; continue; }
      if (!has('qty') && st.intOk * 2 >= st.nonEmpty) { mapping[i] = 'qty'; continue; }
    }
  }
  if (kind === 'stocks') mapping = mapping.map((m) => (m === 'turn' ? 'skip' : m));
  if (kind === 'parts') mapping = mapping.map((m) => (m === 'cost' ? 'skip' : m));
  return { rows: body, mapping, ncol, delim, hadHeader: looksHeader };
}

function rowsToRecords(rows, mapping, kind, startIdx) {
  const recs = []; let skipped = 0;
  const boolOf = (s) => /^(y|yes|true|1|x|✓)$/i.test((s || '').trim()) ? true : /^(n|no|false|0)$/i.test((s || '').trim()) ? false : true;
  rows.forEach((r, ri) => {
    const get = (f) => { const i = mapping.indexOf(f); return i >= 0 ? r[i] : ''; };
    const len = parseDim(get('len'));
    const wid = parseDim(get('wid'));
    if (Number.isNaN(len) || Number.isNaN(wid) || len <= 0 || wid <= 0) { skipped++; return; }
    const qtyRaw = (get('qty') || '').trim().toLowerCase();
    const unlimited = kind === 'stocks' && /^(unl|unlimited|inf|∞|x)$/.test(qtyRaw);
    let qty = parseInt(qtyRaw, 10);
    if (Number.isNaN(qty) || qty < 1) qty = 1;
    const label = (get('label') || '').trim() || (kind === 'parts' ? `P${startIdx + recs.length + 1}` : `BLK${startIdx + recs.length + 1}`);
    if (kind === 'parts') {
      recs.push(newPart(startIdx + recs.length, { label, len, wid, qty, canTurn: boolOf(get('turn')) }));
    } else {
      const cost = parseFloat((get('cost') || '').replace(/[$,]/g, ''));
      recs.push(newStock({ label, len, wid, qty: unlimited ? null : qty, cost: Number.isNaN(cost) ? null : cost }));
    }
  });
  return { recs, skipped };
}

function ImportModal({ kind, fmt, onClose, onImport, startIdx }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const fileRef = useRef(null);
  const fieldOpts = kind === 'parts' ? FIELD_OPTS_PARTS : FIELD_OPTS_STOCKS;

  const reparse = (t) => { setText(t); setParsed(t.trim() ? parseImportText(t, kind) : null); };
  const setMap = (i, f) => setParsed((p) => {
    const m = p.mapping.slice();
    if (f !== 'skip') m.forEach((v, j) => { if (v === f && j !== i) m[j] = 'skip'; });
    m[i] = f;
    return { ...p, mapping: m };
  });
  const result = parsed ? rowsToRecords(parsed.rows, parsed.mapping, kind, startIdx) : null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900 p-4" style={{ backgroundColor: 'rgba(15,23,42,0.55)' }}>
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="text-sm font-bold uppercase tracking-wider text-slate-700">
            Import {kind === 'parts' ? 'parts' : 'blanks'}
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="flex-1 space-y-3 overflow-auto p-4">
          <div className="flex items-center gap-2">
            <button onClick={() => fileRef.current && fileRef.current.click()}
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
              <Upload size={14} /> Open CSV / TXT file
            </button>
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="hidden"
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                const rd = new FileReader();
                rd.onload = () => reparse(String(rd.result || ''));
                rd.readAsText(f);
                e.target.value = '';
              }} />
            <div className="text-xs text-slate-500">or paste rows from Excel / Sheets below</div>
          </div>
          <textarea
            value={text}
            onChange={(e) => reparse(e.target.value)}
            placeholder={kind === 'parts'
              ? 'Label\tLength\tWidth\tQty\tTurn\nPLENUM\t46\t22\t8\tY\nRUNNER\t5\' 0"\t10\t12\tN'
              : 'Label\tLength\tWidth\tQty\n120x48\t10\'\t48\tunl\n96x48\t96\t48\t10'}
            className="h-32 w-full rounded border border-slate-300 p-2 font-mono text-xs outline-none focus:border-blue-600"
          />
          {parsed && (
            <div className="space-y-2">
              <div className="text-xs text-slate-500">
                Detected {parsed.rows.length} data row{parsed.rows.length === 1 ? '' : 's'}
                {parsed.hadHeader ? ' (header row recognized)' : ''}. Assign each column, dimensions accept 48, 48 1/2, or 4&#39;-6&quot;.
              </div>
              <div className="overflow-auto rounded border border-slate-200">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-slate-100">
                    <tr>
                      {parsed.mapping.map((m, i) => (
                        <th key={i} className="border-b border-slate-200 px-1 py-1">
                          <select value={m} onChange={(e) => setMap(i, e.target.value)}
                            className="w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-xs">
                            {fieldOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 6).map((r, ri) => (
                      <tr key={ri} className={ri % 2 ? 'bg-slate-50' : ''}>
                        {r.map((c, ci) => <td key={ci} className="px-2 py-1 font-mono">{c}</td>)}
                      </tr>
                    ))}
                    {parsed.rows.length > 6 && (
                      <tr><td colSpan={parsed.ncol} className="px-2 py-1 text-center text-slate-400">… {parsed.rows.length - 6} more</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-500">
            {result ? `${result.recs.length} ready${result.skipped ? ` · ${result.skipped} row(s) skipped (bad dimensions)` : ''}` : 'Waiting for data'}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Cancel</button>
            <button
              disabled={!result || !result.recs.length}
              onClick={() => { onImport(result.recs); onClose(); }}
              className={cls('rounded px-3 py-1.5 text-sm font-semibold text-white',
                result && result.recs.length ? 'bg-blue-700 hover:bg-blue-800' : 'cursor-not-allowed bg-slate-300')}>
              Add {result ? result.recs.length : 0} {kind === 'parts' ? 'parts' : 'blanks'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print document
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Grouping results UI
// ---------------------------------------------------------------------------

const POLICY_LABELS = { auto: 'Auto', keepTogether: 'Keep together', noPreference: 'Normal', cleanup: 'Cut last' };
const fmtPP = (v) => (v == null ? '—' : (Math.abs(v) < 0.005 ? '0.00' : v.toFixed(2)));
const fmtDeltaN = (v) => (v == null ? '—' : (v === 0 ? '±0' : (v > 0 ? `+${v}` : `${v}`)));

function GroupingImpactCard({ result, level }) {
  const b = result.benchmark.sol.stats;
  const bm = result.benchmark.metrics.plan;
  const st = level.sol.stats;
  const mp = level.groupingMetrics.plan;
  const valid = level.comparisonValid;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const Row = ({ label, a, c, d, strong }) => (
    <tr className={cls('border-b border-slate-100', strong && 'bg-emerald-50/40')}>
      <td className={cls('py-1 pr-2', strong ? 'font-semibold text-slate-700' : 'text-slate-500')}>{label}</td>
      <td className={cls('py-1 text-right font-mono', strong && 'text-base font-bold')}>{a}</td>
      <td className={cls('py-1 text-right font-mono', strong && 'text-base font-bold text-emerald-700')}>{c}</td>
      <td className="py-1 pl-2 text-right font-mono text-xs text-slate-500">{d}</td>
    </tr>
  );
  const lossPP = level.yieldLossPP;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-600">Grouping impact</div>
        <div className="text-xs text-slate-500">Gross yield is the honest comparison — net yield can move when remnant credit shifts.</div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            <th className="py-1 pr-2 text-left font-semibold"> </th>
            <th className="py-1 text-right font-semibold">
              Best yield found — grouping off{' '}
              <span className="cursor-help text-slate-400" title="Highest-yield ungrouped plan found within the selected search effort. ShearPlan uses a heuristic search and does not certify a mathematical optimum.">ⓘ</span>
            </th>
            <th className="py-1 text-right font-semibold">Selected grouped plan — {level.label}</th>
            <th className="py-1 pl-2 text-right font-semibold">Δ</th>
          </tr>
        </thead>
        <tbody>
          <Row strong label="Gross yield" a={pct(b.grossYield)} c={pct(st.grossYield)}
            d={valid ? (lossPP > 0.005 ? `−${fmtPP(lossPP)} pp` : lossPP < -0.005 ? `+${fmtPP(-lossPP)} pp` : '±0.00 pp') : 'n/a'} />
          <Row label="Net yield" a={pct(b.netYield)} c={pct(st.netYield)}
            d={valid ? `${((st.netYield - b.netYield) * 100) >= 0 ? '+' : '−'}${Math.abs((st.netYield - b.netYield) * 100).toFixed(2)} pp` : 'n/a'} />
          <Row label="Blanks used" a={b.sheetsUsed} c={st.sheetsUsed} d={valid ? fmtDeltaN(st.sheetsUsed - b.sheetsUsed) : 'n/a'} />
          <Row label="Total blank area" a={fmtArea(b.usedArea)} c={fmtArea(st.usedArea)}
            d={valid && level.usedAreaDeltaPct != null ? `${level.usedAreaDeltaPct >= 0 ? '+' : '−'}${Math.abs(level.usedAreaDeltaPct).toFixed(1)}%` : 'n/a'} />
          {b.costMode && st.costMode && (
            <Row label="Material cost" a={b.totalCost.toFixed(2)} c={st.totalCost.toFixed(2)}
              d={valid && level.costDelta != null ? (level.costDelta === 0 ? '±0' : `${level.costDelta > 0 ? '+' : '−'}${Math.abs(level.costDelta).toFixed(2)}`) : 'n/a'} />
          )}
          <Row label="Remnants kept" a={fmtArea(b.remnantArea)} c={fmtArea(st.remnantArea)} d=" " />
          <Row label="Total cuts" a={b.cutCount} c={st.cutCount} d={fmtDeltaN(st.cutCount - b.cutCount)} />
          <Row label="Gauge settings" a={b.totalGaugeSettings} c={st.totalGaugeSettings} d={fmtDeltaN(st.totalGaugeSettings - b.totalGaugeSettings)} />
          <Row label="Family-sheet touches" a={bm.familySheetTouches} c={mp.familySheetTouches} d={fmtDeltaN(mp.familySheetTouches - bm.familySheetTouches)} />
          <Row label="Families at best-known minimum" a={`${bm.familiesAtBestKnownMinimum}/${bm.quantityFamilyCount}`} c={`${mp.familiesAtBestKnownMinimum}/${mp.quantityFamilyCount}`}
            d={fmtDeltaN(mp.familiesAtBestKnownMinimum - bm.familiesAtBestKnownMinimum)} />
          <Row label="Cleanup sheets" a={bm.cleanupSheetCount} c={mp.cleanupSheetCount} d={fmtDeltaN(mp.cleanupSheetCount - bm.cleanupSheetCount)} />
          {mp.cleanupSingletonCount > 0 && (
            <Row label="Singletons held for cleanup" a={`${bm.cleanupSingletonsNotEarly}/${bm.cleanupSingletonCount}`}
              c={`${mp.cleanupSingletonsNotEarly}/${mp.cleanupSingletonCount}`} d=" " />
          )}
        </tbody>
      </table>
      {!valid && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
          This plan places a different part quantity than the ungrouped benchmark — yield deltas are not comparable.
        </div>
      )}
    </div>
  );
}

function LevelCompareTable({ result, activeAggr, onPick }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-baseline justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-600">Grouping levels — same search, five answers</div>
        <div className="text-xs text-slate-400">Click a row to preview it — no re-run needed</div>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200">
            <Th>Level</Th>
            <Th className="text-right">Gross</Th>
            <Th className="text-right">Loss</Th>
            <Th className="text-right">Net</Th>
            <Th className="text-right">Blanks</Th>
            <Th className="text-right">Touches</Th>
            <Th className="text-right">At min</Th>
            <Th className="text-right">Cleanup</Th>
          </tr>
        </thead>
        <tbody>
          {result.levelResults.map((l) => {
            const active = l.aggression === activeAggr;
            const mp = l.groupingMetrics.plan;
            return (
              <tr key={l.aggression} onClick={() => onPick(l.aggression)}
                className={cls('cursor-pointer border-b border-slate-100', active ? 'bg-blue-50' : 'hover:bg-slate-50')}>
                <td className="px-2 py-1.5">
                  <span className={cls('font-semibold', active && 'text-blue-800')}>{l.label}</span>
                  {l.aggression === result.selectedAggression && (
                    <span className="ml-1.5 rounded bg-blue-100 px-1 text-xs font-semibold text-blue-700">Selected</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">{(l.grossYield * 100).toFixed(1)}%</td>
                <td className="px-2 py-1.5 text-right font-mono text-slate-500">{l.yieldLossPP == null ? '—' : `${fmtPP(l.yieldLossPP)} pp`}</td>
                <td className="px-2 py-1.5 text-right font-mono">{(l.netYield * 100).toFixed(1)}%</td>
                <td className="px-2 py-1.5 text-right font-mono">{l.sheetsUsed}</td>
                <td className="px-2 py-1.5 text-right font-mono">{mp.familySheetTouches}</td>
                <td className="px-2 py-1.5 text-right font-mono">{mp.familiesAtBestKnownMinimum}/{mp.quantityFamilyCount}</td>
                <td className="px-2 py-1.5 text-right font-mono">{mp.cleanupSheetCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PartGroupingTable({ result, level, open, setOpen }) {
  const byPidBase = new Map(result.benchmark.metrics.families.map((f) => [f.pid, f]));
  const byPidSel = new Map(level.groupingMetrics.families.map((f) => [f.pid, f]));
  const rangeOf = (f) => {
    if (!f || !f.sheetsUsed) return '—';
    const r = f.firstSheet === f.lastSheet ? `Sheet ${f.firstSheet}` : `Sheets ${f.firstSheet}–${f.lastSheet}`;
    return f.sheetRuns > 1 ? `${r} (${f.sheetRuns} runs)` : r;
  };
  const statusOf = (f, b) => {
    if (!f) return ['—', 'text-slate-400'];
    if (f.keepTogether && (f.sheetRuns > 1 || f.sheetsUsed > f.idealSheets)) return ['Keep-together warning', 'text-amber-700 font-semibold'];
    if (f.cleanup) return ['Cleanup', 'text-slate-500'];
    if (b && f.sheetsUsed < b.sheetsUsed) return ['Improved', 'text-emerald-700 font-semibold'];
    if (f.sheetsUsed > f.idealSheets) return ['Above best known', 'text-slate-600'];
    return ['At best known', 'text-slate-500'];
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-600">Per-part grouping detail</span>
        <span className="text-xs text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <table className="w-full border-collapse border-t border-slate-200 text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <Th>Part</Th><Th className="text-right">Qty</Th><Th>Policy</Th>
              <Th className="text-right">Ungrouped blanks</Th><Th className="text-right">Grouped blanks</Th>
              <Th className="text-right">Best known</Th><Th>Production range</Th><Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {result.grouping.famCtxList.map((fam) => {
              const b = byPidBase.get(fam.pid);
              const f = byPidSel.get(fam.pid);
              const [txt, cl] = statusOf(f, b);
              return (
                <tr key={fam.pid} className="border-b border-slate-100">
                  <td className="px-2 py-1 font-mono text-xs">{fam.label || fam.pid}</td>
                  <td className="px-2 py-1 text-right font-mono">{fam.qty}</td>
                  <td className="px-2 py-1 text-xs">{POLICY_LABELS[fam.policy] || fam.policy}</td>
                  <td className="px-2 py-1 text-right font-mono">{b ? b.sheetsUsed : '—'}</td>
                  <td className="px-2 py-1 text-right font-mono font-semibold">{f ? f.sheetsUsed : '—'}</td>
                  <td className="px-2 py-1 text-right font-mono text-slate-500">{f ? f.idealSheets : '—'}</td>
                  <td className="px-2 py-1 font-mono text-xs">{rangeOf(f)}</td>
                  <td className={cls('px-2 py-1 text-xs', cl)}>{txt}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {open && (
        <div className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-400">
          Best known = fewest blanks this part alone needed in any plan this run — a search result, not a proven minimum.
        </div>
      )}
    </div>
  );
}

function PrintDoc({ plan, sol, fmt, opts, colorOf, groupingInfo }) {
  const s = plan.settings;
  const today = new Date().toLocaleDateString();
  const runsArr = (sol && sol.runs) || [];
  const stockUse = useMemo(() => {
    const m = new Map();
    if (sol) for (const sh of sol.sheets) {
      const k = sh.stock.id;
      if (!m.has(k)) m.set(k, { stock: sh.stock, n: 0 });
      m.get(k).n++;
    }
    return [...m.values()];
  }, [sol]);
  const placedByPid = useMemo(() => {
    const m = new Map();
    if (sol) for (const sh of sol.sheets) for (const p of sh.placements) m.set(p.pid, (m.get(p.pid) || 0) + 1);
    return m;
  }, [sol]);
  if (!sol) return null;
  const labelCards = [];
  if (opts.labels) {
    runsArr.forEach((g, gi) => {
      const byPid = new Map();
      for (const p of g.layout.placements) {
        if (!byPid.has(p.pid)) byPid.set(p.pid, { p, n: 0 });
        byPid.get(p.pid).n++;
      }
      for (const { p, n } of byPid.values()) labelCards.push({ p, n, gi, repeat: g.repeat });
    });
  }
  return (
    <div className="printdoc bg-white text-slate-900" style={{ fontSize: 12 }}>
      {/* title block */}
      <div className="mb-3 grid grid-cols-4 border-2 border-slate-900 text-xs">
        <div className="col-span-2 border-r border-slate-900 px-3 py-2">
          <div className="text-xs uppercase tracking-widest text-slate-500">Cutting plan</div>
          <div className="text-xl font-bold">{plan.name || 'Untitled job'}</div>
        </div>
        <div className="border-r border-slate-900 px-3 py-2">
          <div className="text-xs uppercase tracking-widest text-slate-500">Date</div>
          <div className="font-mono">{today}</div>
          <div className="mt-1 text-xs uppercase tracking-widest text-slate-500">Cutting type</div>
          <div>{(CUT_TYPES[s.cutType] || {}).label || s.cutType}</div>
        </div>
        <div className="px-3 py-2">
          <div className="text-xs uppercase tracking-widest text-slate-500">Kerf H / V</div>
          <div className="font-mono">{fmtDim(s.kerfH, fmt)} / {fmtDim(s.kerfV, fmt)}</div>
          <div className="mt-1 text-xs uppercase tracking-widest text-slate-500">Trims L·R·T·B</div>
          <div className="font-mono">{fmtDim(s.trimL, fmt)} · {fmtDim(s.trimR, fmt)} · {fmtDim(s.trimT, fmt)} · {fmtDim(s.trimB, fmt)}</div>
        </div>
      </div>

      {opts.summary && (
        <div className="avoid-break mb-4">
          <div className="mb-1 border-b-2 border-slate-900 text-sm font-bold uppercase tracking-wider">Job summary</div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <table className="w-full border-collapse text-xs">
                <tbody>
                  <tr><td className="py-0.5 text-slate-500">Blanks used</td><td className="py-0.5 text-right font-mono font-bold">{sol.stats.sheetsUsed}</td></tr>
                  {stockUse.map(({ stock, n }) => (
                    <tr key={stock.id}><td className="py-0.5 pl-3 text-slate-500">{stock.label || `${fmtDim(stock.len, fmt)} × ${fmtDim(stock.wid, fmt)}`}</td><td className="py-0.5 text-right font-mono">{n}</td></tr>
                  ))}
                  <tr><td className="py-0.5 text-slate-500">Net yield</td><td className="py-0.5 text-right font-mono font-bold">{(sol.stats.netYield * 100).toFixed(1)}%</td></tr>
                  <tr><td className="py-0.5 text-slate-500">Gross yield</td><td className="py-0.5 text-right font-mono">{(sol.stats.grossYield * 100).toFixed(1)}%</td></tr>
                  <tr><td className="py-0.5 text-slate-500">Remnants kept</td><td className="py-0.5 text-right font-mono">{fmtArea(sol.stats.remnantArea)}</td></tr>
                  <tr><td className="py-0.5 text-slate-500">Total cuts</td><td className="py-0.5 text-right font-mono">{sol.stats.cutCount}</td></tr>
                  {sol.stats.costMode && <tr><td className="py-0.5 text-slate-500">Material cost</td><td className="py-0.5 text-right font-mono font-bold">{sol.stats.totalCost.toFixed(2)}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="col-span-2">
              <table className="w-full border-collapse border border-slate-400 text-xs">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border border-slate-400 px-2 py-1 text-left">Part</th>
                    <th className="border border-slate-400 px-2 py-1 text-right">Size</th>
                    <th className="border border-slate-400 px-2 py-1 text-right">Qty</th>
                    <th className="border border-slate-400 px-2 py-1 text-right">Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.parts.filter((p) => p.qty > 0 && !Number.isNaN(p.len)).map((p) => (
                    <tr key={p.id}>
                      <td className="border border-slate-400 px-2 py-0.5 font-mono">{p.label}</td>
                      <td className="border border-slate-400 px-2 py-0.5 text-right font-mono">{fmtDim(p.len, fmt)} × {fmtDim(p.wid, fmt)}</td>
                      <td className="border border-slate-400 px-2 py-0.5 text-right font-mono">{p.qty}</td>
                      <td className="border border-slate-400 px-2 py-0.5 text-right font-mono">{placedByPid.get(p.id) || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sol.uncutCount > 0 && (
                <div className="mt-1 border-2 border-red-600 px-2 py-1 text-xs font-bold text-red-700">
                  {sol.uncutCount} PART(S) DID NOT FIT — see Placed column. Add blanks or review sizes.
                </div>
              )}
            </div>
          </div>
          {groupingInfo && groupingInfo.level && groupingInfo.benchmark && (() => {
            const lv = groupingInfo.level;
            const b = groupingInfo.benchmark.sol.stats;
            const bm = groupingInfo.benchmark.metrics.plan;
            const mp = lv.groupingMetrics.plan;
            return (
              <div className="mt-2 border border-slate-500 px-2 py-1.5 text-xs">
                <span className="font-bold uppercase tracking-wider">Part grouping: </span>
                <span className="font-mono">
                  level {lv.label}
                  {' · gross '}{(b.grossYield * 100).toFixed(1)}% → {(lv.grossYield * 100).toFixed(1)}%
                  {lv.yieldLossPP != null ? ` (−${Math.max(0, lv.yieldLossPP).toFixed(2)} pp)` : ''}
                  {' · blanks '}{b.sheetsUsed} → {lv.sheetsUsed}
                  {' · family-sheet touches '}{bm.familySheetTouches} → {mp.familySheetTouches}
                  {mp.cleanupSheetCount > 0 ? ` · cleanup sheets ${mp.cleanupSheetCount}` : ''}
                </span>
                {lv.warnings.filter((w) => !w.startsWith('No grouping improvement')).map((w, i) => (
                  <div key={i} className="mt-0.5 font-semibold text-amber-700">⚠ {w}</div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {opts.layouts && runsArr.map((g, gi) => (
        <div key={gi} className={cls((gi > 0 || opts.summary) && 'pbreak', 'pt-2')}>
          <div className="mb-1 flex items-end justify-between border-b-2 border-slate-900 pb-1">
            <div className="text-sm font-bold uppercase tracking-wider">
              Run {gi + 1} of {runsArr.length}
              {' — '}Sheet{g.startSheet === g.endSheet ? ` ${g.startSheet}` : `s ${g.startSheet}–${g.endSheet}`}
              {g.cleanup ? ' — cleanup' : ''}
            </div>
            <div className="font-mono text-xs">
              Blank {g.layout.stock.label || ''} {fmtDim(g.layout.stock.len, fmt)} × {fmtDim(g.layout.stock.wid, fmt)}
              {' — '}<span className="font-bold">cut {g.repeat} identical</span>
              {' — net '}{(g.layout.netYield * 100).toFixed(1)}%
            </div>
          </div>
          <LayoutSVG layout={g.layout} fmt={fmt} colorOf={colorOf} selCut={-1}
            showCutNumbers={opts.cuts} interactive={false} maxH={430} />
          {g.layout.offcuts.some((o) => o.type === 'remnant') && (
            <div className="mb-1 text-xs">
              <span className="font-bold uppercase tracking-wider">Save remnants: </span>
              {g.layout.offcuts.filter((o) => o.type === 'remnant').map((o, i) => (
                <span key={i} className="mr-2 font-mono">{fmtDim(o.l, fmt)} × {fmtDim(o.w, fmt)}</span>
              ))}
            </div>
          )}
          {opts.cuts && (
            <div className="avoid-break">
              <div className="mb-0.5 text-xs font-bold uppercase tracking-wider">
                Cut sequence — {g.layout.cuts.length} cuts · {g.layout.gaugeSettings} gauge settings
                {(plan.settings.trimL || plan.settings.trimR || plan.settings.trimT || plan.settings.trimB) ? ' · square/trim edges first' : ''}
              </div>
              <CutTable layout={g.layout} fmt={fmt} selCut={-1} setSelCut={null} compact />
            </div>
          )}
        </div>
      ))}

      {opts.labels && labelCards.length > 0 && (
        <div className={cls((opts.summary || opts.layouts) && 'pbreak', 'pt-2')}>
          <div className="mb-2 border-b-2 border-slate-900 text-sm font-bold uppercase tracking-wider">Part labels</div>
          <div className="grid grid-cols-3 gap-2">
            {labelCards.map((c, i) => (
              <div key={i} className="avoid-break border-2 border-slate-800 p-2">
                <div className="text-lg font-bold leading-tight">{c.p.label}</div>
                <div className="font-mono text-sm">{fmtDim(c.p.l, fmt)} × {fmtDim(c.p.w, fmt)}</div>
                <div className="mt-1 text-xs text-slate-600">
                  Run {c.gi + 1} · {c.n}/blank × {c.repeat} blank{c.repeat > 1 ? 's' : ''}
                </div>
                <div className="text-xs text-slate-500">{plan.name}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const PRINT_CSS = `
@media print {
  @page { size: letter; margin: 0.45in; }
  html, body { background: #fff !important; }
  .print-hide { display: none !important; }
  .printdoc { display: block !important; }
  .pbreak { break-before: page; page-break-before: always; }
  .avoid-break { break-inside: avoid; page-break-inside: avoid; }
}
`;

const STORE_KEY = 'shearplan2d-plans-v1';
const storageOK = () => { try { return typeof window !== 'undefined' && !!window.storage && typeof window.storage.get === 'function'; } catch (e) { return false; } };

export default function App() {
  const [plan, setPlan] = useState(() => ({
    name: 'Untitled job',
    stocks: [],
    parts: [],
    settings: { ...DEFAULT_SETTINGS },
  }));
  const [tab, setTab] = useState('stocks');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [selRun, setSelRun] = useState(0);
  const [selCut, setSelCut] = useState(-1);
  const [pickedPart, setPickedPart] = useState(null);
  const [activeAggr, setActiveAggr] = useState(null);
  const [partDetailsOpen, setPartDetailsOpen] = useState(false);
  const baselineCacheRef = useRef(null); // { hash, baselineSol, bestGrossYieldSol, estimates, iters, ms }
  const [importKind, setImportKind] = useState(null);
  const [openModal, setOpenModal] = useState(false);
  const [savedList, setSavedList] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reportOpts, setReportOpts] = useState({ summary: true, layouts: true, cuts: true, labels: false });
  const stopRef = useRef(false);
  const jsonRef = useRef(null);

  const fmt = { dispFormat: plan.settings.dispFormat, fracDen: plan.settings.fracDen };
  const s = plan.settings;

  const say = (msg, type = 'info') => {
    setNotice({ msg, type });
    setTimeout(() => setNotice((n) => (n && n.msg === msg ? null : n)), 3500);
  };

  const setSettings = (patch) => setPlan((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  const setStocks = (fn) => setPlan((p) => ({ ...p, stocks: fn(p.stocks) }));
  const setParts = (fn) => setPlan((p) => ({ ...p, parts: fn(p.parts) }));

  const validStocks = plan.stocks.filter((x) => x.len > 0 && x.wid > 0 && (x.qty === null || x.qty > 0));
  const validParts = plan.parts.filter((x) => x.len > 0 && x.wid > 0 && x.qty > 0);
  const totalPieces = validParts.reduce((a, p) => a + p.qty, 0);
  const partsArea = validParts.reduce((a, p) => a + p.qty * p.len * p.wid, 0);

  const colorOf = (pid) => {
    const p = plan.parts.find((x) => x.id === pid);
    return (p && p.color) || '#dbe4ee';
  };

  const hashNow = planHashes(plan);
  const stale = result && result.hash !== hashNow.full;

  // The plan shown everywhere (viewer, banners, tables, print) is the active
  // comparison level's solution when grouping ran; picking another row in the
  // comparison table swaps it without re-running the search.
  const activeLevel = result && result.levelResults
    ? (result.levelResults.find((l) => l.aggression === (activeAggr != null ? activeAggr : result.selectedAggression)) ||
      result.levelResults.find((l) => l.aggression === result.selectedAggression) ||
      result.levelResults[0])
    : null;
  const activeSol = activeLevel ? activeLevel.sol : (result ? result.sol : null);

  const usedByStock = useMemo(() => {
    const m = new Map();
    if (activeSol) for (const sh of activeSol.sheets) m.set(sh.stock.id, (m.get(sh.stock.id) || 0) + 1);
    return m;
  }, [activeSol]);
  const placedByPid = useMemo(() => {
    const m = new Map();
    if (activeSol) for (const sh of activeSol.sheets) for (const p of sh.placements) m.set(p.pid, (m.get(p.pid) || 0) + 1);
    return m;
  }, [activeSol]);

  // ------------------------------------------------------------------ optimize
  // Both paths delegate the search loops to runSearch (engine). With grouping
  // off, mode 'existing' reproduces the original search exactly — including
  // its time-seeded RNG — so results match the pre-grouping app. With
  // grouping on, four phases run in sequence and each search phase gets the
  // full effort budget; the ungrouped baseline is cached and reused when
  // only grouping knobs change.
  const optimize = async () => {
    if (running) { stopRef.current = true; return; }
    if (!validStocks.length) { say('Add at least one blank with a length and width.', 'warn'); setTab('stocks'); return; }
    if (!validParts.length) { say('Add at least one part with a length, width, and quantity.', 'warn'); setTab('parts'); return; }
    const oversize = findOversize(validParts, validStocks, s);
    const usableParts = validParts.filter((p) => !oversize.includes(p));
    if (!usableParts.length) { say('Every part is larger than every blank (check trims and sizes).', 'warn'); return; }
    const runHashes = planHashes(plan);
    stopRef.current = false;
    setRunning(true);
    const budget = s.effortSec * 1000;
    const t0 = performance.now();
    const shouldStop = () => stopRef.current;
    const onProg = (phase) => ({ elapsed, iters, best }) =>
      setProgress((pr) => ({
        phase,
        iters: iters != null ? iters : (pr ? pr.iters : 0),
        elapsed: elapsed != null ? elapsed : 0,
        denomMs: budget,
        best: best !== undefined ? best : (pr ? pr.best : null),
      }));
    const finish = (res) => {
      setResult(res);
      setRunning(false);
      setProgress(null);
      setActiveAggr(res && res.selectedAggression != null ? res.selectedAggression : null);
      setSelRun(0); setSelCut(-1); setPickedPart(null); setPartDetailsOpen(false);
      setTab('results');
    };

    if (!s.groupingEnabled) {
      setProgress({ phase: null, iters: 0, elapsed: 0, denomMs: budget, best: null });
      await sleep(20);
      const r = await runSearch({
        stocks: validStocks, parts: usableParts, settings: s,
        mode: 'existing', budgetMs: budget, seed: null,
        onProgress: onProg(null), shouldStop,
      });
      if (!r.sol) { setRunning(false); setProgress(null); say('Stopped before any layout was found.', 'warn'); return; }
      finish({ sol: r.sol, hash: runHashes.full, baselineHash: runHashes.baseline, oversize, iters: r.iters, ms: performance.now() - t0, grouping: null });
      return;
    }

    // -------- grouping on: baseline → families → grouped search → selection
    const seeds = deriveSeeds(runHashes.baseline);
    let base = baselineCacheRef.current && baselineCacheRef.current.hash === runHashes.baseline
      ? baselineCacheRef.current : null;
    if (!base) {
      setProgress({ phase: 'Searching ungrouped baseline', iters: 0, elapsed: 0, denomMs: budget, best: null });
      await sleep(20);
      const br = await runSearch({
        stocks: validStocks, parts: usableParts, settings: s,
        mode: 'baseline', budgetMs: budget, seed: seeds.baselineSeed,
        onProgress: onProg('Searching ungrouped baseline'), shouldStop,
      });
      if (!br.sol) { setRunning(false); setProgress(null); say('Stopped before any layout was found.', 'warn'); return; }
      base = { hash: runHashes.baseline, baselineSol: br.sol, bestGrossYieldSol: br.bestGrossYieldSol || br.sol, estimates: null, iters: br.iters, ms: br.ms };
      if (!stopRef.current) baselineCacheRef.current = base; // never cache a truncated baseline
    }
    if (stopRef.current) {
      // Stopped during the baseline phase — keep the best ungrouped plan
      // found so far, exactly like a grouping-off stop.
      tagRunsCleanup(base.baselineSol, buildFamilies(usableParts, s).cleanupPids);
      finish({ sol: base.baselineSol, hash: runHashes.full, baselineHash: runHashes.baseline, oversize, iters: base.iters, ms: performance.now() - t0, grouping: null });
      say('Stopped during the baseline search — showing the best ungrouped plan found.', 'warn');
      return;
    }

    setProgress({ phase: 'Analyzing part families', iters: 0, elapsed: 0, denomMs: null, best: null });
    await sleep(0);
    const gctx = buildFamilies(usableParts, s);
    if (!base.estimates) base.estimates = estimateAllFamilies(gctx.families, validStocks, s, { seed: seeds.familyEstimateSeed });
    const estimates = base.estimates;

    setProgress({ phase: 'Searching grouped candidates', iters: 0, elapsed: 0, denomMs: budget, best: null });
    await sleep(0);
    const gr = await runSearch({
      stocks: validStocks, parts: usableParts, settings: s,
      mode: 'grouped', budgetMs: budget, seed: seeds.groupedSeed,
      baseline: { baselineSol: base.baselineSol, bestGrossYieldSol: base.bestGrossYieldSol },
      familyEstimates: estimates, familySeed: seeds.familyEstimateSeed,
      onProgress: onProg('Searching grouped candidates'), shouldStop,
    });

    setProgress({ phase: 'Selecting comparison plans', iters: 0, elapsed: 0, denomMs: null, best: null });
    await sleep(0);
    const selectedAggression = Math.max(0, Math.min(100, Math.round(s.groupingAggression ?? 50)));
    if (!gr || !gr.archive || !gr.archive.length || !gr.benchmark) {
      tagRunsCleanup(base.baselineSol, gctx.cleanupPids);
      finish({ sol: base.baselineSol, hash: runHashes.full, baselineHash: runHashes.baseline, oversize, iters: base.iters + (gr ? gr.iters : 0), ms: performance.now() - t0, grouping: null });
      say('The grouping search stopped before any grouped plan was found — showing the ungrouped result.', 'warn');
      return;
    }
    const levelResults = buildLevelResults({
      archive: gr.archive, benchmark: gr.benchmark, settings: s,
      sliderAggression: selectedAggression, ktRequired: gr.families.ktPids.size > 0,
    });
    const active = levelResults.find((l) => l.aggression === selectedAggression) || levelResults[0];
    tagRunsCleanup(base.baselineSol, gctx.cleanupPids);
    finish({
      sol: active.sol,
      baselineSol: base.baselineSol,
      bestGrossYieldSol: base.bestGrossYieldSol,
      benchmark: gr.benchmark,
      selectedAggression,
      levelResults,
      grouping: {
        famCtxList: gr.families.families.map((f) => ({ pid: f.pid, label: f.label, qty: f.qty, policy: f.policy })),
        idealByPid: gr.idealByPid,
        ktPids: gr.families.ktPids,
        cleanupPids: gr.families.cleanupPids,
        estimates,
      },
      oversize,
      baselineIters: base.iters, groupedIters: gr.iters,
      baselineMs: base.ms, groupedMs: gr.ms,
      iters: base.iters + gr.iters, ms: performance.now() - t0,
      hash: runHashes.full, baselineHash: runHashes.baseline,
    });
  };

  // ------------------------------------------------------------------ storage
  const loadSavedMap = async () => {
    if (!storageOK()) return {};
    try { const r = await window.storage.get(STORE_KEY); return r && r.value ? JSON.parse(r.value) : {}; }
    catch (e) { return {}; }
  };
  const savePlan = async () => {
    if (!storageOK()) { say('Saved plans are unavailable here — use Export file instead.', 'warn'); return; }
    try {
      const map = await loadSavedMap();
      map[plan.name || 'Untitled job'] = { plan, savedAt: Date.now() };
      await window.storage.set(STORE_KEY, JSON.stringify(map));
      say(`Saved "${plan.name}".`);
    } catch (e) { say('Save failed — use Export file instead.', 'warn'); }
  };
  const openSaved = async () => {
    const map = await loadSavedMap();
    setSavedList(Object.entries(map).map(([name, v]) => ({ name, savedAt: v.savedAt, plan: v.plan }))
      .sort((a, b) => b.savedAt - a.savedAt));
    setOpenModal(true);
  };
  const deleteSaved = async (name) => {
    try {
      const map = await loadSavedMap();
      delete map[name];
      await window.storage.set(STORE_KEY, JSON.stringify(map));
      setSavedList((l) => l.filter((x) => x.name !== name));
    } catch (e) { /* noop */ }
  };
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(plan.name || 'job').replace(/[^\w\- ]+/g, '')}.shearplan.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJSON = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(String(rd.result || ''));
        if (!p || !Array.isArray(p.stocks) || !Array.isArray(p.parts)) throw new Error('bad');
        setPlan({ name: p.name || 'Imported job', stocks: p.stocks, parts: normalizeParts(p.parts), settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) } });
        setResult(null);
        say('Plan file loaded.');
      } catch (e) { say('That file is not a ShearPlan job file.', 'warn'); }
    };
    rd.readAsText(file);
  };
  const newPlan = () => {
    setPlan({ name: 'Untitled job', stocks: [], parts: [], settings: { ...DEFAULT_SETTINGS } });
    setResult(null); setTab('stocks');
  };
  const loadSample = () => {
    setPlan((p) => ({
      ...p,
      name: p.name === 'Untitled job' ? 'Example — HVAC batch' : p.name,
      stocks: SAMPLE_STOCKS.map((x) => newStock(x)),
      parts: SAMPLE_PARTS.map((x, i) => newPart(i, x)),
    }));
    say('Example job loaded — press Optimize.');
  };

  const printReport = () => {
    setTab('report');
    setTimeout(() => window.print(), 250);
  };

  const runsList = activeSol && activeSol.runs ? activeSol.runs : [];
  const run = runsList[selRun] || runsList[0] || null;

  const onResultsKey = (e) => {
    if (!run) return;
    if (e.key === 'ArrowRight') { setSelCut((c) => Math.min(run.layout.cuts.length - 1, c + 1)); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setSelCut((c) => Math.max(-1, c - 1)); e.preventDefault(); }
  };

  const pickLevel = (aggr) => { setActiveAggr(aggr); setSelRun(0); setSelCut(-1); setPickedPart(null); };

  // ------------------------------------------------------------------ render
  const TabBtn = ({ id, children, badge }) => (
    <button onClick={() => setTab(id)}
      className={cls('relative border-b-2 px-3 py-2 text-sm font-semibold',
        tab === id ? 'border-blue-700 text-blue-800' : 'border-transparent text-slate-500 hover:text-slate-800')}>
      {children}
      {badge}
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <style>{PRINT_CSS}</style>

      {/* ============================== chrome ============================== */}
      <div className="print-hide print:hidden">
        {/* header */}
        <div className="border-b border-slate-300 bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded bg-slate-900 text-white">
                <Scissors size={16} />
              </div>
              <div className="leading-tight">
                <div className="text-sm font-black uppercase tracking-wider">ShearPlan 2D</div>
                <div className="text-xs text-slate-500">Guillotine nesting for sheet metal</div>
              </div>
            </div>
            <div className="mx-2 hidden h-6 w-px bg-slate-200 sm:block" />
            <TextInput value={plan.name} onCommit={(v) => setPlan((p) => ({ ...p, name: v || 'Untitled job' }))}
              className="w-48 border-slate-200 font-semibold" placeholder="Job name" />
            <div className="ml-auto flex items-center gap-1.5">
              <select value={s.dispFormat + ':' + s.fracDen}
                onChange={(e) => {
                  const [d, f] = e.target.value.split(':');
                  setSettings({ dispFormat: d, fracDen: parseInt(f, 10) });
                }}
                className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs" title="Display format">
                <option value="frac:16">Inches — 1/16</option>
                <option value="frac:32">Inches — 1/32</option>
                <option value="frac:8">Inches — 1/8</option>
                <option value="ftin:16">Feet-inches — 1/16</option>
                <option value="ftin:32">Feet-inches — 1/32</option>
                <option value="dec:16">Decimal inches</option>
              </select>
              <button onClick={newPlan} title="New job" className="rounded border border-slate-300 bg-white p-2 hover:bg-slate-50"><FileText size={15} /></button>
              <button onClick={savePlan} title="Save plan" className="rounded border border-slate-300 bg-white p-2 hover:bg-slate-50"><Save size={15} /></button>
              <button onClick={openSaved} title="Open saved plan" className="rounded border border-slate-300 bg-white p-2 hover:bg-slate-50"><FolderOpen size={15} /></button>
              <button onClick={exportJSON} title="Export plan file" className="rounded border border-slate-300 bg-white p-2 hover:bg-slate-50"><Download size={15} /></button>
              <button onClick={() => jsonRef.current && jsonRef.current.click()} title="Open plan file" className="rounded border border-slate-300 bg-white p-2 hover:bg-slate-50"><Upload size={15} /></button>
              <input ref={jsonRef} type="file" accept=".json" className="hidden"
                onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) importJSON(f); e.target.value = ''; }} />
              <div className="mx-1 h-6 w-px bg-slate-200" />
              <button onClick={optimize}
                className={cls('inline-flex items-center gap-2 rounded px-4 py-2 text-sm font-bold text-white shadow',
                  running ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-700 hover:bg-blue-800')}>
                {running ? <Square size={14} /> : <Play size={14} />}
                {running ? 'Stop' : 'Optimize'}
              </button>
            </div>
          </div>
          {/* progress */}
          {running && progress && (
            <div className="border-t border-slate-200 bg-slate-50">
              <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-1.5 text-xs text-slate-600">
                {progress.phase && <div className="font-semibold text-blue-800">{progress.phase}…</div>}
                <div className="h-1.5 w-40 overflow-hidden rounded bg-slate-200">
                  <div className={cls('h-full bg-blue-600', progress.denomMs == null && 'animate-pulse')}
                    style={{ width: progress.denomMs == null ? '100%' : `${Math.min(100, (progress.elapsed / progress.denomMs) * 100)}%` }} />
                </div>
                <div className="font-mono">{progress.iters.toLocaleString()} attempts</div>
                {progress.best && (
                  <div className="font-mono">
                    best: {progress.best.sheets} blank{progress.best.sheets === 1 ? '' : 's'} · net {(progress.best.net * 100).toFixed(1)}%
                    {progress.best.uncut > 0 ? ` · ${progress.best.uncut} uncut` : ''}
                  </div>
                )}
                <div className="ml-auto">Stop keeps the best result found so far</div>
              </div>
            </div>
          )}
          {/* tabs */}
          <div className="mx-auto flex max-w-6xl items-center px-4">
            <TabBtn id="stocks">Blanks <span className="ml-1 rounded bg-slate-200 px-1.5 text-xs font-mono">{validStocks.length}</span></TabBtn>
            <TabBtn id="parts">Parts <span className="ml-1 rounded bg-slate-200 px-1.5 text-xs font-mono">{totalPieces}</span></TabBtn>
            <TabBtn id="settings">Settings</TabBtn>
            <TabBtn id="results" badge={stale ? <span className="absolute -right-0.5 top-1.5 h-2 w-2 rounded-full bg-amber-500" /> : null}>Results</TabBtn>
            <TabBtn id="report">Report</TabBtn>
          </div>
        </div>

        {notice && (
          <div className={cls('mx-auto mt-3 max-w-6xl rounded border px-4 py-2 text-sm',
            notice.type === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900')}>
            {notice.msg}
          </div>
        )}

        <div className="mx-auto max-w-6xl px-4 py-4">
          {/* ============================ STOCKS ============================ */}
          {tab === 'stocks' && (
            <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                <div className="text-sm font-bold uppercase tracking-wider text-slate-700">Blanks — material to cut from</div>
                <div className="flex gap-2">
                  {plan.stocks.length === 0 && plan.parts.length === 0 && (
                    <button onClick={loadSample} className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Load example</button>
                  )}
                  <button onClick={() => setImportKind('stocks')} className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">
                    <ClipboardPaste size={14} /> Import
                  </button>
                  <button onClick={() => setStocks((st) => [...st, newStock()])}
                    className="inline-flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700">
                    <Plus size={14} /> Add blank
                  </button>
                </div>
              </div>
              {plan.stocks.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-slate-500">
                  No blanks yet. Add the sheet sizes you can cut from — set quantity, or mark a size unlimited to let the optimizer tell you how many to order.
                </div>
              ) : (
                <table className="w-full border-collapse">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      <Th className="w-36">Label</Th>
                      <Th className="w-28 text-right">Length</Th>
                      <Th className="w-28 text-right">Width</Th>
                      <Th className="w-20 text-right">Qty</Th>
                      <Th className="w-16">Unl.</Th>
                      <Th className="w-24 text-right">Cost/pc</Th>
                      <Th className="w-16 text-right">Used</Th>
                      <Th className="w-10"> </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.stocks.map((st) => (
                      <tr key={st.id} className="border-b border-slate-100">
                        <td className="px-2 py-1"><TextInput value={st.label} placeholder="e.g. 120 × 48"
                          onCommit={(v) => setStocks((a) => a.map((x) => x.id === st.id ? { ...x, label: v } : x))} /></td>
                        <td className="px-2 py-1"><DimInput value={st.len} fmt={fmt}
                          onCommit={(v) => setStocks((a) => a.map((x) => x.id === st.id ? { ...x, len: v } : x))} /></td>
                        <td className="px-2 py-1"><DimInput value={st.wid} fmt={fmt}
                          onCommit={(v) => setStocks((a) => a.map((x) => x.id === st.id ? { ...x, wid: v } : x))} /></td>
                        <td className="px-2 py-1">
                          {st.qty === null
                            ? <input disabled value="∞" className="w-full rounded border border-slate-200 bg-slate-100 px-2 py-1 text-center font-mono text-sm text-slate-500" />
                            : <IntInput value={st.qty} min={1}
                              onCommit={(v) => setStocks((a) => a.map((x) => x.id === st.id ? { ...x, qty: v } : x))} />}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <input type="checkbox" checked={st.qty === null}
                            onChange={(e) => setStocks((a) => a.map((x) => x.id === st.id ? { ...x, qty: e.target.checked ? null : 1 } : x))} />
                        </td>
                        <td className="px-2 py-1"><FloatInput value={st.cost} placeholder="—"
                          onCommit={(v) => setStocks((a) => a.map((x) => x.id === st.id ? { ...x, cost: v } : x))} /></td>
                        <td className="px-2 py-1 text-right font-mono text-sm text-slate-500">{usedByStock.get(st.id) || '—'}</td>
                        <td className="px-2 py-1 text-center">
                          <button onClick={() => setStocks((a) => a.filter((x) => x.id !== st.id))}
                            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={14} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
                Cost is optional — leave it blank for pure yield optimization, or use it to prioritize cheaper stock (lower cost is used first).
                Dimensions accept 48, 48 1/2, 48.5, or 4&#39;-6&quot;.
              </div>
            </div>
          )}

          {/* ============================ PARTS ============================ */}
          {tab === 'parts' && (
            <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                <div className="text-sm font-bold uppercase tracking-wider text-slate-700">Parts — pieces to cut</div>
                <div className="flex gap-2">
                  <button onClick={() => setImportKind('parts')} className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">
                    <ClipboardPaste size={14} /> Import
                  </button>
                  <button onClick={() => setParts((a) => [...a, newPart(a.length)])}
                    className="inline-flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700">
                    <Plus size={14} /> Add part
                  </button>
                </div>
              </div>
              {plan.parts.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-4 py-1.5 text-xs">
                  <span className="font-semibold text-slate-500">Grouping:</span>
                  <button onClick={() => { setParts((a) => a.map((x) => (x.qty > 1 ? { ...x, groupPolicy: 'auto' } : x))); say('Quantity parts set to Auto grouping.'); }}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100">Auto-group quantity parts</button>
                  <button onClick={() => { setParts((a) => a.map((x) => (x.qty === 1 ? { ...x, groupPolicy: 'cleanup' } : x))); say('Single-quantity parts marked Cut Last.'); }}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100">Mark singletons Cut Last</button>
                  <button onClick={() => { setParts((a) => a.map((x) => ({ ...x, groupPolicy: 'auto' }))); say('Grouping overrides cleared — all parts back to Auto.'); }}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100">Clear grouping overrides</button>
                  {!s.groupingEnabled && <span className="text-slate-400">Grouping is off — enable it in Settings for these to take effect.</span>}
                </div>
              )}
              {plan.parts.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-slate-500">
                  No parts yet. Add them by hand, or paste straight from your cut list in Excel with Import.
                </div>
              ) : (
                <table className="w-full border-collapse">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      <Th className="w-8"> </Th>
                      <Th>Label</Th>
                      <Th className="w-28 text-right">Length</Th>
                      <Th className="w-28 text-right">Width</Th>
                      <Th className="w-20 text-right">Qty</Th>
                      <Th className="w-20">Can turn</Th>
                      <Th className="w-32">Grouping</Th>
                      <Th className="w-20 text-right">Placed</Th>
                      <Th className="w-10"> </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.parts.map((p) => {
                      const placed = placedByPid.get(p.id) || 0;
                      const short = result && !stale && placed < p.qty;
                      return (
                        <tr key={p.id} className="border-b border-slate-100">
                          <td className="px-2 py-1"><span className="inline-block h-4 w-4 rounded border border-slate-300" style={{ backgroundColor: p.color }} /></td>
                          <td className="px-2 py-1"><TextInput value={p.label} placeholder="Part name"
                            onCommit={(v) => setParts((a) => a.map((x) => x.id === p.id ? { ...x, label: v } : x))} /></td>
                          <td className="px-2 py-1"><DimInput value={p.len} fmt={fmt}
                            onCommit={(v) => setParts((a) => a.map((x) => x.id === p.id ? { ...x, len: v } : x))} /></td>
                          <td className="px-2 py-1"><DimInput value={p.wid} fmt={fmt}
                            onCommit={(v) => setParts((a) => a.map((x) => x.id === p.id ? { ...x, wid: v } : x))} /></td>
                          <td className="px-2 py-1"><IntInput value={p.qty} min={0}
                            onCommit={(v) => setParts((a) => a.map((x) => x.id === p.id ? { ...x, qty: v } : x))} /></td>
                          <td className="px-2 py-1 text-center">
                            <input type="checkbox" checked={p.canTurn}
                              onChange={(e) => setParts((a) => a.map((x) => x.id === p.id ? { ...x, canTurn: e.target.checked } : x))} />
                          </td>
                          <td className="px-2 py-1">
                            <select value={normalizeGroupPolicy(p.groupPolicy)}
                              onChange={(e) => setParts((a) => a.map((x) => x.id === p.id ? { ...x, groupPolicy: e.target.value } : x))}
                              className="w-full rounded border border-slate-300 bg-white px-1 py-1 text-xs"
                              title="How the grouping search treats this part">
                              <option value="auto">Auto</option>
                              <option value="keepTogether">Keep together</option>
                              <option value="noPreference">Normal</option>
                              <option value="cleanup">Cut last</option>
                            </select>
                          </td>
                          <td className={cls('px-2 py-1 text-right font-mono text-sm', short ? 'font-bold text-red-600' : 'text-slate-500')}>
                            {result && !stale ? `${placed}/${p.qty}` : '—'}
                          </td>
                          <td className="px-2 py-1 text-center">
                            <button onClick={() => setParts((a) => a.filter((x) => x.id !== p.id))}
                              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={14} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
                {totalPieces} piece{totalPieces === 1 ? '' : 's'} · {fmtArea(partsArea)} of parts.
                Uncheck &quot;Can turn&quot; when grain or coating direction matters.
              </div>
            </div>
          )}

          {/* =========================== SETTINGS =========================== */}
          {tab === 'settings' && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Cutting</div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">Cutting type</label>
                <select value={s.cutType} onChange={(e) => setSettings({ cutType: e.target.value })}
                  className="mb-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm">
                  {CUT_TYPE_ORDER.map((k) => <option key={k} value={k}>{CUT_TYPES[k].label}</option>)}
                </select>
                <div className="mb-3 text-xs text-slate-500">
                  3 stages is the usual shear workflow: rip strips, cross-cut, trim to height. Unlimited stages squeezes the most yield but takes more handling.
                </div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">First cuts run</label>
                <select value={s.firstCut} onChange={(e) => setSettings({ firstCut: e.target.value })}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm">
                  <option value="auto">Auto — optimizer decides</option>
                  <option value="h">Along the length (full-length strips)</option>
                  <option value="v">Across the width (crosswise first)</option>
                </select>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Blade & edges</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Kerf — horizontal cuts</label>
                    <DimInput value={s.kerfH} fmt={fmt} onCommit={(v) => setSettings({ kerfH: v })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Kerf — vertical cuts</label>
                    <DimInput value={s.kerfV} fmt={fmt} onCommit={(v) => setSettings({ kerfV: v })} />
                  </div>
                </div>
                <div className="mb-3 mt-1 text-xs text-slate-500">A shear removes no material — leave kerf at 0. Set it for saws or plasma.</div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">Edge trims (unusable margin)</label>
                <div className="grid grid-cols-4 gap-2">
                  {[['trimL', 'Left'], ['trimR', 'Right'], ['trimT', 'Top'], ['trimB', 'Bottom']].map(([k, lbl]) => (
                    <div key={k}>
                      <div className="mb-0.5 text-center text-xs text-slate-400">{lbl}</div>
                      <DimInput value={s[k]} fmt={fmt} onCommit={(v) => setSettings({ [k]: v })} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Remnants</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Min remnant length</label>
                    <DimInput value={s.minRemL} fmt={fmt} onCommit={(v) => setSettings({ minRemL: v })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Min remnant width</label>
                    <DimInput value={s.minRemW} fmt={fmt} onCommit={(v) => setSettings({ minRemW: v })} />
                  </div>
                </div>
                <div className="mt-1 text-xs text-slate-500">Offcuts at least this size count as reusable drops — they&#39;re listed on the report and excluded from waste in net yield.</div>
                <label className="mb-1 mt-3 block text-xs font-semibold text-slate-500">Remnant preference — {s.remRate}</label>
                <input type="range" min={0} max={99} value={s.remRate}
                  onChange={(e) => setSettings({ remRate: parseInt(e.target.value, 10) })} className="w-full" />
                <div className="text-xs text-slate-500">Higher favors layouts that consolidate scrap into keepable drops.</div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Optimization</div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">Search effort</label>
                <select value={s.effortSec} onChange={(e) => setSettings({ effortSec: parseInt(e.target.value, 10) })}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm">
                  {EFFORTS.map((e2) => <option key={e2.v} value={e2.v}>{e2.label}</option>)}
                </select>
                <div className="mt-1 text-xs text-slate-500">The optimizer keeps trying arrangements until time runs out. You can stop it early and keep the best result found.</div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:col-span-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-bold uppercase tracking-wider text-slate-700">Part grouping</div>
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" checked={!!s.groupingEnabled}
                      onChange={(e) => setSettings({ groupingEnabled: e.target.checked })} />
                    Group identical parts onto the same blanks
                  </label>
                </div>
                <div className={cls(!s.groupingEnabled && 'pointer-events-none opacity-50')}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <label className="block text-xs font-semibold text-slate-500">
                      Grouping strength — {s.groupingAggression}
                    </label>
                    <div className="text-xs text-slate-500">
                      {s.groupingMaxYieldLossPP != null
                        ? `Manual cap: up to ${Number(s.groupingMaxYieldLossPP).toFixed(2)} pp gross-yield loss (overrides the slider's allowance)`
                        : `Accepts up to ${yieldLossAllowancePP(s.groupingAggression).toFixed(2)} pp of gross-yield loss for tighter grouping`}
                    </div>
                  </div>
                  <input type="range" min={0} max={100} value={s.groupingAggression}
                    onChange={(e) => setSettings({ groupingAggression: parseInt(e.target.value, 10) })} className="w-full" />
                  <div className="mb-3 flex justify-between text-xs text-slate-500">
                    {GROUPING_TUNING.presets.map((p) => (
                      <button key={p.aggression} onClick={() => setSettings({ groupingAggression: p.aggression })}
                        className={cls('rounded px-1 hover:bg-slate-100',
                          s.groupingAggression === p.aggression && 'font-bold text-blue-700')}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-500">Max gross-yield loss (pp)</label>
                      <FloatInput value={s.groupingMaxYieldLossPP} placeholder="auto"
                        onCommit={(v) => setSettings({ groupingMaxYieldLossPP: v })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-slate-500">Max additional blanks</label>
                      <IntInput value={s.groupingMaxExtraSheets} min={0}
                        onCommit={(v) => setSettings({ groupingMaxExtraSheets: v })} />
                    </div>
                    <label className="flex items-end gap-2 pb-1 text-xs">
                      <input type="checkbox" checked={s.groupSingletonsLast !== false}
                        onChange={(e) => setSettings({ groupSingletonsLast: e.target.checked })} />
                      Hold single-quantity parts for cleanup at the end
                    </label>
                    <label className="flex items-end gap-2 pb-1 text-xs">
                      <input type="checkbox" checked={s.groupAllowFinalSheetFill !== false}
                        onChange={(e) => setSettings({ groupAllowFinalSheetFill: e.target.checked })} />
                      Let cleanup parts fill a family&#39;s final blank
                    </label>
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={s.groupCompareLevels !== false}
                      onChange={(e) => setSettings({ groupCompareLevels: e.target.checked })} />
                    Show the grouping-level comparison table in results
                  </label>
                  <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">
                    Grouping trades a little material for a lot of handling: fewer setups, cleaner batches, parts that finish together.
                    The comparison uses <span className="font-semibold">gross yield</span> (parts ÷ all blank area consumed) because it can&#39;t be gamed —
                    net yield credits saved remnants, so it can look better even when more material leaves the rack.
                    Keep Together is a hard instruction and is never silently relaxed; you&#39;ll see a warning with the cost instead.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =========================== RESULTS =========================== */}
          {tab === 'results' && (
            <div tabIndex={0} onKeyDown={onResultsKey} className="outline-none">
              {!result ? (
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-12 text-center text-sm text-slate-500 shadow-sm">
                  No results yet. Enter blanks and parts, then press Optimize.
                </div>
              ) : (
                <div className="space-y-3">
                  {stale && (
                    <div className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                      Inputs changed since this result was computed — press Optimize to refresh.
                    </div>
                  )}
                  {result.oversize.length > 0 && (
                    <div className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                      Skipped (too big for every blank): {result.oversize.map((p) => p.label).join(', ')}
                    </div>
                  )}
                  {activeSol.uncutCount > 0 && (
                    <div className="rounded border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-800">
                      {activeSol.uncutCount} part{activeSol.uncutCount === 1 ? '' : 's'} did not fit: {activeSol.uncut.map((u) => {
                        const p = plan.parts.find((x) => x.id === u.pid);
                        return `${p ? p.label : '?'} ×${u.count}`;
                      }).join(', ')} — add blanks or raise quantities.
                    </div>
                  )}

                  {result.grouping && result.benchmark && activeLevel && (
                    <>
                      <GroupingImpactCard result={result} level={activeLevel} />
                      {activeLevel.warnings.length > 0 && (
                        <div className="space-y-1 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                          {activeLevel.warnings.map((w, i) => <div key={i}>{w}</div>)}
                        </div>
                      )}
                      {s.groupCompareLevels && (
                        <LevelCompareTable result={result} activeAggr={activeLevel.aggression} onPick={pickLevel} />
                      )}
                      <PartGroupingTable result={result} level={activeLevel} open={partDetailsOpen} setOpen={setPartDetailsOpen} />
                    </>
                  )}

                  <div className="grid gap-3 lg:grid-cols-3">
                    {/* left: production runs + summary */}
                    <div className="space-y-3">
                      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                        <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-600">Production runs — cutting order</div>
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="border-b border-slate-200">
                              <Th className="w-7">#</Th><Th>Sheets</Th><Th>Blank</Th>
                              <Th className="w-10 text-right">Rep</Th><Th className="w-14 text-right">Net</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {runsList.map((r, i) => (
                              <tr key={i} onClick={() => { setSelRun(i); setSelCut(-1); setPickedPart(null); }}
                                className={cls('cursor-pointer border-b border-slate-100', i === selRun ? 'bg-blue-50' : 'hover:bg-slate-50')}>
                                <td className="px-2 py-1.5 font-mono text-slate-500">{i + 1}</td>
                                <td className="px-2 py-1.5 font-mono text-xs">
                                  {r.startSheet === r.endSheet ? r.startSheet : `${r.startSheet}–${r.endSheet}`}
                                  {r.cleanup && <span className="ml-1 rounded bg-amber-100 px-1 text-xs font-semibold text-amber-700">cleanup</span>}
                                </td>
                                <td className="px-2 py-1.5 font-mono text-xs">{r.layout.stock.label || `${fmtDim(r.layout.stock.len, fmt)} × ${fmtDim(r.layout.stock.wid, fmt)}`}</td>
                                <td className="px-2 py-1.5 text-right font-mono">×{r.repeat}</td>
                                <td className="px-2 py-1.5 text-right font-mono font-semibold">{(r.layout.netYield * 100).toFixed(1)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="border-t border-slate-100 px-3 py-1 text-xs text-slate-400">
                          Listed in the order the shop cuts them — identical consecutive sheets are batched.
                        </div>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                        <div className="mb-2 flex items-baseline justify-between">
                          <div className="text-xs font-bold uppercase tracking-wider text-slate-600">Summary</div>
                          {result.grouping && activeLevel && (
                            <div className="text-xs text-slate-400">Showing: {activeLevel.label}</div>
                          )}
                        </div>
                        <table className="w-full text-sm">
                          <tbody>
                            <tr><td className="py-0.5 text-slate-500">Net yield</td><td className="py-0.5 text-right font-mono text-lg font-bold text-emerald-700">{(activeSol.stats.netYield * 100).toFixed(1)}%</td></tr>
                            <tr><td className="py-0.5 text-slate-500">Gross yield</td><td className="py-0.5 text-right font-mono">{(activeSol.stats.grossYield * 100).toFixed(1)}%</td></tr>
                            <tr><td className="py-0.5 text-slate-500">Blanks used</td><td className="py-0.5 text-right font-mono">{activeSol.stats.sheetsUsed}</td></tr>
                            <tr><td className="py-0.5 text-slate-500">Parts placed</td><td className="py-0.5 text-right font-mono">{(() => { const pl = activeSol.sheets.reduce((a, sh) => a + sh.placements.length, 0); return `${pl}/${pl + activeSol.uncutCount}`; })()}</td></tr>
                            <tr><td className="py-0.5 text-slate-500">Remnants kept</td><td className="py-0.5 text-right font-mono">{fmtArea(activeSol.stats.remnantArea)}</td></tr>
                            <tr><td className="py-0.5 text-slate-500">Total cuts</td><td className="py-0.5 text-right font-mono">{activeSol.stats.cutCount}</td></tr>
                            <tr><td className="py-0.5 text-slate-500">Gauge settings</td><td className="py-0.5 text-right font-mono">{activeSol.stats.totalGaugeSettings}</td></tr>
                            {activeSol.stats.costMode && (
                              <tr><td className="py-0.5 text-slate-500">Material cost</td><td className="py-0.5 text-right font-mono font-bold">{activeSol.stats.totalCost.toFixed(2)}</td></tr>
                            )}
                          </tbody>
                        </table>
                        <div className="mt-1 border-t border-slate-100 pt-1 text-xs text-slate-400">
                          {result.grouping
                            ? `${(result.baselineIters || 0).toLocaleString()} baseline + ${(result.groupedIters || 0).toLocaleString()} grouped arrangements in ${(result.ms / 1000).toFixed(1)} s`
                            : `${result.iters.toLocaleString()} arrangements tried in ${(result.ms / 1000).toFixed(1)} s`}
                        </div>
                      </div>
                      <button onClick={printReport}
                        className="inline-flex w-full items-center justify-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">
                        <Printer size={15} /> Print shop report
                      </button>
                    </div>

                    {/* right: viewer */}
                    <div className="space-y-3 lg:col-span-2">
                      {run && (
                        <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                            <div className="text-sm font-bold">
                              Run {selRun + 1} of {runsList.length} <span className="font-mono text-xs font-normal text-slate-500">
                                — Sheet{run.startSheet === run.endSheet ? ` ${run.startSheet}` : `s ${run.startSheet}–${run.endSheet}`}
                                {' — '}{run.layout.stock.label || ''} {fmtDim(run.layout.stock.len, fmt)} × {fmtDim(run.layout.stock.wid, fmt)}
                                {' — cut '}{run.repeat === 1 ? '1 sheet' : `${run.repeat} identical`}
                              </span>
                              {run.cleanup && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs font-semibold text-amber-700">cleanup</span>}
                            </div>
                            <div className="font-mono text-xs text-slate-500">* = part rotated · green dash = remnant</div>
                          </div>
                          <LayoutSVG layout={run.layout} fmt={fmt} colorOf={colorOf}
                            selCut={selCut} interactive onPickPart={(i) => setPickedPart(i)} pickedKey={pickedPart} />
                          {pickedPart != null && run.layout.placements[pickedPart] && (() => {
                            const p = run.layout.placements[pickedPart];
                            return (
                              <div className="mt-1 rounded bg-blue-50 px-3 py-1.5 font-mono text-xs text-blue-900">
                                {p.label}{p.rot ? ' (rotated)' : ''} — {fmtDim(p.l, fmt)} × {fmtDim(p.w, fmt)} — at {fmtDim(p.x, fmt)} from left, {fmtDim(p.y, fmt)} from top
                              </div>
                            );
                          })()}
                          <div className="mt-3 space-y-2">
                            <CutDRO layout={run.layout} selCut={selCut} setSelCut={setSelCut} fmt={fmt} />
                            <CutTable layout={run.layout} fmt={fmt} selCut={selCut} setSelCut={setSelCut} />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================ REPORT ============================ */}
          {tab === 'report' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-sm font-bold uppercase tracking-wider text-slate-700">Shop report</div>
                {[['summary', 'Job summary'], ['layouts', 'Layout drawings'], ['cuts', 'Cut sequences'], ['labels', 'Part labels']].map(([k, lbl]) => (
                  <label key={k} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={reportOpts[k]}
                      onChange={(e) => setReportOpts((o) => ({ ...o, [k]: e.target.checked }))} />
                    {lbl}
                  </label>
                ))}
                <button onClick={() => window.print()} disabled={!result}
                  className={cls('ml-auto inline-flex items-center gap-2 rounded px-4 py-2 text-sm font-bold text-white',
                    result ? 'bg-blue-700 hover:bg-blue-800' : 'cursor-not-allowed bg-slate-300')}>
                  <Printer size={15} /> Print
                </button>
              </div>
              {!result ? (
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-12 text-center text-sm text-slate-500 shadow-sm">
                  Optimize a job first — the report is generated from the results.
                </div>
              ) : (
                <div className="mx-auto rounded border border-slate-300 bg-white p-6 shadow" style={{ maxWidth: 820 }}>
                  <PrintDoc plan={plan} sol={activeSol} fmt={fmt} opts={reportOpts} colorOf={colorOf}
            groupingInfo={result.grouping && result.benchmark && activeLevel ? { level: activeLevel, benchmark: result.benchmark } : null} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* hidden print copy when not on report tab */}
      {tab !== 'report' && result && (
        <div className="printdoc hidden print:block">
          <PrintDoc plan={plan} sol={activeSol} fmt={fmt} opts={reportOpts} colorOf={colorOf}
            groupingInfo={result.grouping && result.benchmark && activeLevel ? { level: activeLevel, benchmark: result.benchmark } : null} />
        </div>
      )}

      {/* modals */}
      {importKind && (
        <ImportModal kind={importKind} fmt={fmt} startIdx={importKind === 'parts' ? plan.parts.length : plan.stocks.length}
          onClose={() => setImportKind(null)}
          onImport={(recs) => {
            if (importKind === 'parts') setParts((a) => [...a, ...recs]);
            else setStocks((a) => [...a, ...recs]);
            say(`Added ${recs.length} ${importKind === 'parts' ? 'parts' : 'blanks'}.`);
          }} />
      )}
      {openModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(15,23,42,0.55)' }}>
          <div className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="text-sm font-bold uppercase tracking-wider text-slate-700">Saved plans</div>
              <button onClick={() => setOpenModal(false)} className="rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
            </div>
            <div className="max-h-80 overflow-auto">
              {!storageOK() ? (
                <div className="px-4 py-8 text-center text-sm text-slate-500">Saved plans are not available in this environment. Use Export / Open plan file instead.</div>
              ) : !savedList || savedList.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-slate-500">Nothing saved yet. Use the Save button to keep the current job.</div>
              ) : savedList.map((e) => (
                <div key={e.name} className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
                  <div>
                    <div className="text-sm font-semibold">{e.name}</div>
                    <div className="text-xs text-slate-500">
                      {new Date(e.savedAt).toLocaleString()} · {e.plan.stocks.length} blanks · {e.plan.parts.length} parts
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => { setPlan({ ...e.plan, parts: normalizeParts(e.plan.parts), settings: { ...DEFAULT_SETTINGS, ...e.plan.settings } }); setResult(null); setOpenModal(false); say(`Loaded "${e.name}".`); }}
                      className="rounded bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-800">Load</button>
                    <button onClick={() => deleteSaved(e.name)}
                      className="rounded border border-slate-300 p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
