import { optimizeCutTree, rebuildCutTree, betterCutTree, cutTreeScore } from './cut-optimizer.js';

const EPS = 1e-6;
const rounded = (n) => Math.round(n * 1e6);
const area = (p) => p.l * p.w;
const travel = (tree) => tree.cutsRaw.reduce((sum, n) => sum + (n.cut.dir === 'h' ? n.l : n.w), 0);

// Pack a family as a row, column or grid before cutting out its individual
// parts. This exposes common edges that an item-at-a-time decoder cannot see.
function familyPatterns(parts, dims, opt) {
  const first = parts[0];
  const l = first.rot ? first.w : first.l, w = first.rot ? first.l : first.w;
  const orientations = [[l, w, false]];
  if (first.canTurn && Math.abs(l - w) > EPS) orientations.push([w, l, true]);
  const patterns = [];
  const grid = (members, cols, pl, pw, rot) => {
    const rows = Math.ceil(members.length / cols);
    const width = cols * pl + (cols - 1) * opt.kerfV;
    const height = rows * pw + (rows - 1) * opt.kerfH;
    const partial = members.length % cols !== 0;
    return { l: width, w: height,
      placements: members.map((p, i) => ({ ...p, node: undefined,
        x: (i % cols) * (pl + opt.kerfV), y: Math.floor(i / cols) * (pw + opt.kerfH),
        l: pl, w: pw, rot })),
      internalCuts: members.length - 1 + Number(partial),
      internalTravel: (rows - 1) * width + (members.length - rows + Number(partial)) * pw,
    };
  };
  for (const [pl, pw, rot] of orientations) {
    const maxCols = Math.min(parts.length, Math.floor((dims.uL + opt.kerfV + EPS) / (pl + opt.kerfV)));
    const maxRows = Math.floor((dims.uW + opt.kerfH + EPS) / (pw + opt.kerfH));
    if (!maxRows) continue;
    for (let cols = 1; cols <= maxCols; cols++) {
      const rows = Math.ceil(parts.length / cols);
      if (rows <= maxRows) {
        patterns.push([grid(parts, cols, pl, pw, rot)]);
        // A partial final row can be a separate block, leaving its spare area
        // available to another family instead of reserving an empty grid cell.
        const full = Math.floor(parts.length / cols) * cols;
        if (full && full < parts.length) patterns.push([
          grid(parts.slice(0, full), cols, pl, pw, rot),
          grid(parts.slice(full), parts.length - full, pl, pw, rot),
        ]);
      }
    }
  }
  // Some mixed-orientation families cannot form one grid. Also try splitting
  // their existing orientations into separate rectangular blocks.
  const byRotation = [parts.filter((p) => !p.rot), parts.filter((p) => p.rot)].filter((a) => a.length);
  if (byRotation.length > 1) {
    const blocks = byRotation.flatMap((members) => {
      const p = members[0];
      const cols = Math.min(members.length, Math.floor((dims.uL + opt.kerfV + EPS) / (p.l + opt.kerfV)));
      const rows = Math.floor((dims.uW + opt.kerfH + EPS) / (p.w + opt.kerfH));
      if (!cols || !rows) return [];
      const out = [];
      for (let i = 0; i < members.length; i += cols * rows) {
        const chunk = members.slice(i, i + cols * rows);
        out.push(grid(chunk, Math.min(cols, chunk.length), p.l, p.w, p.rot));
      }
      return out;
    });
    if (blocks.length) patterns.push(blocks);
  }
  const seen = new Set();
  const unique = patterns.filter((blocks) => {
    const sig = blocks.map((b) => [rounded(b.l), rounded(b.w), b.placements.length, b.placements[0].rot].join(',')).join(';');
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  unique.sort((a, b) => a.length - b.length ||
    a.reduce((s, p) => s + area(p), 0) - b.reduce((s, p) => s + area(p), 0));
  // Retain both compact grids and elongated strips when a large family has
  // many possibilities. The original valid layout is always a fallback.
  if (unique.length <= 12) return unique;
  return Array.from({ length: 12 }, (_, i) => unique[Math.round(i * (unique.length - 1) / 11)]);
}

function combinations(options, limit) {
  const total = options.reduce((n, a) => n * a.length, 1);
  if (!total) return [];
  const result = [];
  const seen = new Set();
  const add = (indexes) => {
    const key = indexes.join(',');
    if (!seen.has(key)) { seen.add(key); result.push(indexes.map((index, i) => options[i][index]).flat()); }
  };
  if (total <= limit) {
    for (let n = 0; n < total; n++) {
      let value = n;
      add(options.map((a) => { const index = value % a.length; value = Math.floor(value / a.length); return index; }));
    }
  } else {
    // Deterministic coverage of each family's shapes, then mixed combinations.
    add(options.map(() => 0));
    for (let i = 0; i < options.length; i++) {
      for (let j = 1; j < options[i].length && result.length < limit; j++) {
        add(options.map((_, k) => k === i ? j : 0));
      }
    }
    let seed = 8675309;
    for (let n = 0; n < limit * 4 && result.length < limit; n++) {
      add(options.map((a) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * a.length); }));
    }
  }
  return result;
}

// Keep each strip's internal layout intact, but place equal-width rips (or
// equal-height cross-cuts) together. Item-at-a-time packing often interleaves
// widths even when two simple strip orders would avoid resetting the gauge.
function batchedStripLayouts(tree, opt) {
  if (tree.root.kind !== 'int') return [];
  const dir = tree.root.cut.dir, axis = dir === 'v' ? 'x' : 'y', size = dir === 'v' ? 'l' : 'w';
  const kerf = dir === 'v' ? opt.kerfV : opt.kerfH;
  const strips = [];
  const collect = (node) => {
    if (!node) return;
    if (node.kind === 'int' && node.cut.dir === dir) node.kids.forEach(collect);
    else strips.push({ node, parts: tree.placements.filter((p) =>
      p[axis] >= node[axis] - EPS && p[axis] + p[size] <= node[axis] + node[size] + EPS) });
  };
  collect(tree.root);
  const occupied = strips.filter((s) => s.parts.length);
  const empty = strips.filter((s) => !s.parts.length);
  if (occupied.length < 2) return [];
  return [1, -1].map((direction) => {
    const ordered = occupied.slice().sort((a, b) => direction * (a.node[size] - b.node[size]) || a.node[axis] - b.node[axis]);
    let position = tree.root[axis];
    return ordered.concat(empty).flatMap(({ node, parts }) => {
      const offset = position - node[axis];
      position += node[size] + kerf;
      return parts.map((p) => ({ ...p, node: undefined, [axis]: p[axis] + offset }));
    });
  });
}

// Re-nest EXACTLY the parts already assigned to one blank. Candidate generation
// uses family blocks; each proposal is then rebuilt as a real guillotine tree
// under the user's stage, first-cut, kerf and remnant constraints. No packing
// estimate is ever returned as an executable sequence.
export function optimizeSheetLayout(original, options, decode) {
  const { maxPackingTrials = Math.min(6000, Math.floor(60000 / Math.max(1, original.placements.length))),
    maxLayoutCandidates = 24, maxConfigurations = 128 } = options;
  let best = optimizeCutTree(original, options);
  if (!maxPackingTrials || !maxLayoutCandidates || original.placements.length > 256 ||
      original.placements.some((p) => p.canTurn == null)) return best;
  const dims = { uL: original.root.l, uW: original.root.w };
  const families = new Map();
  for (const p of original.placements) {
    const key = JSON.stringify([p.pid, p.rot ? p.w : p.l, p.rot ? p.l : p.w, p.canTurn]);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(p);
  }
  const patterns = [...families.values()].map((parts) =>
    familyPatterns(parts.slice().sort((a, b) => a.key.localeCompare(b.key)), dims, options));
  const configs = combinations(patterns, maxConfigurations);
  const candidates = new Map();
  const protectedDrops = options.remnantsEnabled ? original.frees.filter((p) => !p.dead &&
    Math.max(p.l, p.w) >= Math.max(options.minRemL, options.minRemW) - EPS &&
    Math.min(p.l, p.w) >= Math.min(options.minRemL, options.minRemW) - EPS) : [];
  const intersects = (a, b) => a.x < b.x + b.l - EPS && b.x < a.x + a.l - EPS &&
    a.y < b.y + b.w - EPS && b.y < a.y + a.w - EPS;
  let trials = 0;
  outer: for (const blocks of configs) {
    const instances = blocks.map((b, i) => ({ key: String(i), pid: String(i), label: '', l: b.l, w: b.w, canTurn: false }));
    const orders = [instances, instances.slice().reverse(),
      instances.slice().sort((a, b) => area(b) - area(a)),
      instances.slice().sort((a, b) => b.l - a.l || b.w - a.w),
      instances.slice().sort((a, b) => b.w - a.w || b.l - a.l)];
    const orderKeys = new Set();
    for (const order of orders) {
      const orderKey = order.map((p) => p.key).join(',');
      if (orderKeys.has(orderKey)) continue;
      orderKeys.add(orderKey);
      for (const firstCut of ['h', 'v']) for (const splitPref of ['h', 'v', 'best']) for (const choice of ['BSSF', 'BAF']) {
        if (++trials > maxPackingTrials) break outer;
        const packed = decode(dims, order, { ...options, maxStage: 99, half: false, firstCut, splitPref, choice });
        if (!packed || packed.placements.length !== blocks.length) continue;
        const placements = packed.placements.flatMap((p) => blocks[Number(p.key)].placements
          .map((member) => ({ ...member, x: member.x + p.x, y: member.y + p.y })));
        if (placements.length !== original.placements.length || new Set(placements.map((p) => p.key)).size !== original.placedKeys.size) continue;
        if (protectedDrops.some((drop) => placements.some((p) => intersects(p, drop)))) continue;
        const signature = placements.map((p) => [p.pid, rounded(p.x), rounded(p.y), rounded(p.l), rounded(p.w)].join(',')).sort().join(';');
        if (candidates.has(signature)) continue;
        candidates.set(signature, { placements,
          estimate: packed.cutsRaw.length + blocks.reduce((s, b) => s + b.internalCuts, 0),
          travel: travel(packed) + blocks.reduce((s, b) => s + b.internalTravel, 0),
        });
      }
    }
  }
  const shortlist = [...candidates.values()].sort((a, b) => a.estimate - b.estimate || a.travel - b.travel)
    .slice(0, maxLayoutCandidates);
  for (const candidate of shortlist) {
    const tree = rebuildCutTree({ ...original, placements: candidate.placements }, {
      ...options, maxStates: 2500, maxChecks: 150000,
    });
    if (tree && betterCutTree(tree, best)) best = tree;
  }
  // At most six extra bounded tree searches. Preserve material use, cut count
  // and cut length while improving gauge batching on the final arrangement.
  for (const placements of [best.placements, ...batchedStripLayouts(best, options)]) {
    if (protectedDrops.some((drop) => placements.some((p) => intersects(p, drop)))) continue;
    for (const trimFirst of [true, false]) {
      const tree = rebuildCutTree({ ...original, placements }, {
        ...options, trimFirst, maxStates: 2500, maxChecks: 150000,
      });
      if (!tree || !betterCutTree(tree, best)) continue;
      const score = cutTreeScore(tree), previous = cutTreeScore(best);
      if (score[1] <= previous[1] + EPS && score[2] <= previous[2]) best = tree;
    }
  }
  return best;
}
