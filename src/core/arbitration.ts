import { dot, evaluateSurface, norm, normalize, subtract } from './surface.js';
import { applyCrease, defaultGeometry, fitSurface } from './fit.js';
import { uniformInterior } from './bspline.js';
import type {
  ControlLattice,
  FitRequest,
  FitResult,
  HypothesisKind,
  HypothesisScore,
  Observation,
  SurfaceGeometryConfig,
  TemplateCheck,
  TemplatePoint,
  Vec3,
} from './types.js';

// ---------------------------------------------------------------------------
// Evidence extraction
//
// The virtual template (虚拟样板) is an independent reference: it encodes the
// design intent, so a *trial fit of the template itself* answers "does the
// design contain a fold?" before any measurement is fitted. The measurement
// side is then compared against the template, not against a surface the probes
// jointly define — the latter cannot tell symmetric probe disagreement apart
// from a real shape.
//
// Three physically distinct signals are separated:
//
//   (a) a single-row offset along span: one row departs from its neighbours.
//       Its signature is a spike or step in the row-mean residual profile whose
//       BIC beats a constant model decisively.
//   (b) a design fold: the template trial fit is improved by a C0 crease and a
//       repeat scan of the other side reproduces a matching spanwise slope break.
//   (c) a probe-global zero offset: a probe's *median* residual against the
//       template is shifted while its row profile stays flat.
// ---------------------------------------------------------------------------

export interface RowMean {
  v: number;
  mean: number;
  count: number;
}

export type RowModelKind = 'constant' | 'spike' | 'step';

export interface RowModel {
  kind: RowModelKind;
  /** BIC(model) - BIC(constant); negative means the model explains the row profile */
  dbic: number;
  /** best station (row value for a spike, change point for a step) */
  station: number;
  /** signed magnitude in metres: spike displacement or step height */
  magnitude: number;
  rows: RowMean[];
  /** robust noise scale of a row mean, metres */
  sigmaRow: number;
}

export interface ProbeStats {
  probeId: string;
  side: string;
  isRepeat: boolean;
  count: number;
  /** median signed residual against the virtual-template reference surface */
  templateBias: number;
  rms: number;
  rowModel: RowModel;
  /** localised deviation, if any */
  localBand: { signature: 'single-row' | 'fold'; station: number; magnitude: number; dbic: number } | null;
  /** probe-global bias with no localised defect */
  globalOffset: boolean;
}

export interface TemplateFold {
  at: number;
  /** rss(smooth) / rss(crease); >1 means the template prefers a crease */
  improvement: number;
  rssSmooth: number;
  rssCrease: number;
  stations: { at: number; improvement: number }[];
}

export interface DeviationBand {
  vCenter: number;
  vMin: number;
  vMax: number;
  signature: 'single-row' | 'fold';
  probeIds: string[];
  /** peak deviation in metres */
  magnitude: number;
  dbic: number;
  observationIds: string[];
}

export interface Evidence {
  robustScale: number;
  probes: ProbeStats[];
  band: DeviationBand | null;
  templateFold: TemplateFold | null;
  globalOffsetProbes: string[];
  warnings: string[];
}

/** A real localised defect must explain the row profile at this BIC margin. */
const BAND_DBIC_FLOOR = -8;
/** ...carry at least this much displacement (0.25 mm). */
const BAND_MAGNITUDE_FLOOR = 2.5e-4;
/** ...and stand this far above the row-mean noise scale. */
const BAND_SIGMA_RATIO = 3.0;
/** A probe is globally offset when its median template residual exceeds this. */
const TEMPLATE_BIAS_FLOOR = 1.5e-4;
/** A template crease must reduce the template residual SS by this factor. */
const TEMPLATE_FOLD_IMPROVEMENT = 1.08;
/** Repeat-side spanwise slope break (m per unit v) that confirms a fold. */
const REPEAT_SLOPE_FLOOR = 1.5e-2;
/** Repeat-side single-row spike (metres) that confirms a single-row feature. */
const REPEAT_SPIKE_FLOOR = 2.5e-4;

function groupByProbe(observations: Observation[]): Map<string, Observation[]> {
  const map = new Map<string, Observation[]>();
  for (const o of observations) {
    const list = map.get(o.probeId) ?? [];
    list.push(o);
    map.set(o.probeId, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Virtual template trial fit
// ---------------------------------------------------------------------------

/** Fit a low-complexity smooth surface through the template points. This is the
 *  independent reference the measurements are judged against. A 5×5 cubic is the
 *  richest lattice a sparse template supports without the edge blow-up that an
 *  over-determined fit produces; with zero fairing it reproduces the design
 *  intent to a few hundredths of a millimetre. */
export function templateReference(template: TemplatePoint[]): ControlLattice | null {
  if (template.length < 9) return null;
  const geometry = defaultGeometry({
    degreeU: 3,
    degreeV: 3,
    countU: 5,
    countV: 5,
    interiorU: uniformInterior(5, 3),
    interiorV: uniformInterior(5, 3),
    tensionWeightU: 0,
    tensionWeightV: 0,
    blendWeightU: 0,
    blendWeightV: 0,
    priorWeight: 0,
    robustCutoff: 3.5,
    robustIterations: 1,
    dataWeight: 1,
  });
  const obs: Observation[] = template.map((t, i) => ({
    id: `template-${i}`,
    u: t.u,
    v: t.v,
    point: t.point,
    probeId: '_template',
    passId: 'template',
  }));
  try {
    const fit = fitSurface({
      observations: obs,
      settings: {
        geometry,
        minWeight: 1e-9,
        useNormals: false,
        normalWeight: 0,
        crease: null,
        robust: 'none',
        offsetProbeWeight: 1,
        controlPointBoost: { u: 0, v: 0 },
      },
    });
    return fit.lattice;
  } catch {
    return null;
  }
}

function templateBox(template: TemplatePoint[]): { u0: number; u1: number; v0: number; v1: number } {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const t of template) {
    u0 = Math.min(u0, t.u);
    u1 = Math.max(u1, t.u);
    v0 = Math.min(v0, t.v);
    v1 = Math.max(v1, t.v);
  }
  return { u0, u1, v0, v1 };
}

/** Trial-fit the template with a crease at every interior template station. A
 *  real design fold is where the crease model clearly beats the smooth model. */
export function templateFoldTrial(template: TemplatePoint[]): TemplateFold | null {
  if (template.length < 12) return null;
  const stations = [...new Set(template.map((t) => t.v))].sort((a, b) => a - b);
  if (stations.length < 4) return null;
  const baseGeometry = defaultGeometry({
    degreeU: 3,
    degreeV: 3,
    countU: 4,
    countV: 7,
    interiorU: uniformInterior(4, 3),
    interiorV: uniformInterior(7, 3),
    tensionWeightU: 1e-7,
    tensionWeightV: 1e-7,
    blendWeightU: 1e-7,
    blendWeightV: 1e-7,
    priorWeight: 1e-9,
    robustCutoff: 3.5,
    robustIterations: 1,
  });
  const obs: Observation[] = template.map((t, i) => ({
    id: `template-${i}`,
    u: t.u,
    v: t.v,
    point: t.point,
    probeId: '_template',
    passId: 'template',
  }));
  const settings = (geometry: SurfaceGeometryConfig) => ({
    geometry,
    minWeight: 1e-9,
    useNormals: false,
    normalWeight: 0,
    crease: null,
    robust: 'none' as const,
    offsetProbeWeight: 1,
    controlPointBoost: { u: 0, v: 0 },
  });
  const rssOf = (geometry: SurfaceGeometryConfig): number => {
    const fit = fitSurface({ observations: obs, settings: settings(geometry) });
    let rss = 0;
    for (const r of fit.residuals) rss += r.distance * r.distance;
    return rss;
  };
  const rssSmooth = rssOf(baseGeometry);
  if (!(rssSmooth > 0)) return null;
  const trials: { at: number; improvement: number; rss: number }[] = [];
  for (let k = 1; k < stations.length - 1; k++) {
    const at = stations[k];
    try {
      const applied = applyCrease(baseGeometry, { enabled: true, direction: 'v', at, hard: true });
      if (!applied.applied) continue;
      const rss = rssOf(applied.geometry);
      trials.push({ at, improvement: rssSmooth / Math.max(rss, 1e-18), rss });
    } catch {
      // station too close to the boundary to host a crease; skip
    }
  }
  const best = trials.sort((a, b) => b.improvement - a.improvement)[0];
  if (!best || best.improvement < TEMPLATE_FOLD_IMPROVEMENT) {
    return { at: 0, improvement: best?.improvement ?? 1, rssSmooth, rssCrease: best?.rss ?? rssSmooth, stations: trials };
  }
  return { at: best.at, improvement: best.improvement, rssSmooth, rssCrease: best.rss, stations: trials };
}

// ---------------------------------------------------------------------------
// Row models
// ---------------------------------------------------------------------------

/** Group observations into span stations and take the mean of `value`. */
function rowMeans(obs: Observation[], value: (o: Observation) => number): RowMean[] {
  const rows = new Map<string, { v: number; vals: number[] }>();
  for (const o of obs) {
    const key = o.v.toFixed(5);
    const e = rows.get(key) ?? { v: o.v, vals: [] };
    e.vals.push(value(o));
    rows.set(key, e);
  }
  return [...rows.values()]
    .map((e) => ({ v: e.v, mean: mean(e.vals), count: e.vals.length }))
    .sort((a, b) => a.v - b.v);
}

/** BIC compare a constant row profile against a single-row spike and a single
 *  step. The winning model, if any, gives the localised defect signature. */
export function fitRowModel(rows: RowMean[]): RowModel {
  const n = rows.length;
  const y = rows.map((r) => r.mean);
  const v = rows.map((r) => r.v);
  const c0 = mean(y);
  let rss0 = 0;
  for (const yi of y) rss0 += (yi - c0) ** 2;
  const sigmaRow = robustSigmaFromRows(y);

  let spike = { rss: Infinity, k: -1, d: 0 };
  for (let k = 1; k < n - 1; k++) {
    const c = mean(y.filter((_, i) => i !== k));
    let rss = 0;
    for (let i = 0; i < n; i++) rss += (y[i] - (i === k ? y[k] : c)) ** 2;
    if (rss < spike.rss) spike = { rss, k, d: y[k] - c };
  }

  let step = { rss: Infinity, k: -1, d: 0 };
  for (let k = 2; k < n - 1; k++) {
    const lo = mean(y.slice(0, k));
    const hi = mean(y.slice(k));
    let rss = 0;
    for (let i = 0; i < n; i++) rss += (y[i] - (i < k ? lo : hi)) ** 2;
    if (rss < step.rss) step = { rss, k, d: hi - lo };
  }

  const b0 = n * Math.log(Math.max(rss0, 1e-24) / n);
  const dbic = (rss: number) => n * Math.log(Math.max(rss, 1e-24) / n) + Math.log(n) - b0;

  const spikeDbic = dbic(spike.rss);
  const stepDbic = dbic(step.rss);
  const candidates: { kind: RowModelKind; dbic: number; station: number; magnitude: number }[] = [];
  if (spike.k >= 0) candidates.push({ kind: 'spike', dbic: spikeDbic, station: v[spike.k], magnitude: spike.d });
  if (step.k >= 0) candidates.push({ kind: 'step', dbic: stepDbic, station: (v[step.k - 1] + v[step.k]) / 2, magnitude: step.d });
  const best = candidates.sort((a, b) => a.dbic - b.dbic)[0];
  if (!best) return { kind: 'constant', dbic: 0, station: 0, magnitude: 0, rows, sigmaRow };
  const significant =
    best.dbic <= BAND_DBIC_FLOOR &&
    Math.abs(best.magnitude) >= BAND_MAGNITUDE_FLOOR &&
    Math.abs(best.magnitude) >= BAND_SIGMA_RATIO * sigmaRow;
  if (!significant) return { kind: 'constant', dbic: best.dbic, station: best.station, magnitude: best.magnitude, rows, sigmaRow };
  return { kind: best.kind, dbic: best.dbic, station: best.station, magnitude: best.magnitude, rows, sigmaRow };
}

function robustSigmaFromRows(y: number[]): number {
  if (y.length < 3) return 0;
  const d2: number[] = [];
  for (let i = 1; i < y.length - 1; i++) d2.push(y[i] - (y[i - 1] + y[i + 1]) / 2);
  const med = median(d2);
  const mad = median(d2.map((x) => Math.abs(x - med)));
  // a second difference of row means has variance 1.5 * (sigma/sqrt(n))^2; use
  // the MAD as a robust stand-in for the row-mean noise level
  return Math.max(1.4826 * mad / Math.sqrt(1.5), 1e-7);
}

// ---------------------------------------------------------------------------
// Probe evidence
// ---------------------------------------------------------------------------

function collectProbeStats(
  baseline: FitResult,
  reference: ControlLattice | null,
  box: { u0: number; u1: number; v0: number; v1: number } | null,
): ProbeStats[] {
  const byProbe = groupByProbe(baseline.observations);
  const residualById = new Map<string, number>();
  for (const r of baseline.residuals) residualById.set(r.id, r.normalResidual);

  const residualOf = (o: Observation): number => {
    if (!reference) return residualById.get(o.id) ?? 0;
    const e = evaluateSurface(reference, o.u, o.v);
    return dot(subtract(o.point, e.point), e.normal);
  };

  const out: ProbeStats[] = [];
  for (const [probeId, obs] of byProbe) {
    const side = obs[0].side ?? '';
    // every probe reaching gatherEvidence is a fit probe; repeat-evidence probes
    // are never fitted, so none of these is a repeat scan
    const isRepeat = false;
    const inBox = box
      ? obs.filter((o) => o.u >= box.u0 - 1e-9 && o.u <= box.u1 + 1e-9 && o.v >= box.v0 - 1e-9 && o.v <= box.v1 + 1e-9)
      : obs;
    const usable = inBox.length >= 6 ? inBox : obs;

    const signed = usable.map(residualOf);
    const rows = rowMeans(usable, residualOf);
    const rowModel = fitRowModel(rows);
    const bias = median(signed);
    const localBand =
      rowModel.kind === 'constant'
        ? null
        : {
            signature: (rowModel.kind === 'spike' ? 'single-row' : 'fold') as 'single-row' | 'fold',
            station: rowModel.station,
            magnitude: rowModel.magnitude,
            dbic: rowModel.dbic,
          };
    out.push({
      probeId,
      side,
      isRepeat,
      count: usable.length,
      templateBias: bias,
      rms: Math.sqrt(mean(signed.map((s) => s * s))),
      rowModel,
      localBand,
      globalOffset: !localBand && Math.abs(bias) > TEMPLATE_BIAS_FLOOR,
    });
  }
  return out;
}

export function gatherEvidence(baseline: FitResult, template?: TemplatePoint[]): Evidence {
  const reference = template ? templateReference(template) : null;
  const box = template ? templateBox(template) : null;
  const probes = collectProbeStats(baseline, reference, box);
  const warnings: string[] = [];
  const templateFold = template ? templateFoldTrial(template) : null;

  if (reference && template) {
    warnings.push(
      '虚拟样板试配：以样板点拟合独立参考面（4×4 三次），测点残差均相对该参考面统计，' +
        '避免用测点共同定义的曲面互相校准。',
    );
  }

  // strongest localised band across the fit probes
  let band: DeviationBand | null = null;
  const localised = probes.filter((p) => !p.isRepeat && p.localBand);
  if (localised.length > 0) {
    const strongest = [...localised].sort((a, b) => Math.abs(b.localBand!.magnitude) - Math.abs(a.localBand!.magnitude))[0];
    const vCenter = strongest.localBand!.station;
    const spacing = rowSpacing(strongest.rowModel.rows);
    const tolerance = Math.max(spacing * 2, 0.08);
    const sharing = localised.filter((p) => Math.abs(p.localBand!.station - vCenter) <= tolerance);
    const observationIds: string[] = [];
    const rowVs = new Set<string>();
    for (const p of sharing) {
      for (const r of p.rowModel.rows) {
        if (Math.abs(r.v - vCenter) <= tolerance) rowVs.add(r.v.toFixed(5));
      }
    }
    for (const o of baseline.observations) {
      if (rowVs.has(o.v.toFixed(5)) && sharing.some((p) => p.probeId === o.probeId)) observationIds.push(o.id);
    }
    const rows = [...rowVs].map(Number).sort((a, b) => a - b);
    band = {
      vCenter,
      vMin: rows[0] ?? vCenter,
      vMax: rows[rows.length - 1] ?? vCenter,
      signature: strongest.localBand!.signature,
      probeIds: sharing.map((p) => p.probeId),
      magnitude: Math.abs(strongest.localBand!.magnitude),
      dbic: strongest.localBand!.dbic,
      observationIds,
    };
    warnings.push(
      `测点相对虚拟样板在 v≈${vCenter.toFixed(3)} 出现${band.signature === 'single-row' ? '孤立单排' : '单侧折点'}偏离，` +
        `量级 ${(band.magnitude * 1000).toFixed(2)} mm（行剖面 BIC 改善 ${band.dbic.toFixed(1)}）。`,
    );
  }

  if (templateFold && templateFold.improvement >= TEMPLATE_FOLD_IMPROVEMENT) {
    warnings.push(
      `虚拟样板试配：在 v≈${templateFold.at.toFixed(3)} 处加 C0 折线后样板残差平方和降至 ${(100 / templateFold.improvement).toFixed(0)}%，` +
        `说明样板本身含设计折线（${templateFold.improvement.toFixed(2)}× 改善）。`,
    );
  }

  const templateFoldSignificant = !!templateFold && templateFold.improvement >= TEMPLATE_FOLD_IMPROVEMENT;
  // A template fold biases every probe's median residual against the smooth
  // reference, so a probe-global offset is not identifiable while a design fold
  // is present; defer the offset decision to the repeat side.
  const globalOffsetProbes = templateFoldSignificant
    ? []
    : probes.filter((p) => !p.isRepeat && p.globalOffset).map((p) => p.probeId);
  if (templateFoldSignificant) {
    warnings.push('样板含折线时，探头中位残差会被折线整体抬偏，暂不据此判定探头零点漂移。');
  }
  for (const p of probes) {
    if (p.isRepeat || !p.globalOffset || templateFoldSignificant) continue;
    warnings.push(
      `探头 ${p.probeId} 相对虚拟样板整体偏移 ${(p.templateBias * 1000).toFixed(2)} mm 且行剖面平直：` +
        `判为探头零点漂移，降低该组权重。`,
    );
  }

  return {
    robustScale: robustSigma(baseline.residuals.map((r) => r.distance)),
    probes,
    band,
    templateFold,
    globalOffsetProbes,
    warnings,
  };
}

function rowSpacing(rows: RowMean[]): number {
  if (rows.length < 2) return 0.07;
  const diffs: number[] = [];
  for (let i = 1; i < rows.length; i++) diffs.push(rows[i].v - rows[i - 1].v);
  return median(diffs) || 0.07;
}

// ---------------------------------------------------------------------------
// Repeat corroboration
// ---------------------------------------------------------------------------

export type RepeatMode = 'same-side' | 'opposite-side' | 'none';

export interface RepeatProbeInput {
  probeId: string;
  side: string;
  mode: RepeatMode;
  observations: Observation[];
}

export interface RepeatEvidence {
  mode: RepeatMode;
  probeIds: string[];
  /** repeat peak magnitude at the band station, metres */
  reproducedMagnitude: number | null;
  /** spanwise slope break reproduced at the band station, metres per unit v */
  reproducedSlope: number | null;
  /** repeat signature at the band */
  reproducedSignature: 'single-row' | 'fold' | null;
  /** null when no repeat covers the band */
  reproduces: boolean | null;
  covers: boolean;
  detail: string;
  perProbe: Record<string, { magnitude: number; slope: number; covers: boolean }>;
}

/** Compare a repeat scan of the specimen with the deviation band under test.
 *
 *  A design fold is a geometric feature of the specimen: a repeat scan of either
 *  side reproduces a spanwise slope break at the same station. A single-row
 *  instrument artefact does not. The repeat profile is built from the mid-chord
 *  height of each span station, so it is independent of the test-side fit. */
export function assessRepeat(repeat: RepeatProbeInput, band: DeviationBand): RepeatEvidence {
  if (repeat.mode === 'none' || repeat.observations.length === 0) {
    return {
      mode: 'none',
      probeIds: [],
      reproducedMagnitude: null,
      reproducedSlope: null,
      reproducedSignature: null,
      reproduces: null,
      covers: false,
      detail: '没有覆盖该展向站位的复测剖面，无法证认或排除。',
      perProbe: {},
    };
  }

  const perProbe: RepeatEvidence['perProbe'] = {};
  const details: string[] = [];
  let anyCovers = false;
  let reproduced = false;
  let bestMagnitude = 0;
  let bestSlope = 0;
  let bestSignature: 'single-row' | 'fold' | null = null;
  let anything = false;

  for (const [probeId, obs] of groupByProbe(repeat.observations)) {
    const vLo = Math.min(...obs.map((o) => o.v));
    const vHi = Math.max(...obs.map((o) => o.v));
    const covers = band.vCenter >= vLo - 1e-6 && band.vCenter <= vHi + 1e-6;
    const profile = midChordProfile(obs);
    const slopeAt = slopeBreakAt(profile, band.vCenter);
    const spike = rowSpike(profile, band.vCenter);
    const magnitude = spike !== null ? Math.abs(spike) : 0;
    perProbe[probeId] = { magnitude, slope: slopeAt, covers };
    if (!covers) {
      details.push(`复测 ${probeId} 的展向范围 [${vLo.toFixed(2)},${vHi.toFixed(2)}] 未覆盖 v≈${band.vCenter.toFixed(3)}`);
      continue;
    }
    anyCovers = true;
    // A design fold shows up as a strong slope break in the repeat profile. A
    // single-row artefact shows up as a repeat row spike, but that is weaker
    // evidence, so it only corroborates when the test band is itself a spike.
    const foldCorroborates = Math.abs(slopeAt) >= REPEAT_SLOPE_FLOOR;
    const spikeCorroborates = band.signature === 'single-row' && magnitude >= REPEAT_SPIKE_FLOOR && Math.abs(slopeAt) < REPEAT_SLOPE_FLOOR;
    details.push(
      `复测 ${probeId} 在 v≈${band.vCenter.toFixed(3)} 的展向斜率突变 ${(slopeAt * 1000).toFixed(1)} mm/单位，` +
        `单排行偏移 ${(magnitude * 1000).toFixed(2)} mm`,
    );
    if (foldCorroborates || spikeCorroborates) {
      reproduced = true;
      anything = true;
      if (Math.abs(slopeAt) > Math.abs(bestSlope)) {
        bestSlope = slopeAt;
        bestMagnitude = Math.max(bestMagnitude, magnitude);
        bestSignature = foldCorroborates ? 'fold' : 'single-row';
      }
    } else if (!reproduced) {
      if (Math.abs(slopeAt) > Math.abs(bestSlope)) bestSlope = slopeAt;
      bestMagnitude = Math.max(bestMagnitude, magnitude);
      anything = true;
      if (!bestSignature) bestSignature = 'single-row';
    }
  }

  if (!anyCovers) {
    return {
      mode: repeat.mode,
      probeIds: [...groupByProbe(repeat.observations).keys()],
      reproducedMagnitude: null,
      reproducedSlope: null,
      reproducedSignature: null,
      reproduces: null,
      covers: false,
      detail: details.join('；') + '。复测存在但未覆盖偏离带。',
      perProbe,
    };
  }

  return {
    mode: repeat.mode,
    probeIds: [...groupByProbe(repeat.observations).keys()],
    reproducedMagnitude: anything ? bestMagnitude : 0,
    reproducedSlope: anything ? bestSlope : 0,
    reproducedSignature: bestSignature,
    reproduces: reproduced,
    covers: true,
    detail:
      details.join('；') +
      '。' +
      (reproduced
        ? '复测在同一站位复现了同向展向斜率突变，判为贯穿蒙皮的真实设计折线。'
        : '复测在同一站位未见相当的展向斜率突变，倾向测试侧探头的局部偏差或漂移。'),
    perProbe,
  };
}

/** Mid-chord height per span station: fit z(u) quadratically in each row and
 *  evaluate at u = 0.5, removing the chordwise camber so only spanwise shape remains. */
function midChordProfile(obs: Observation[]): { v: number; z: number }[] {
  const rows = new Map<string, { v: number; pts: { u: number; z: number }[] }>();
  for (const o of obs) {
    const key = o.v.toFixed(5);
    const e = rows.get(key) ?? { v: o.v, pts: [] };
    e.pts.push({ u: o.u, z: o.point[2] });
    rows.set(key, e);
  }
  const out: { v: number; z: number }[] = [];
  for (const { v, pts } of rows.values()) {
    const co = polyfit2(pts.map((p) => p.u), pts.map((p) => p.z));
    out.push({ v, z: co[0] + co[1] * 0.5 + co[2] * 0.25 });
  }
  return out.sort((a, b) => a.v - b.v);
}

/** Spanwise slope on each side of a station, returned as (after - before). */
function slopeBreakAt(profile: { v: number; z: number }[], station: number): number {
  let k = 0;
  while (k < profile.length && profile[k].v <= station) k++;
  if (k < 2 || k > profile.length - 2) return 0;
  const before = linSlope(profile.slice(0, k).map((p) => p.v), profile.slice(0, k).map((p) => p.z));
  const after = linSlope(profile.slice(k).map((p) => p.v), profile.slice(k).map((p) => p.z));
  return after - before;
}

/** Single-row dip/spike of the repeat profile nearest a station, relative to its
 *  neighbours; null when no repeat row is close enough to the station. */
function rowSpike(profile: { v: number; z: number }[], station: number): number | null {
  let idx = -1;
  let best = Infinity;
  for (let i = 1; i < profile.length - 1; i++) {
    const d = Math.abs(profile[i].v - station);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  if (idx < 1 || best > 0.05) return null;
  return profile[idx].z - (profile[idx - 1].z + profile[idx + 1].z) / 2;
}

function polyfit2(x: number[], y: number[]): [number, number, number] {
  let S0 = x.length, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let i = 0; i < x.length; i++) {
    S1 += x[i];
    S2 += x[i] ** 2;
    S3 += x[i] ** 3;
    S4 += x[i] ** 4;
    T0 += y[i];
    T1 += x[i] * y[i];
    T2 += x[i] ** 2 * y[i];
  }
  const A = [
    [S0, S1, S2, T0],
    [S1, S2, S3, T1],
    [S2, S3, S4, T2],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-14) continue;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [A[0][3] / (A[0][0] || 1), A[1][3] / (A[1][1] || 1), A[2][3] / (A[2][2] || 1)];
}

function linSlope(x: number[], y: number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  return sxx > 0 ? sxy / sxx : 0;
}

// ---------------------------------------------------------------------------
// Candidate fitting
// ---------------------------------------------------------------------------

export interface CandidateSummary {
  id: string;
  label: string;
  kind: HypothesisKind;
  fit: FitResult;
  template: TemplateCheck;
  controlPoints: number;
  rms: number;
  rmsFit: number;
  rmsHoldout: number;
  blend: number;
  maxCurvature: number;
  creasePresent: boolean;
  creaseLocation: { axis: 'u' | 'v'; at: number } | null;
  offsetProbes: string[];
  probeFactors: Record<string, number>;
}

export interface ArbitrationSettings {
  minWeight: number;
  normalWeight: number;
  offsetProbeWeight: number;
  controlPointBoost: { u: number; v: number };
}

export interface ArbitrationOptions {
  observations: Observation[];
  baseGeometry: SurfaceGeometryConfig;
  template: TemplatePoint[];
  settings: ArbitrationSettings;
  repeat: RepeatProbeInput;
  creaseLocation?: { axis: 'u' | 'v'; at: number };
  /** located defect station, so the overfit holdout avoids it */
  bandStation?: number | null;
}

export interface OverfitScanStep {
  /** per-axis control point increment over the base lattice */
  boost: number;
  controlPoints: number;
  rmsFit: number;
  rmsHoldout: number;
  maxCurvature: number;
}

export interface OverfitComparison {
  boosted: CandidateSummary;
  weighted: CandidateSummary;
  /** boosted in-sample residual minus robust in-sample residual (negative = boost fits better) */
  fitDelta: number;
  /** boosted held-out residual minus robust held-out residual (positive = boost generalises worse) */
  holdoutDelta: number;
  curvatureDelta: number;
  verdict: 'prefer-robust' | 'prefer-control-points' | 'inconclusive';
  explanation: string;
  /** complexity staircase at a fixed blocked holdout block */
  scan: OverfitScanStep[];
  holdoutIds: string[];
}

export interface ArbitrationResult {
  baseline: FitResult;
  nominal: FitResult;
  evidence: Evidence;
  repeat: RepeatEvidence;
  candidates: CandidateSummary[];
  chosen: CandidateSummary;
  hypothesis: HypothesisKind;
  score: HypothesisScore;
  pendingRegion: { uRange: [number, number]; vRange: [number, number]; reason: string } | null;
  notes: string[];
  overfitComparison: OverfitComparison | null;
}

export function makeSettings(geometry: SurfaceGeometryConfig, s: ArbitrationSettings) {
  return {
    geometry,
    minWeight: s.minWeight,
    useNormals: true,
    normalWeight: s.normalWeight,
    crease: null,
    // Huber: monotone, bounded-influence, never fully deletes a point. Tukey's
    // redescending weights can cascade on a coherently misfit boundary (the sharp
    // leading edge here) and erase clean data, so it is not the default.
    robust: 'huber' as const,
    offsetProbeWeight: s.offsetProbeWeight,
    controlPointBoost: s.controlPointBoost,
  };
}

export function candidate(
  id: string,
  label: string,
  kind: HypothesisKind,
  options: ArbitrationOptions,
  opts: {
    observations: Observation[];
    offsetProbes: string[];
    crease: { axis: 'u' | 'v'; at: number } | null;
    geometry?: SurfaceGeometryConfig;
    /** override robust reweighting; a crease candidate disables it because the
     *  fold rows are design, not outliers, and must not be down-weighted */
    robust?: 'none' | 'tukey';
    /** explicit held-out ids; defaults to a pointwise every-6th selection */
    holdoutIds?: string[];
    setup?: (g: SurfaceGeometryConfig) => SurfaceGeometryConfig;
  },
): CandidateSummary {
  let geometry = opts.geometry ?? { ...options.baseGeometry };
  if (opts.setup) geometry = opts.setup(geometry);
  if (opts.crease) {
    const applied = applyCrease(geometry, { enabled: true, direction: opts.crease.axis, at: opts.crease.at, hard: true });
    if (!applied.applied) throw new Error(applied.message);
    geometry = applied.geometry;
  }
  const baseSettings = makeSettings(geometry, options.settings);
  const request: FitRequest = {
    observations: opts.observations,
    settings: opts.robust ? { ...baseSettings, robust: opts.robust } : baseSettings,
    offsetProbes: opts.offsetProbes,
    holdoutIds: opts.holdoutIds ?? pickHoldout(opts.observations),
  };
  const fit = fitSurface(request);
  const template = checkTemplate(fit.lattice, options.template);
  return {
    id,
    label,
    kind,
    fit,
    template,
    controlPoints: geometry.countU * geometry.countV,
    rms: fit.rms,
    rmsFit: fit.rmsFit,
    rmsHoldout: fit.rmsHoldout,
    blend: fit.fairness.blend,
    maxCurvature: fit.fairness.maxCurvature,
    creasePresent: fit.fairness.creases.some((c) => Math.abs(c.continuity) < 1e-9),
    creaseLocation: opts.crease,
    offsetProbes: opts.offsetProbes,
    probeFactors: fit.probeFactors,
  };
}

/** Every 6th observation per probe is held out, spread over the domain. */
export function pickHoldout(observations: Observation[], every = 6): string[] {
  const counter = new Map<string, number>();
  const out: string[] = [];
  for (const o of observations) {
    const n = (counter.get(o.probeId) ?? 0) + 1;
    counter.set(o.probeId, n);
    if (n % every === 0) out.push(o.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template check
// ---------------------------------------------------------------------------

export function checkTemplate(lat: ControlLattice, template: TemplatePoint[], templateId = 'nominal-wingtip'): TemplateCheck {
  const signedDistances: TemplateCheck['signedDistances'] = [];
  let failures = 0;
  let minMargin = Infinity;
  for (const t of template) {
    const e = evaluateSurface(lat, t.u, t.v);
    const signed = dot(subtract(t.point, e.point), e.normal);
    const margin = t.tolerance - Math.abs(signed);
    if (margin < 0) failures++;
    minMargin = Math.min(minMargin, margin);
    signedDistances.push({ u: t.u, v: t.v, signed, tolerance: t.tolerance });
  }
  const passRate = template.length ? (template.length - failures) / template.length : 1;
  return { templateId, passRate, minMargin: Number.isFinite(minMargin) ? minMargin : 0, failures, signedDistances };
}

// ---------------------------------------------------------------------------
// Main arbitration
// ---------------------------------------------------------------------------

/** Fixed decision rule (documented in README and mirrored in the UI):
 *   1. Trial-fit the virtual template. If a C0 crease clearly improves it, the
 *      design itself contains a fold; that station is the candidate fold.
 *   2. Detect a localised measurement defect as a decisive row-profile model
 *      (single-row spike or spanwise step) of the residual against the template.
 *   3. If a probe's *median* template residual is shifted with a flat row
 *      profile and no local defect, the probe is globally offset.
 *   4. A deviation band with no repeat covering its station stays unresolved with
 *      a pending region; no machinable surface is released.
 *   5. A repeat scan that covers the station and reproduces a matching slope
 *      break confirms a design fold; if the crease candidate passes the template
 *      the fold is preserved. A repeat that covers the station and shows nothing
 *      classifies the deviation as instrument drift, handled by robust weights or
 *      by lowering the offset probe group's weight, and the band stays pending.
 *   The crease and smooth candidates share control point count and fairing
 *   weights; only the v knot multiplicity differs, so complexity is matched. */
export function arbitrate(options: ArbitrationOptions): ArbitrationResult {
  const notes: string[] = [];
  const holdout = pickHoldout(options.observations);

  const baseline = fitSurface({
    observations: options.observations,
    settings: { ...makeSettings(options.baseGeometry, options.settings), robust: 'none' },
    holdoutIds: holdout,
  });
  const evidence = gatherEvidence(baseline, options.template);
  notes.push(...evidence.warnings);

  const nominal = fitSurface({
    observations: options.observations,
    settings: makeSettings(options.baseGeometry, options.settings),
    holdoutIds: holdout,
  });
  notes.push(
    `基准拟合（无稳健加权）残差 RMS ${(baseline.rms * 1000).toFixed(3)} mm；稳健拟合 RMS ${(nominal.rms * 1000).toFixed(3)} mm。`,
  );

  const band = evidence.band;
  const templateFold = evidence.templateFold;
  const hasDesignFold = !!templateFold && templateFold.improvement >= TEMPLATE_FOLD_IMPROVEMENT;

  // The station whose status must be arbitrated: a measured deviation band, or a
  // fold seen in the template trial fit.
  const station = band ? band.vCenter : hasDesignFold ? templateFold!.at : null;
  const stationSignature: 'single-row' | 'fold' = band ? band.signature : 'fold';

  const repeat = station !== null
    ? assessRepeat(options.repeat, {
        vCenter: station,
        vMin: station,
        vMax: station,
        signature: stationSignature,
        probeIds: band ? band.probeIds : [],
        magnitude: band ? band.magnitude : 0,
        dbic: band ? band.dbic : 0,
        observationIds: band ? band.observationIds : [],
      })
    : {
        mode: options.repeat.mode,
        probeIds: options.repeat.observations.length ? [...new Set(options.repeat.observations.map((o) => o.probeId))] : [],
        reproducedMagnitude: null as number | null,
        reproducedSlope: null as number | null,
        reproducedSignature: null as 'single-row' | 'fold' | null,
        reproduces: null as boolean | null,
        covers: false,
        detail: evidence.globalOffsetProbes.length
          ? '检测到探头整体偏移，无局部形态，无需折线/漂移裁决。'
          : '未检测到形态突变，复测无需用于裁决。',
        perProbe: {},
      };

  const candidates: CandidateSummary[] = [];
  const smooth = candidate('smooth', '平滑基准（无折线、无降权）', 'unresolved', options, {
    observations: options.observations,
    offsetProbes: [],
    crease: null,
  });
  candidates.push(smooth);

  const offsetCandidate =
    evidence.globalOffsetProbes.length > 0
      ? candidate('offset-weighted', `整体偏移降权（${evidence.globalOffsetProbes.join(', ')}）`, 'instrument-drift', options, {
          observations: options.observations,
          offsetProbes: evidence.globalOffsetProbes,
          crease: null,
        })
      : null;
  if (offsetCandidate) candidates.push(offsetCandidate);

  const robustBand = band
    ? candidate('band-robust', '局部偏离稳健降权', 'instrument-drift', options, {
        observations: options.observations,
        offsetProbes: [],
        crease: null,
      })
    : null;
  if (robustBand) candidates.push(robustBand);

  const creaseStation = options.creaseLocation ?? (hasDesignFold ? { axis: 'v' as const, at: templateFold!.at } : band ? { axis: 'v' as const, at: band.vCenter } : null);
  let crease: CandidateSummary | null = null;
  if (creaseStation) {
    try {
      crease = candidate('crease', `折线假设 @${creaseStation.axis}=${creaseStation.at.toFixed(3)}`, 'design-crease', options, {
        observations: options.observations,
        offsetProbes: [],
        crease: creaseStation,
        robust: 'none',
      });
      candidates.push(crease);
    } catch (err) {
      notes.push(`折线候选无法构造：${(err as Error).message}`);
    }
  }

  let hypothesis: HypothesisKind = 'unresolved';
  let chosen: CandidateSummary = smooth;
  let pendingRegion: ArbitrationResult['pendingRegion'] = null;
  const rationale: string[] = [];

  if (hasDesignFold) {
    // The template itself encodes a fold.
    const corroborated = repeat.reproduces === true;
    const denied = repeat.reproduces === false;
    if (corroborated) {
      hypothesis = 'design-crease';
      chosen = crease ?? smooth;
      rationale.push(`虚拟样板试配表明设计本身在 v≈${templateFold!.at.toFixed(3)} 处含折线。`);
      rationale.push('对侧复测在同站位复现了展向斜率突变，两探头一致：折线必须保留才能过样板。');
      const passes = chosen.template.failures === 0;
      if (!passes) {
        rationale.push(`折线候选未通过虚拟样板（通过率 ${(chosen.template.passRate * 100).toFixed(0)}%），折线假设被否决，退回未决。`);
        hypothesis = 'unresolved';
        chosen = pickBestTemplate(candidates.filter((c) => c.id !== 'crease')) ?? smooth;
        pendingRegion = {
          uRange: [0, 1],
          vRange: [Math.max(0, templateFold!.at - 0.06), Math.min(1, templateFold!.at + 0.06)],
          reason: '折线已由样板与复测证认，但候选曲面未过样板',
        };
      } else {
        rationale.push(`折线候选与平滑候选控制点数相同（${chosen.controlPoints}），仅展向节点重数不同，复杂度可比；通过率 ${(chosen.template.passRate * 100).toFixed(0)}%，最小裕度 ${(chosen.template.minMargin * 1000).toFixed(2)} mm。`);
      }
    } else if (denied) {
      hypothesis = 'unresolved';
      chosen = pickBestTemplate(candidates.filter((c) => c.id !== 'crease')) ?? smooth;
      pendingRegion = {
        uRange: [0, 1],
        vRange: [Math.max(0, templateFold!.at - 0.06), Math.min(1, templateFold!.at + 0.06)],
        reason: '样板含折线，但对侧复测未复现，样板与实测不一致，待人工确认',
      };
      rationale.push('样板含折线，但对侧复测在同站位未复现，无法判定是样板偏差还是实测偏差，保持未决并保留待确认区。');
    } else {
      hypothesis = 'design-crease';
      chosen = crease ?? smooth;
      pendingRegion = {
        uRange: [0, 1],
        vRange: [Math.max(0, templateFold!.at - 0.06), Math.min(1, templateFold!.at + 0.06)],
        reason: '样板含折线但缺少复测覆盖，折线保留、待确认',
      };
      rationale.push('样板试配检出设计折线，但缺少覆盖该站位的复测；暂保留折线并标记待确认区。');
    }
  } else if (band) {
    if (repeat.reproduces === null) {
      hypothesis = 'unresolved';
      chosen = pickBestTemplate(candidates.filter((c) => c.id !== 'crease')) ?? smooth;
      pendingRegion = bandRegion(band, '缺少覆盖该展向站位的复测，无法区分仪器漂移与设计折线');
      rationale.push('偏离带明确存在，但没有复测覆盖该站位：同一形态既可解释为漂移也可解释为折线，工作台不擅自裁决。');
      rationale.push('待确认区已保留，可加工面输出被禁用。');
    } else if (repeat.reproduces) {
      hypothesis = 'design-crease';
      chosen = crease ?? smooth;
      rationale.push('复测在相同站位复现了同向展向斜率突变：符合贯穿蒙皮的真实设计折线。');
      if (!crease || crease.template.failures > 0) {
        rationale.push(`折线候选未通过虚拟样板（通过率 ${(crease ? crease.template.passRate * 100 : 0).toFixed(0)}%），折线假设被样板否决，退回未决。`);
        hypothesis = 'unresolved';
        chosen = pickBestTemplate(candidates.filter((c) => c.id !== 'crease')) ?? smooth;
        pendingRegion = bandRegion(band, '折线已证认但样板不通过');
      } else {
        rationale.push(`折线候选通过样板：通过率 ${(crease.template.passRate * 100).toFixed(0)}%，最小裕度 ${(crease.template.minMargin * 1000).toFixed(2)} mm。`);
        rationale.push('保留折线是过样板的必要条件，不能以平滑为先。');
      }
    } else {
      hypothesis = 'instrument-drift';
      chosen = offsetCandidate ?? robustBand ?? smooth;
      pendingRegion = bandRegion(band, '复测未复现该偏离，按漂移处理，但仍需人工确认该展向带');
      rationale.push('复测在同一站位未见量级相当且同形态的缺陷：偏离局限于本侧探头，按仪器漂移处理。');
      if (offsetCandidate) {
        rationale.push(`该探头同时存在整体偏移：${evidence.globalOffsetProbes.join(', ')} 组权重固定降为 ${options.settings.offsetProbeWeight}，其余为 1。`);
      } else {
        rationale.push('稳健权重压低偏离带测点的贡献，未删除任何观测。');
      }
      rationale.push('该展向带仍列为待确认区，不输出可加工面。');
    }
  } else if (evidence.globalOffsetProbes.length > 0) {
    hypothesis = 'instrument-drift';
    chosen = offsetCandidate ?? smooth;
    rationale.push('检测到探头组相对虚拟样板的整体偏移而非局部形态：降低该组权重即可，曲面形态不受影响。');
    rationale.push(`降权组：${evidence.globalOffsetProbes.join(', ')}，权重固定 ${options.settings.offsetProbeWeight}。`);
  } else {
    hypothesis = 'unresolved';
    chosen = smooth;
    rationale.push('测点相对虚拟样板既无孤立偏离也无整体偏移：平滑曲面即可解释全部测点，没有需要裁决的异常。');
  }

  const overfitComparison = band && band.signature === 'single-row' ? compareBoostVsWeight({ ...options, bandStation: band.vCenter }) : null;

  const score = buildScore(hypothesis, chosen, band, repeat, evidence, rationale);
  notes.push(...rationale);

  return {
    baseline,
    nominal,
    evidence,
    repeat,
    candidates,
    chosen,
    hypothesis,
    score,
    pendingRegion,
    notes,
    overfitComparison,
  };
}

function bandRegion(band: DeviationBand, reason: string) {
  return {
    uRange: [0, 1] as [number, number],
    vRange: [Math.max(0, band.vMin - 0.04), Math.min(1, band.vMax + 0.04)] as [number, number],
    reason,
  };
}

function pickBestTemplate(candidates: CandidateSummary[]): CandidateSummary | undefined {
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => {
    if (b.template.passRate !== a.template.passRate) return b.template.passRate - a.template.passRate;
    return a.blend - b.blend;
  })[0];
}

/** Contiguous spanwise block held out of the fit — two rows whose centre sits
 *  away from the defect band. A pointwise holdout is interpolated by any lattice
 *  dense enough to chase the artefact, so it cannot reveal overfitting; an
 *  unsampled strip is the honest test the validation study asks for. */
function blockedHoldout(observations: Observation[], bandStation: number | null, every = 5): string[] {
  const vs = [...new Set(observations.map((o) => Number(o.v.toFixed(6))))].sort((a, b) => a - b);
  if (vs.length < 5) return pickHoldout(observations, every);
  let bestIdx = -1;
  let bestScore = Infinity;
  for (let i = 1; i < vs.length - 2; i++) {
    const centre = (vs[i] + vs[i + 1]) / 2;
    // prefer a block near 1/3 of the span, and never adjacent to the defect
    const awayFromBand = bandStation === null ? 0 : Math.max(0, 0.12 - Math.abs(centre - bandStation));
    const score = Math.abs(centre - 0.33) + 10 * awayFromBand;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 1) return pickHoldout(observations, every);
  const block = new Set([vs[bestIdx], vs[bestIdx + 1]].map((v) => v.toFixed(6)));
  const ids = observations.filter((o) => block.has(o.v.toFixed(6))).map((o) => o.id);
  return ids.length > 0 ? ids : pickHoldout(observations, every);
}

/** Compare adding control points (to chase the deviation) with robust
 *  down-weighting on the same observations. Overfitting shows up as an in-sample
 *  residual that improves while the held-out residual and curvature worsen.
 *  Both candidates use the same fairing/prior weights; the boost candidate turns
 *  robust reweighting OFF (the two are alternative answers to the same question,
 *  not settings to stack) and adds the configured control-point boost. The scan
 *  records the complexity staircase so the point where extra freedom stops
 *  paying for itself is visible. */
function compareBoostVsWeight(options: ArbitrationOptions): OverfitComparison {
  const holdoutIds = blockedHoldout(options.observations, options.bandStation ?? null);
  const scan: OverfitScanStep[] = [];
  let boosted: CandidateSummary | null = null;
  for (const boost of [2, 4, 6]) {
    const cu = options.baseGeometry.countU + boost;
    const cv = options.baseGeometry.countV + boost;
    const step = candidate(`boosted-${boost}`, `增设 ${boost}×${boost} 控制点`, 'unresolved', options, {
      observations: options.observations,
      offsetProbes: [],
      crease: null,
      robust: 'none',
      holdoutIds,
      setup: (g) => ({
        ...g,
        countU: cu,
        countV: cv,
        interiorU: uniformKnots(cu, g.degreeU),
        interiorV: uniformKnots(cv, g.degreeV),
      }),
    });
    scan.push({
      boost,
      controlPoints: cu * cv,
      rmsFit: step.rmsFit,
      rmsHoldout: step.rmsHoldout,
      maxCurvature: step.maxCurvature,
    });
    boosted = step;
  }
  const weighted = candidate('weighted', '稳健降权偏离点', 'instrument-drift', options, {
    observations: options.observations,
    offsetProbes: [],
    crease: null,
    holdoutIds,
  });
  if (!boosted) throw new Error('overfit comparison produced no boosted candidate');
  const fitDelta = boosted.rmsFit - weighted.rmsFit;
  const holdoutDelta = boosted.rmsHoldout - weighted.rmsHoldout;
  const curvatureDelta = boosted.maxCurvature - weighted.maxCurvature;
  let verdict: OverfitComparison['verdict'] = 'inconclusive';
  let explanation = '';
  const inSample = `参与拟合残差 ${(weighted.rmsFit * 1000).toFixed(3)}→${(boosted.rmsFit * 1000).toFixed(3)} mm`;
  const held = `未采样条带残差 ${(weighted.rmsHoldout * 1000).toFixed(3)}→${(boosted.rmsHoldout * 1000).toFixed(3)} mm`;
  const curv = `最大曲率 ${weighted.maxCurvature.toExponential(2)}→${boosted.maxCurvature.toExponential(2)}`;
  // The staircase's last step is what decides: if the highest complexity buys a
  // lower in-sample error at the cost of the held-out strip and curvature, the
  // extra freedom is fitting noise.
  const last = scan[scan.length - 1];
  const prev = scan[scan.length - 2];
  const stillImproving = last.rmsFit < prev.rmsFit * 0.98;
  const staircase = scan
    .map((s) => `+${s.boost}(${s.controlPoints}cp):${(s.rmsFit * 1000).toFixed(3)}mm`)
    .join(' → ');
  const curvRise = weighted.maxCurvature > 0 ? boosted.maxCurvature / weighted.maxCurvature : Infinity;
  if (fitDelta < -5e-5 && holdoutDelta > 5e-5 && curvatureDelta > 0) {
    verdict = 'prefer-robust';
    explanation = `增设控制点后${inSample}（改善），但${held}（恶化）、${curv}（上升）：新增自由度被用来穿过偏离测点，未采样区形态变差。优先降低离群权重而非加控制点。`;
  } else if (fitDelta < -5e-5 && holdoutDelta < -5e-5 && curvatureDelta <= 0) {
    verdict = 'prefer-control-points';
    explanation = `增设控制点后${inSample}且${held}，${curv}未上升：偏离更可能是真实形态而非噪声。`;
  } else if (!stillImproving && curvRise > 1.5) {
    verdict = 'prefer-robust';
    explanation =
      `自由度阶梯（参与拟合残差）${staircase}：加到 ${prev.controlPoints} 控制点后拟合已基本饱和，` +
      `再加到 ${last.controlPoints} 反而升至 ${(last.rmsFit * 1000).toFixed(3)} mm；与此同时${curv}，形态代价为降权方案的 ${curvRise.toFixed(1)} 倍。` +
      `新增自由度没有换来拟合改善，只增加了形变，应改用降权而非继续加控制点。`;
  } else {
    explanation = `${inSample}，${held}，${curv}。证据不足以区分「加控制点」与「降权」，需补充测点或人工判断。`;
  }
  return { boosted, weighted, fitDelta, holdoutDelta, curvatureDelta, verdict, explanation, scan, holdoutIds };
}

function uniformKnots(count: number, degree: number): number[] {
  const m = count - degree - 1;
  const out: number[] = [];
  for (let i = 1; i <= m; i++) out.push(i / (m + 1));
  return out;
}

function buildScore(
  kind: HypothesisKind,
  chosen: CandidateSummary,
  band: DeviationBand | null,
  repeat: RepeatEvidence,
  evidence: Evidence,
  rationale: string[],
): HypothesisScore {
  const probeBandSignedMeans: Record<string, number> = {};
  if (band) {
    for (const p of evidence.probes) {
      if (band.probeIds.includes(p.probeId)) probeBandSignedMeans[p.probeId] = p.templateBias;
    }
  }
  return {
    kind,
    candidate: {
      controlPoints: chosen.controlPoints,
      rms: chosen.rms,
      rmsHoldout: chosen.rmsHoldout,
      blend: chosen.blend,
      maxCurvature: chosen.maxCurvature,
      creasePresent: chosen.creasePresent,
      creaseLocation: chosen.creaseLocation,
      offsetProbeWeighting: chosen.probeFactors,
    },
    deviationRows: band ? band.observationIds.length : 0,
    rowSignCoherence: band ? 1 : 0,
    repeatReproduces: repeat.reproduces,
    repeatProbeIds: repeat.probeIds,
    probeBandSignedMeans,
    templatePassRate: chosen.template.passRate,
    templateMinMargin: chosen.template.minMargin,
    recommended: kind !== 'unresolved',
    rationale,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
export function robustSigma(xs: number[]): number {
  if (xs.length === 0) return 1e-6;
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)));
  return Math.max(1.4826 * mad, 1e-6);
}

export function pointToSurfaceDistance(lat: ControlLattice, p: Vec3, u: number, v: number): { signed: number; distance: number; normal: Vec3 } {
  const e = evaluateSurface(lat, u, v);
  const diff = subtract(p, e.point);
  return { signed: dot(diff, e.normal), distance: norm(diff), normal: e.normal };
}

export function normalizeNormal(n: Vec3): Vec3 {
  return normalize(n);
}
