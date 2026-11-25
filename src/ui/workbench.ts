import { applyCrease, fitSurface, defaultGeometry } from '../core/fit.js';
import { uniformInterior } from '../core/bspline.js';
import { checkTemplate, pickHoldout } from '../core/arbitration.js';
import { buildExport, buildReadiness, probeLocalResiduals } from '../core/readiness.js';
import { evaluateSurface } from '../core/surface.js';
import type {
  ControlLattice,
  CreaseHypothesis,
  FitResult,
  FittingSettings,
  Observation,
  ReadinessReport,
  RobustMode,
  SurfaceExport,
  SurfaceGeometryConfig,
} from '../core/types.js';
import type { WorkbenchSession } from '../scenarios/session.js';

/** The subset of fitting knobs the workbench exposes to the operator. Everything
 *  else (parameterization, labels, probe roles) is fixed by the verified input and
 *  is deliberately not editable. */
export interface EditableSettings {
  countU: number;
  countV: number;
  tensionU: number;
  tensionV: number;
  blendU: number;
  blendV: number;
  prior: number;
  robust: RobustMode;
  normalWeight: number;
  offsetProbeWeight: number;
  crease: { enabled: boolean; at: number; direction: 'u' | 'v' };
  /** manual weight per probe group; 1 = unchanged */
  probeWeights: Record<string, number>;
}

export function initialEditable(session: WorkbenchSession): EditableSettings {
  const g = session.geometry;
  const crease = session.arbitration.chosen.creaseLocation;
  return {
    countU: g.countU,
    countV: g.countV,
    tensionU: g.tensionWeightU,
    tensionV: g.tensionWeightV,
    blendU: g.blendWeightU,
    blendV: g.blendWeightV,
    prior: g.priorWeight,
    robust: 'huber',
    normalWeight: 0.35,
    offsetProbeWeight: 0.12,
    crease: crease ? { enabled: true, at: crease.at, direction: crease.axis } : { enabled: false, at: 0.5, direction: 'v' },
    probeWeights: {},
  };
}

export interface RefitResult {
  fit: FitResult;
  template: ReturnType<typeof checkTemplate>;
  readiness: ReadinessReport;
  settings: EditableSettings;
  geometry: SurfaceGeometryConfig;
  error: string | null;
}

/** Refit the current session's observation set with operator-edited settings.
 *  The hypothesis (instrument-drift vs design-crease) and the pending region come
 *  from the arbitration layer and are NOT recomputed here — the operator is editing
 *  a given hypothesis' surface, not re-deciding the hypothesis. */
export function refit(session: WorkbenchSession, editable: EditableSettings): RefitResult {
  let geometry = defaultGeometry({
    degreeU: session.geometry.degreeU,
    degreeV: session.geometry.degreeV,
    countU: editable.countU,
    countV: editable.countV,
    interiorU: uniformInterior(editable.countU, session.geometry.degreeU),
    interiorV: uniformInterior(editable.countV, session.geometry.degreeV),
    tensionWeightU: editable.tensionU,
    tensionWeightV: editable.tensionV,
    blendWeightU: editable.blendU,
    blendWeightV: editable.blendV,
    priorWeight: editable.prior,
    robustCutoff: session.geometry.robustCutoff,
    robustIterations: session.geometry.robustIterations,
  });
  if (editable.crease.enabled) {
    const applied = applyCrease(geometry, {
      enabled: true,
      direction: editable.crease.direction,
      at: editable.crease.at,
      hard: true,
    });
    if (applied.applied) geometry = applied.geometry;
  }

  const creaseHypothesis: CreaseHypothesis | null = editable.crease.enabled
    ? { enabled: true, direction: editable.crease.direction, at: editable.crease.at, hard: true }
    : null;
  const settings: FittingSettings = {
    geometry,
    minWeight: 1e-6,
    useNormals: true,
    normalWeight: editable.normalWeight,
    crease: creaseHypothesis,
    robust: editable.robust,
    offsetProbeWeight: editable.offsetProbeWeight,
    controlPointBoost: { u: 0, v: 0 },
  };

  const observations: Observation[] = session.observations.map((o) =>
    editable.probeWeights[o.probeId] !== undefined ? { ...o, manualWeight: editable.probeWeights[o.probeId] } : o,
  );
  const offsetProbes = Object.entries(editable.probeWeights)
    .filter(([, w]) => w < 1)
    .map(([p]) => p);

  try {
    const fit = fitSurface({
      observations,
      settings,
      offsetProbes,
      probeWeights: editable.probeWeights,
      holdoutIds: pickHoldout(observations),
    });
    const template = checkTemplate(fit.lattice, session.template);
    const arbitrationForReadiness = {
      ...session.arbitration,
      chosen: { ...session.arbitration.chosen, fit, template, rms: fit.rms, rmsHoldout: fit.rmsHoldout },
    };
    const readiness = buildReadiness({
      spec: session.bundle.spec,
      validation: session.validation,
      arbitration: arbitrationForReadiness,
      hasRepeatForBand: session.arbitration.repeat.reproduces !== null,
      resolvedLabelIssues: session.validation.rejected.length === 0,
    });
    return { fit, template, readiness, settings: editable, geometry, error: null };
  } catch (err) {
    return {
      fit: session.arbitration.chosen.fit,
      template: session.arbitration.chosen.template,
      readiness: session.readiness,
      settings: editable,
      geometry,
      error: (err as Error).message,
    };
  }
}

export function inspectLocal(fit: FitResult, u: number, v: number) {
  return probeLocalResiduals(fit, u, v, 8);
}

export function exportSurface(fit: FitResult, readiness: ReadinessReport): SurfaceExport {
  return buildExport(fit.lattice, readiness, fit.rms, fit.fairness.blend, fit.fairness.maxCurvature, 41, 41);
}

/** Flatten the surface into a triangle soup + per-vertex residual shading for the
 *  viewer. Residual shading is nearest-observation distance normalized to the
 *  fit's own scale. */
export interface ViewerMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  nu: number;
  nv: number;
  maxResidual: number;
}

export function buildViewerMesh(lat: ControlLattice, residuals: FitResult['residuals'], nu = 49, nv = 49): ViewerMesh {
  const positions = new Float32Array(nu * nv * 3);
  const normals = new Float32Array(nu * nv * 3);
  const colors = new Float32Array(nu * nv * 3);
  const indices: number[] = [];
  const scale = percentile(residuals.map((r) => r.distance), 0.9) || 1e-4;
  for (let i = 0; i < nu; i++) {
    const u = lat.uMin + ((lat.uMax - lat.uMin) * i) / (nu - 1);
    for (let j = 0; j < nv; j++) {
      const v = lat.vMin + ((lat.vMax - lat.vMin) * j) / (nv - 1);
      const k = i * nv + j;
      const e = evaluateSurface(lat, u, v);
      positions[k * 3] = e.point[0];
      positions[k * 3 + 1] = e.point[1];
      positions[k * 3 + 2] = e.point[2];
      normals[k * 3] = e.normal[0];
      normals[k * 3 + 1] = e.normal[1];
      normals[k * 3 + 2] = e.normal[2];
      // shade by a Gaussian-weighted blend of nearby measured residuals: nearest-
      // neighbour paints Voronoi patches that read as structure the fit lacks, and
      // an inverse-square kernel is so peaked it degenerates to the same thing.
      let wsum = 0;
      let rsum = 0;
      const sigma = 0.045;
      const cutoff = 3 * sigma;
      for (const r of residuals) {
        const d2 = (r.u - u) ** 2 + (r.v - v) ** 2;
        if (d2 > cutoff * cutoff) continue;
        const w = Math.exp(-d2 / (2 * sigma * sigma));
        wsum += w;
        rsum += w * r.distance;
      }
      const local = wsum > 0 ? rsum / wsum : scale;
      const t = Math.min(1, local / scale);
      const [cr, cg, cb] = heat(t);
      colors[k * 3] = cr;
      colors[k * 3 + 1] = cg;
      colors[k * 3 + 2] = cb;
    }
  }
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j;
      const b = (i + 1) * nv + j;
      const c = (i + 1) * nv + j + 1;
      const d = i * nv + j + 1;
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, normals, colors, indices: Uint32Array.from(indices), nu, nv, maxResidual: scale };
}

/** Parameter value of the nearest surface point for a clicked 3D position;
 *  returns the parameter pair to feed the local-residual inspector. */
export function nearestParameter(lat: ControlLattice, p: [number, number, number], nu = 33, nv = 33): { u: number; v: number } {
  let best = { u: 0.5, v: 0.5, d: Infinity };
  for (let i = 0; i <= nu; i++) {
    const u = lat.uMin + ((lat.uMax - lat.uMin) * i) / nu;
    for (let j = 0; j <= nv; j++) {
      const v = lat.vMin + ((lat.vMax - lat.vMin) * j) / nv;
      const e = evaluateSurface(lat, u, v);
      const d = (e.point[0] - p[0]) ** 2 + (e.point[1] - p[1]) ** 2 + (e.point[2] - p[2]) ** 2;
      if (d < best.d) best = { u, v, d };
    }
  }
  return { u: best.u, v: best.v };
}

function heat(t: number): [number, number, number] {
  // blue (near) -> green -> yellow -> red (far)
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.5) {
    const s = x / 0.5;
    return [0.12 * s, 0.45 + 0.35 * s, 0.85 * (1 - s) + 0.35];
  }
  const s = (x - 0.5) / 0.5;
  return [0.12 + 0.8 * s, 0.8 - 0.6 * s, 0.35 * (1 - s)];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
