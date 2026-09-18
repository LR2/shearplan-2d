import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Scissors, Play, Square, Printer, Upload, Download, Save, FolderOpen,
  Plus, Trash2, ChevronLeft, ChevronRight, X, FileText, ClipboardPaste,
  Zap, Gauge, Search, Timer, Check,
} from 'lucide-react';
import {
  refineResultCuts,
} from './engine.js';

import {
  parseDim, fmtDim, fmtArea, CUT_TYPES,
  findOversize, GROUPING_TUNING, deriveSeeds, baselineOptHashOf,
  fullResultHashOf, yieldLossAllowancePP, normalizeGroupPolicy, buildFamilies,
  estimateAllFamilies, tagRunsCleanup, buildLevelResults, runSearch,
} from './engine.js';
import { DEFAULT_SETTINGS, BLADE_PRESETS, presetSettings, matchingPreset } from './settings.js';
export * from './engine.js';

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
  { v: 3, label: 'Quick', time: '3 seconds', icon: Zap },
  { v: 10, label: 'Standard', time: '10 seconds', icon: Gauge },
  { v: 30, label: 'Thorough', time: '30 seconds', icon: Search },
  { v: 120, label: 'Extended', time: '2 minutes', icon: Timer },
];


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

function DimInput({ value, onCommit, fmt, className, placeholder, allowEmpty, ariaLabel }) {
  const [draft, setDraft] = useState(null);
  const shown = draft != null ? draft : (value == null || Number.isNaN(value) ? '' : fmtDim(value, fmt));
  const bad = draft != null && draft.trim() !== '' && Number.isNaN(parseDim(draft));
  return (
    <input
      type="text"
      inputMode="text"
      aria-label={ariaLabel}
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

      {(opts.layouts || opts.cuts) && runsArr.map((g, gi) => (
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
          {opts.layouts && <LayoutSVG layout={g.layout} fmt={fmt} colorOf={colorOf} selCut={-1}
            showCutNumbers={opts.cuts} interactive={false} maxH={430} />}
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
        <div className={cls((opts.summary || opts.layouts || opts.cuts) && 'pbreak', 'pt-2')}>
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
  .app-shell { min-height: 0 !important; background: #fff !important; }
  .printdoc table { break-inside: auto; }
  .printdoc tr { break-inside: avoid; }
  .printdoc thead { display: table-header-group; position: static; }
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
    const finish = async (pending) => {
      setProgress({ phase: 'Refining cut sequences', iters: 0, elapsed: 0, denomMs: null, best: null });
      const res = await refineResultCuts(pending, s);
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
      await finish({ sol: r.sol, hash: runHashes.full, baselineHash: runHashes.baseline, oversize, iters: r.iters, ms: performance.now() - t0, grouping: null });
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
      await finish({ sol: base.baselineSol, hash: runHashes.full, baselineHash: runHashes.baseline, oversize, iters: base.iters, ms: performance.now() - t0, grouping: null });
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
      await finish({ sol: base.baselineSol, hash: runHashes.full, baselineHash: runHashes.baseline, oversize, iters: base.iters + (gr ? gr.iters : 0), ms: performance.now() - t0, grouping: null });
      say('The grouping search stopped before any grouped plan was found — showing the ungrouped result.', 'warn');
      return;
    }
    const levelResults = buildLevelResults({
      archive: gr.archive, benchmark: gr.benchmark, settings: s,
      sliderAggression: selectedAggression, ktRequired: gr.families.ktPids.size > 0,
    });
    const active = levelResults.find((l) => l.aggression === selectedAggression) || levelResults[0];
    tagRunsCleanup(base.baselineSol, gctx.cleanupPids);
    await finish({
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
    if (activeSol) window.print();
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
    <div className="app-shell min-h-screen bg-slate-100 text-slate-900">
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
                <label htmlFor="blade-preset" className="mb-1 block text-xs font-semibold text-slate-500">Plate thickness preset</label>
                <select id="blade-preset" value={matchingPreset(s)}
                  onChange={(e) => setSettings(presetSettings(e.target.value))}
                  className="mb-3 w-full rounded border border-slate-300 bg-white px-2 py-2 text-sm">
                  <option value="">Custom settings</option>
                  {BLADE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Kerf — horizontal cuts</label>
                    <DimInput ariaLabel="Kerf — horizontal cuts" value={s.kerfH} fmt={fmt} onCommit={(v) => setSettings({ kerfH: v, bladePresetId: v === s.kerfH ? s.bladePresetId : '' })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Kerf — vertical cuts</label>
                    <DimInput ariaLabel="Kerf — vertical cuts" value={s.kerfV} fmt={fmt} onCommit={(v) => setSettings({ kerfV: v, bladePresetId: v === s.kerfV ? s.bladePresetId : '' })} />
                  </div>
                </div>
                <div className="mb-3 mt-1 text-xs text-slate-500">Presets apply your shop allowances to both cut directions and all four edges. You can adjust any value for this job.</div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">Edge trims (unusable margin)</label>
                <div className="grid grid-cols-4 gap-2">
                  {[['trimL', 'Left'], ['trimR', 'Right'], ['trimT', 'Top'], ['trimB', 'Bottom']].map(([k, lbl]) => (
                    <div key={k}>
                      <div className="mb-0.5 text-center text-xs text-slate-400">{lbl}</div>
                      <DimInput ariaLabel={`${lbl} edge trim`} value={s[k]} fmt={fmt} onCommit={(v) => setSettings({ [k]: v, bladePresetId: v === s[k] ? s.bladePresetId : '' })} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-bold uppercase tracking-wider text-slate-700">Remnants</div>
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" checked={!!s.remnantsEnabled}
                      onChange={(e) => setSettings({ remnantsEnabled: e.target.checked })} />
                    Allow remnants
                  </label>
                </div>
                {!s.remnantsEnabled && <p className="mb-3 text-xs text-slate-500">Offcuts count as waste. No remnants are saved or credited toward yield.</p>}
                <fieldset disabled={!s.remnantsEnabled} className={cls(!s.remnantsEnabled && 'opacity-40')}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Min remnant length</label>
                    <DimInput ariaLabel="Min remnant length" value={s.minRemL} fmt={fmt} onCommit={(v) => setSettings({ minRemL: v })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-500">Min remnant width</label>
                    <DimInput ariaLabel="Min remnant width" value={s.minRemW} fmt={fmt} onCommit={(v) => setSettings({ minRemW: v })} />
                  </div>
                </div>
                <div className="mt-1 text-xs text-slate-500">Offcuts at least this size count as reusable drops — they&#39;re listed on the report and excluded from waste in net yield.</div>
                <label className="mb-1 mt-3 block text-xs font-semibold text-slate-500">Remnant preference — {s.remRate}</label>
                <input aria-label="Remnant preference" type="range" min={0} max={99} value={s.remRate}
                  onChange={(e) => setSettings({ remRate: parseInt(e.target.value, 10) })} className="w-full" />
                <div className="text-xs text-slate-500">Higher favors layouts that consolidate scrap into keepable drops.</div>
                </fieldset>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Optimization</div>
                <div className="mb-2 text-xs font-semibold text-slate-500">Search effort</div>
                <div role="group" aria-label="Search effort" className="grid grid-cols-2 gap-2">
                  {EFFORTS.map(({ v, label, time, icon: Icon }) => (
                    <button key={v} type="button" aria-pressed={s.effortSec === v}
                      onClick={() => setSettings({ effortSec: v })}
                      className={cls('flex items-center gap-3 rounded-lg border-2 px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700',
                        s.effortSec === v ? 'border-blue-600 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-slate-50')}>
                      <Icon size={23} aria-hidden="true" className="shrink-0" />
                      <span className="min-w-0 flex-1"><span className="block text-sm font-bold">{label}</span><span className="block text-xs">{time}</span></span>
                      {s.effortSec === v && <Check size={16} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-xs text-slate-500">Time per search phase. Part grouping runs a baseline and a grouped search. You can stop early and keep the best result found.</div>
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
                <button onClick={printReport} disabled={!result}
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

      {/* Always outside the hidden application chrome, including on Report. */}
      {result && (
        <div data-testid="print-report" className="printdoc hidden print:block">
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
