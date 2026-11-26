/** Verification of a reconstruction.
 *
 *  Two roles that must stay separate:
 *    - `assemble()` is the ASSEMBLER: it reads only the fitted surface and the
 *      independent fixture, and reports the mating gap and per-edge coverage. It
 *      never reads the truth surface or the observations.
 *    - `analyseTruthError()` and friends are VERIFICATION: they compare the fit to
 *      the truth and to the observations to explain *why* a feature was lost.
 *
 *  When two point clouds have similar overall residual, the residual cannot decide
 *  which edge still needs measurement — the actual mating coverage per edge
 *  segment can. `edgeAdvice()` implements that: a segment with poor coverage and
 *  sparse observations is "add measurement"; the same poor coverage with dense
 *  observations points to a methodology problem instead. */

import type { ControlLattice, Vec3 } from '../core/types.js';
import { dot, evaluateSurface, norm, subtract } from '../core/surface.js';
import { coverageGrid } from '../core/surface.js';
import { crestHeightAt } from './fixture.js';
import { chordEnvelope, ridgeBandHalfWidth, truthPoint } from './truthSurface.js';
import type {
  CoverageReport,
  EdgeAdviceReport,
  Fixture,
  FixtureSegment,
  LostFeature,
  MatingReport,
  OutlierReport,
  ReconstructionAnalysis,
  SegmentCoverage,
  TruthErrorReport,
  TruthErrorHotspot,
  TruthSpec,
} from './types.js';
import type { FabricatedObservation } from './types.js';
import type { FitResult } from '../core/types.js';

/** Coverage below which an edge segment is considered under-engaged and the
 *  assembler asks for a decision. Fixed policy, not a per-package knob. */
const EDGE_QUALITY_BAR = 0.9;

/** Assembler: mate the fitted surface with the independent fixture. */
export function assemble(lattice: ControlLattice, fixture: Fixture): MatingReport {
  let total = 0;
  let engaged = 0;
  let maxGap = 0;
  let sqGap = 0;
  let minSigned = Infinity;
  let maxSigned = -Infinity;

  const perSegment = new Map<string, { total: number; engaged: number; maxGap: number }>();
  for (const seg of fixture.landmarks.segments) perSegment.set(seg.id, { total: 0, engaged: 0, maxGap: 0 });

  for (const p of fixture.points) {
    const e = evaluateSurface(lattice, p.u, p.v);
    const signed = dot(subtract(p.point, e.point), p.normal);
    const gap = Math.abs(signed);
    total++;
    sqGap += signed * signed;
    minSigned = Math.min(minSigned, signed);
    maxSigned = Math.max(maxSigned, signed);
    if (gap <= p.tolerance) engaged++;
    maxGap = Math.max(maxGap, gap);

    if (p.kind === 'ridge' && p.segmentId) {
      const s = perSegment.get(p.segmentId);
      if (s) {
        s.total++;
        if (gap <= p.tolerance) s.engaged++;
        s.maxGap = Math.max(s.maxGap, gap);
      }
    }
  }

  const segments: SegmentCoverage[] = fixture.landmarks.segments.map((seg) => {
    const s = perSegment.get(seg.id) ?? { total: 0, engaged: 0, maxGap: 0 };
    return {
      id: seg.id,
      label: seg.label,
      uRange: seg.uRange,
      total: s.total,
      engaged: s.engaged,
      coverage: s.total > 0 ? s.engaged / s.total : 1,
      maxGap: s.maxGap,
    };
  });

  const worstSegment = segments.length
    ? [...segments].sort((a, b) => a.coverage - b.coverage || b.maxGap - a.maxGap)[0]
    : null;

  return {
    total,
    engaged,
    coverage: total > 0 ? engaged / total : 1,
    maxGap,
    rmsGap: total > 0 ? Math.sqrt(sqGap / total) : 0,
    minSigned: Number.isFinite(minSigned) ? minSigned : 0,
    maxSigned: Number.isFinite(maxSigned) ? maxSigned : 0,
    segments,
    worstSegment,
  };
}

interface TruthCell {
  u: number;
  v: number;
  n: number;
  sum: number;
  max: number;
}

/** Verification: signed/unsigned distance between the fitted surface and the
 *  analytic truth on a grid, with the error concentrated into coloured hotspots. */
export function analyseTruthError(lattice: ControlLattice, spec: TruthSpec, cells = 10): TruthErrorReport {
  const nu = 41;
  const nv = 41;
  let sq = 0;
  let max = 0;
  let n = 0;
  let bandSq = 0;
  let bandMax = 0;
  let bandN = 0;
  const halfBand = ridgeBandHalfWidth(spec);
  const grid = new Map<string, TruthCell>();

  for (let i = 0; i < nu; i++) {
    const u = i / (nu - 1);
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      const e = evaluateSurface(lattice, u, v);
      const t = truthPoint(u, v, spec);
      const d = norm(subtract(e.point, t));
      sq += d * d;
      max = Math.max(max, d);
      n++;
      if (Math.abs(v - spec.ridgeV) <= halfBand) {
        bandSq += d * d;
        bandMax = Math.max(bandMax, d);
        bandN++;
      }
      const ci = Math.min(cells - 1, Math.floor(u * cells));
      const cj = Math.min(cells - 1, Math.floor(v * cells));
      const key = `${ci}:${cj}`;
      const c = grid.get(key) ?? { u: (ci + 0.5) / cells, v: (cj + 0.5) / cells, n: 0, sum: 0, max: 0 };
      c.n++;
      c.sum += d * d;
      c.max = Math.max(c.max, d);
      grid.set(key, c);
    }
  }

  const allCells = [...grid.values()].map((c) => ({ u: c.u, v: c.v, meanError: Math.sqrt(c.sum / Math.max(1, c.n)), maxError: c.max }));
  const ranked = [...allCells].sort((a, b) => b.meanError - a.meanError);

  return {
    rms: n ? Math.sqrt(sq / n) : 0,
    max,
    bandRms: bandN ? Math.sqrt(bandSq / bandN) : 0,
    bandMax,
    hotspots: ranked.slice(0, 6).map((c) => ({ ...c, coverage: 0 })),
  };
}

/** Observation coverage over the parameter domain, plus the count inside the
 *  sharp-edge band. */
export function analyseCoverage(
  observations: FabricatedObservation[],
  spec: TruthSpec,
  bins = 8,
): CoverageReport {
  const grid = coverageGrid(
    observations.map((o) => o.u),
    observations.map((o) => o.v),
    0,
    1,
    0,
    1,
    bins,
  );
  const halfBand = ridgeBandHalfWidth(spec);
  const ridgeBandCount = observations.filter((o) => Math.abs(o.v - spec.ridgeV) <= halfBand).length;
  return {
    occupancy: grid.occupancy,
    emptyBins: grid.emptyBins.length,
    totalBins: grid.totalBins,
    bins,
    ridgeBandCount,
  };
}

/** Outliers: which injected points the robust kernel down-weighted. */
export function analyseOutliers(fit: FitResult, observations: FabricatedObservation[]): OutlierReport {
  const weightById = new Map(fit.residuals.map((r) => [r.id, r]));
  const injected = observations.filter((o) => o.reliability.status === 'outlier');
  const detected: string[] = [];
  let sumWeight = 0;
  for (const o of injected) {
    const r = weightById.get(o.id);
    if (!r) continue;
    sumWeight += r.robustWeight;
    // robust factor < 0.5 OR flagged as an outlier candidate counts as handled
    if (r.robustWeight < 0.5 || r.isOutlierCandidate) detected.push(o.id);
  }
  return {
    injected: injected.length,
    detectedIds: detected,
    meanRobustWeight: injected.length ? sumWeight / injected.length : 1,
    downweighted: detected.length,
  };
}

/** Lost features: where the reconstruction fails to carry the design crest.
 *
 *  The test is direct: evaluate the fitted surface at the design apex (u, ridgeV)
 *  and compare to the design crest height. A feature is "lost" when the fit sits
 *  well below the design crest. Whether that loss is due to *sampling* (the apex
 *  row was never measured — the flanks were measured instead) or to *method* (the
 *  apex was measured but interpolation/formulation removed it) is decided by the
 *  observation density exactly at the apex band, not just anywhere in the band. */
export function findLostFeatures(
  lattice: ControlLattice,
  observations: FabricatedObservation[],
  spec: TruthSpec,
  noiseSigma: number,
): LostFeature[] {
  const apexEps = Math.max(0.02, 0.5 * spec.ridgeHalfWidthV);
  const lost: LostFeature[] = [];
  const us = 41;
  const apexRow = observations.filter((o) => Math.abs(o.v - spec.ridgeV) <= apexEps);

  // scan the crest chordwise; report the worst contiguous losses
  const defects: { u: number; loss: number; density: number }[] = [];
  const du = 0.05;
  for (let i = 1; i < us - 1; i++) {
    const u = i / (us - 1);
    if (chordEnvelope(u, spec) < 0.5) continue;
    const e = evaluateSurface(lattice, u, spec.ridgeV);
    const designCrest = truthPoint(u, spec.ridgeV, spec)[2];
    const loss = designCrest - e.point[2];
    if (loss < Math.max(4 * noiseSigma, 8e-4)) continue;
    const localApex = apexRow.filter((o) => Math.abs(o.u - u) <= du).length;
    defects.push({ u, loss, density: localApex });
  }

  // collapse adjacent defects into one reported feature per lobe
  for (const d of defects) {
    const magnitude = Math.max(d.loss, crestHeightAt(d.u, spec));
    const sparse = d.density < 2;
    lost.push({
      u: d.u,
      v: spec.ridgeV,
      magnitude,
      coverage: Math.min(1, d.density / 3),
      reason: sparse
        ? '尖棱峰顶排未被测到（采样表 A 把峰顶落在两排之间）：重建只能连线两侧翼面，棱被削平'
        : '峰顶排已测到，但重建仍未承载棱：更像成型/标定方法（截面插值）把棱抹平',
      advice: sparse ? 'add-measurement' : 'method-review',
    });
  }
  return lost;
}

/** Edge-measurement advice.
 *
 *  Which edge segment to strengthen is decided by the *actual mating coverage*
 *  per segment, not by the overall residual — two reconstructions can share the
 *  same in-sample residual yet mate very differently along the sharp edge. Once
 *  the weakest segment is chosen, whether to add measurements or review the
 *  method is decided by whether the *apex row* of that segment was ever
 *  measured:
 *    - apex not measured (flanks only)      -> add measurements there,
 *    - apex measured but crest still lost   -> method review (formulation loses it).
 *  This is exactly the boundary condition that separates "sample an analytic
 *  surface" from "assemble from calibrated sections": in the second case the apex
 *  samples exist but are already flattened by interpolation. */
export function edgeAdvice(
  mating: MatingReport,
  observations: FabricatedObservation[],
  fixture: Fixture,
  spec: TruthSpec,
  coverageMin: number,
): EdgeAdviceReport {
  const worst = mating.worstSegment;
  if (!worst) {
    return { segmentId: null, label: '—', coverage: mating.coverage, observationDensity: 0, advice: 'none', detail: '样板没有可分析的分段棱边。' };
  }
  const segment = fixture.landmarks.segments.find((s) => s.id === worst.id) as FixtureSegment | undefined;
  if (!segment) {
    return { segmentId: worst.id, label: worst.label, coverage: worst.coverage, observationDensity: 0, advice: 'none', detail: '棱边分段缺失。' };
  }
  const apexEps = Math.max(0.02, 0.5 * spec.ridgeHalfWidthV);
  const density = observations.filter(
    (o) => o.u >= segment.uRange[0] - 0.03 && o.u <= segment.uRange[1] + 0.03 && Math.abs(o.v - spec.ridgeV) <= apexEps,
  ).length;

  if (worst.coverage >= coverageMin) {
    return {
      segmentId: worst.id,
      label: worst.label,
      coverage: worst.coverage,
      observationDensity: density,
      advice: 'none',
      detail: `各棱边分段扣合率均不低于 ${(coverageMin * 100).toFixed(0)}%，无需补测。`,
    };
  }

  const apexMeasured = density >= 5;
  const advice: EdgeAdviceReport['advice'] = apexMeasured ? 'method-review' : 'add-measurement';
  return {
    segmentId: worst.id,
    label: worst.label,
    coverage: worst.coverage,
    observationDensity: density,
    advice,
    detail: apexMeasured
      ? `${worst.label}扣合率仅 ${(worst.coverage * 100).toFixed(0)}%，峰顶排已测得（${density} 点）却仍失棱：数据已覆盖，补测无益，应复核成型/标定方法。`
      : `${worst.label}扣合率仅 ${(worst.coverage * 100).toFixed(0)}%，峰顶排未测（该带仅 ${density} 个翼面点）：应在 u∈[${segment.uRange[0].toFixed(2)}, ${segment.uRange[1].toFixed(2)}]、v≈${spec.ridgeV.toFixed(2)} 补测峰顶排。`,
  };
}

/** Full analysis of one reconstructed package. The assembler part (`mating`)
 *  touches only the lattice and the fixture; the remaining fields are
 *  verification against truth and observations. */
export function analyseReconstruction(
  fit: FitResult,
  observations: FabricatedObservation[],
  fixture: Fixture,
  spec: TruthSpec,
): ReconstructionAnalysis {
  const mating = assemble(fit.lattice, fixture);
  const truthError = analyseTruthError(fit.lattice, spec);
  const coverage = analyseCoverage(observations, spec);
  const outliers = analyseOutliers(fit, observations);
  const lostFeatures = findLostFeatures(fit.lattice, observations, spec, observations[0]?.reliability.sigma ?? 3.5e-4);
  const advice = edgeAdvice(mating, observations, fixture, spec, EDGE_QUALITY_BAR);
  return {
    mating,
    truthError,
    coverage,
    outliers,
    lostFeatures,
    edgeAdvice: advice,
    fitRms: fit.rms,
    fitRmsHoldout: fit.rmsHoldout,
    controlPointCount: fit.lattice.countU * fit.lattice.countV,
    observationCount: observations.length,
  };
}

export function vectorToArray(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}
