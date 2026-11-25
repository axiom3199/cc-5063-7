import type {
  ControlLattice,
  FitResult,
  HypothesisKind,
  ReadinessReport,
  ReadinessState,
  SurfaceExport,
  Vec3,
} from './types.js';
import { evaluateSurface, sampleSurface } from './surface.js';
import type { ArbitrationResult } from './arbitration.js';
import type { LabelValidation } from '../scenarios/measurementFile.js';
import type { ScenarioSpec } from '../scenarios/scenarios.js';

export interface ReadinessInput {
  spec: ScenarioSpec;
  validation: LabelValidation;
  arbitration: ArbitrationResult;
  /** whether the operator has acknowledged the pending region */
  acknowledgedPending?: boolean;
  /** whether a repeat pass capable of covering the pending band exists */
  hasRepeatForBand: boolean;
  /** user-confirmed label groups */
  resolvedLabelIssues?: boolean;
}

/** Translate the arbitration outcome into a release decision. The workbench may
 *  always export an editable surface, but only releases a machinable one when
 *  every gate is satisfied. */
export function buildReadiness(input: ReadinessInput): ReadinessReport {
  const { arbitration, validation, spec } = input;
  const checks: ReadinessReport['checks'] = [];
  const reasons: string[] = [];

  // 1. label integrity
  const labelOk = validation.rejected.length === 0;
  checks.push({
    id: 'labels',
    label: '参数标签完整且唯一',
    ok: labelOk || !!input.resolvedLabelIssues,
    detail: labelOk
      ? `全部 ${validation.checked} 条记录标签通过校验`
      : `${validation.issues.length} 个标签问题（缺失/重复/越界）；${validation.rejected.length} 条记录被隔离，未补齐`,
  });
  if (!labelOk && !input.resolvedLabelIssues) reasons.push('参数标签存在问题，被隔离的记录尚未人工确认。');

  // 2. hypothesis resolved
  const hypothesisOk = arbitration.hypothesis !== 'unresolved';
  checks.push({
    id: 'hypothesis',
    label: '漂移 / 折线假设已裁决',
    ok: hypothesisOk,
    detail: hypothesisOk
      ? `裁决结果：${describeHypothesis(arbitration.hypothesis)}`
      : '偏离带仍不可区分，保持未决',
  });
  if (!hypothesisOk) reasons.push('漂移与折线假设尚未裁决，不能据此输出可加工面。');

  // 3. pending region
  const pending = arbitration.pendingRegion;
  const pendingOk = !pending || !!input.acknowledgedPending;
  checks.push({
    id: 'pending',
    label: '待确认区已关闭或人工确认',
    ok: !pending,
    detail: pending
      ? `存在待确认区 v∈[${pending.vRange[0].toFixed(2)}, ${pending.vRange[1].toFixed(2)}]：${pending.reason}`
      : '没有待确认区',
  });
  if (pending) reasons.push(`待确认区 v∈[${pending.vRange[0].toFixed(2)}, ${pending.vRange[1].toFixed(2)}] 需要确认后才能发布。`);

  // 4. template
  const templateOk = arbitration.chosen.template.failures === 0;
  checks.push({
    id: 'template',
    label: '虚拟样板通过',
    ok: templateOk,
    detail: `通过率 ${(arbitration.chosen.template.passRate * 100).toFixed(0)}%，最小裕度 ${(arbitration.chosen.template.minMargin * 1000).toFixed(2)} mm`,
  });
  if (!templateOk) reasons.push('曲面未通过虚拟样板，形状超出容差。');

  // 5. observation diagnostics
  const diag = arbitration.chosen.fit.diagnostics;
  const diagOk = diag.rankDeficiency === 0 && diag.dataPerUnknown >= 1;
  checks.push({
    id: 'diagnostics',
    label: '可辨识性诊断通过',
    ok: diagOk,
    detail: `观测/自由控制点 = ${diag.dataPerUnknown.toFixed(2)}，秩亏 ${diag.rankDeficiency}`,
  });
  if (!diagOk) reasons.push('拟合问题欠约束或秩亏，曲面解不唯一。');

  // 6. overfit check on holdout
  const holdoutOk = arbitration.chosen.fit.rmsHoldout <= Math.max(arbitration.chosen.fit.rmsFit * 2.5, 0.0006);
  checks.push({
    id: 'holdout',
    label: '留出点检验未见过拟合',
    ok: holdoutOk,
    detail: `留出残差 ${(arbitration.chosen.fit.rmsHoldout * 1000).toFixed(3)} mm，参与拟合 ${(arbitration.chosen.fit.rmsFit * 1000).toFixed(3)} mm`,
  });
  if (!holdoutOk) reasons.push('留出点残差显著高于参与拟合的残差，疑似过拟合。');

  let state: ReadinessState;
  if (validation.rejected.length > 0 && !input.resolvedLabelIssues) state = 'blocked-labels';
  else if (!hypothesisOk) state = 'blocked-unresolved-hypothesis';
  else if (pending) state = 'blocked-missing-repeat';
  else if (!templateOk) state = 'blocked-template-failure';
  else if (!diagOk || !holdoutOk) state = 'blocked-diagnostic';
  else state = 'ready-for-review';

  return {
    state,
    reasons,
    canExportMachinable: state === 'ready-for-review',
    pendingRegion: pending,
    checks,
  };
}

export function describeHypothesis(kind: HypothesisKind): string {
  switch (kind) {
    case 'design-crease':
      return '设计折线';
    case 'instrument-drift':
      return '仪器漂移';
    case 'both':
      return '两者兼有';
    default:
      return '未决';
  }
}

/** Build an editable surface export. This is always allowed: an editable control
 *  lattice is a work product, not a manufacturing release. Machinability is a
 *  separate flag on the readiness report. */
export function buildExport(
  lat: ControlLattice,
  readiness: ReadinessReport,
  rms: number,
  blend: number,
  maxCurvature: number,
  nu = 33,
  nv = 33,
): SurfaceExport {
  const grid = sampleSurface(lat, nu, nv);
  return {
    lattice: {
      countU: lat.countU,
      countV: lat.countV,
      degreeU: lat.degreeU,
      degreeV: lat.degreeV,
      knotsU: Array.from(lat.knotsU),
      knotsV: Array.from(lat.knotsV),
      points: lat.points.map((p) => [...p] as Vec3),
      uMin: lat.uMin,
      uMax: lat.uMax,
      vMin: lat.vMin,
      vMax: lat.vMax,
    },
    samples: { nu, nv, points: grid.points, normals: grid.normals },
    metadata: {
      rms,
      controlPointCount: lat.countU * lat.countV,
      maxCurvature,
      blend,
      status: readiness.state,
      generatedAt: new Date().toISOString(),
      pendingRegion: readiness.pendingRegion,
    },
  };
}

/** Convert the editable export to a glTF-compatible JSON-ish mesh payload for the
 *  viewer; kept separate so the export file itself stays tool-agnostic. */
export function exportToObj(exp: SurfaceExport): string {
  const lines: string[] = ['# inspection-surface-workbench editable export', `# status: ${exp.metadata.status}`];
  for (const p of exp.samples.points) lines.push(`v ${p[0].toFixed(9)} ${p[1].toFixed(9)} ${p[2].toFixed(9)}`);
  for (const n of exp.samples.normals) lines.push(`vn ${n[0].toFixed(9)} ${n[1].toFixed(9)} ${n[2].toFixed(9)}`);
  const nu = exp.samples.nu;
  const nv = exp.samples.nv;
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j + 1;
      const b = (i + 1) * nv + j + 1;
      const c = (i + 1) * nv + j + 2;
      const d = i * nv + j + 2;
      lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
      lines.push(`f ${a}//${a} ${c}//${c} ${d}//${d}`);
    }
  }
  if (exp.metadata.pendingRegion) {
    const p = exp.metadata.pendingRegion;
    lines.push(`# pending region v in [${p.vRange[0]}, ${p.vRange[1]}]: ${p.reason}`);
  }
  return lines.join('\n') + '\n';
}

export interface LocalResidualProbe {
  u: number;
  v: number;
  point: Vec3;
  normal: Vec3;
  nearestObservations: { id: string; distance: number; signed: number; weight: number }[];
}

/** Pick the nearest observations to a clicked parameter location so the user can
 *  inspect local residuals in the UI. */
export function probeLocalResiduals(
  fit: FitResult,
  u: number,
  v: number,
  count = 6,
): LocalResidualProbe {
  const e = evaluateSurface(fit.lattice, u, v);
  const scored = fit.residuals.map((r) => ({
    id: r.id,
    d2: (r.u - u) ** 2 + (r.v - v) ** 2,
    distance: r.distance,
    signed: r.normalResidual,
    weight: r.weight,
  }));
  scored.sort((a, b) => a.d2 - b.d2);
  return {
    u,
    v,
    point: e.point,
    normal: e.normal,
    nearestObservations: scored.slice(0, count).map((s) => ({ id: s.id, distance: s.distance, signed: s.signed, weight: s.weight })),
  };
}
