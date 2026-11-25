import type { Observation, TemplatePoint, Vec3 } from '../core/types.js';
import type { RepeatMode } from '../core/arbitration.js';
import { NOMINAL_TRUTH, cloneTruth, wingNormal, wingPoint } from './wingtipGeometry.js';
import type { WingtipTruth } from './wingtipGeometry.js';
import type { MeasurementFile, MeasurementRecord } from './measurementFile.js';

/** Deterministic PRNG so every scenario and study is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface ScanGrid {
  nu: number;
  nv: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface ProbePlan {
  probeId: string;
  side: string;
  passId: string;
  /** 'fit' observations enter the fit; 'repeat-evidence' observations only
   *  corroborate or deny a deviation and are never fit */
  role: 'fit' | 'repeat-evidence';
  grid: ScanGrid;
  /** global zero offset along z applied to every record, metres */
  offsetZ?: number;
  /** localized row artefact along the local normal, metres */
  localArtifact?: { row: number; magnitude: number };
}

export interface ScenarioSpec {
  id: string;
  title: string;
  description: string;
  /** the design truth; the virtual template is built from this */
  truth: WingtipTruth;
  noise: { sigma: number; normalJitter: number; dropLabelProbability?: number; duplicateLabelProbability?: number };
  probes: ProbePlan[];
  template: { u: number[]; v: number[]; tolerance: number };
  seed: number;
  expected: {
    hypothesis: 'instrument-drift' | 'design-crease' | 'unresolved';
    /** a pending region must be reported and machinable export blocked */
    pendingRegion: boolean;
    /** display label that the study and UI assert */
    outcome: string;
  };
}

const FULL: ScanGrid = { nu: 17, nv: 15, uMin: 0.03, uMax: 0.97, vMin: 0.04, vMax: 0.96 };
const DENSE: ScanGrid = { nu: 16, nv: 14, uMin: 0.035, uMax: 0.965, vMin: 0.045, vMax: 0.955 };
const LOWER_FULL: ScanGrid = { nu: 15, nv: 13, uMin: 0.03, uMax: 0.97, vMin: 0.04, vMax: 0.96 };
const LOWER_UPTO_HALF: ScanGrid = { nu: 15, nv: 9, uMin: 0.03, uMax: 0.97, vMin: 0.04, vMax: 0.5 };

function withFold(angleDeg: number, at = 0.62): WingtipTruth {
  const t = cloneTruth(NOMINAL_TRUTH);
  t.folds = [{ at, angle: (angleDeg * Math.PI) / 180 }];
  return t;
}

/** S1 — one displaced row, no repeat. Cannot be arbitrated. */
export const S1_DRIFT_NO_REPEAT: ScenarioSpec = {
  id: 'S1-drift-no-repeat',
  title: '单排偏离点 · 缺复测',
  description:
    '上表面第 9 排测点沿法向抬高 0.8 mm，其余测点正常。参数标签齐全。另一侧没有复测剖面，无法判断这是单探头漂移还是设计折线。',
  truth: cloneTruth(NOMINAL_TRUTH),
  noise: { sigma: 0.00035, normalJitter: 0.004 },
  probes: [
    { probeId: 'probe-A', side: 'upper', passId: 'first', role: 'fit', grid: FULL, localArtifact: { row: 8, magnitude: 0.0008 } },
  ],
  template: { u: [0.1, 0.3, 0.5, 0.7, 0.9], v: [0.12, 0.3, 0.45, 0.6, 0.78, 0.94], tolerance: 0.0011 },
  seed: 1001,
  expected: { hypothesis: 'unresolved', pendingRegion: true, outcome: '待确认：缺复测，不得输出可加工面' },
};

/** S2 — both the upper probe and the opposite-side repeat see a real fold.
 *  The design truth contains the fold, so the virtual template contains it too;
 *  only the crease-capable surface passes the template. */
export const S2_POLYLINE_TWO_PROBES: ScenarioSpec = {
  id: 'S2-polyline-two-probes',
  title: '双探头同证折线',
  description:
    '上表面探头在同一展向站位测到折角，另一侧复测剖面在同站位出现镜像折角。两个探头一致，判定为设计折线；折线必须在模型中保留才能通过样板。',
  truth: withFold(2.8, 0.62),
  noise: { sigma: 0.00035, normalJitter: 0.004 },
  probes: [
    { probeId: 'probe-A', side: 'upper', passId: 'first', role: 'fit', grid: FULL },
    { probeId: 'probe-B', side: 'lower', passId: 'repeat', role: 'repeat-evidence', grid: LOWER_FULL },
  ],
  template: {
    u: [0.1, 0.3, 0.5, 0.7, 0.9],
    v: [0.12, 0.3, 0.45, 0.55, 0.62, 0.7, 0.78, 0.94],
    tolerance: 0.0007,
  },
  seed: 2002,
  expected: { hypothesis: 'design-crease', pendingRegion: false, outcome: '折线：两探头一致，保留折线过样板' },
};

/** S3 — two probes scan the same side; probe B has a global zero offset.
 *  A coherent offset across every row of one group lowers that group's weight. */
export const S3_ONE_PROBE_OFFSET: ScenarioSpec = {
  id: 'S3-one-probe-offset',
  title: '单探头整体偏移',
  description:
    '两个探头都在上表面测量，探头 B 的所有记录整体偏移 0.5 mm，探头 A 正常。复测分组存在系统性单向偏移，是仪器零点漂移的典型特征，应降低 B 组权重而不是删除它。',
  truth: cloneTruth(NOMINAL_TRUTH),
  noise: { sigma: 0.00035, normalJitter: 0.004 },
  probes: [
    { probeId: 'probe-A', side: 'upper', passId: 'first', role: 'fit', grid: FULL },
    { probeId: 'probe-B', side: 'upper', passId: 'repeat', role: 'fit', grid: DENSE, offsetZ: 0.0005 },
  ],
  template: { u: [0.1, 0.3, 0.5, 0.7, 0.9], v: [0.12, 0.3, 0.45, 0.6, 0.78, 0.94], tolerance: 0.0011 },
  seed: 3003,
  expected: { hypothesis: 'instrument-drift', pendingRegion: false, outcome: '漂移：降低 B 组整体权重' },
};

/** S4 — clean surface with dirty labels. Labels are reported, never repaired. */
export const S4_CLEAN_LABEL_ERRORS: ScenarioSpec = {
  id: 'S4-clean-label-errors',
  title: '清洁曲面 · 标签缺陷',
  description:
    '规则曲面，两个探头数据一致，但文件中混入约 2% 缺失参数标签与 2% 重复标签。工具必须报告并隔离这些记录，不能补齐或任意去重。',
  truth: cloneTruth(NOMINAL_TRUTH),
  noise: { sigma: 0.00035, normalJitter: 0.004, dropLabelProbability: 0.02, duplicateLabelProbability: 0.02 },
  probes: [
    { probeId: 'probe-A', side: 'upper', passId: 'first', role: 'fit', grid: FULL },
    { probeId: 'probe-B', side: 'upper', passId: 'repeat', role: 'fit', grid: DENSE },
  ],
  template: { u: [0.15, 0.35, 0.55, 0.75, 0.9], v: [0.12, 0.32, 0.5, 0.7, 0.9], tolerance: 0.0012 },
  seed: 4004,
  expected: { hypothesis: 'unresolved', pendingRegion: false, outcome: '标签缺陷被隔离，接受点可拟合' },
};

/** S5 — repeat exists but does not cover the deviation band, so the question is
 *  still open. A pending region must survive. */
export const S5_REPEAT_MISSES_BAND: ScenarioSpec = {
  id: 'S5-repeat-misses-band',
  title: '复测未覆盖偏离带',
  description:
    '上表面第 9 排测点抬高 0.8 mm；对侧复测只扫到 v≤0.5，没有覆盖偏离所在的展向站位。复测存在但不足以证认或排除，工作台必须保留待确认区。',
  truth: cloneTruth(NOMINAL_TRUTH),
  noise: { sigma: 0.00035, normalJitter: 0.004 },
  probes: [
    { probeId: 'probe-A', side: 'upper', passId: 'first', role: 'fit', grid: FULL, localArtifact: { row: 8, magnitude: 0.0008 } },
    { probeId: 'probe-B', side: 'lower', passId: 'repeat', role: 'repeat-evidence', grid: LOWER_UPTO_HALF },
  ],
  template: { u: [0.1, 0.3, 0.5, 0.7, 0.9], v: [0.12, 0.3, 0.45, 0.6, 0.78, 0.94], tolerance: 0.0011 },
  seed: 5005,
  expected: { hypothesis: 'unresolved', pendingRegion: true, outcome: '待确认：复测未覆盖偏离带' },
};

/** S6 — repeat covers the band and denies it. The local deviation is a probe
 *  artefact, handled by robust down-weighting of the band. */
export const S6_REPEAT_DENIES: ScenarioSpec = {
  id: 'S6-repeat-denies',
  title: '复测否定单侧偏离',
  description:
    '上表面第 9 排抬高，另一侧完整复测在同一站位没有折角。复测否定了折线，按单侧局部漂移处理，以稳健权重压低该带，观测不删除。',
  truth: cloneTruth(NOMINAL_TRUTH),
  noise: { sigma: 0.00035, normalJitter: 0.004 },
  probes: [
    { probeId: 'probe-A', side: 'upper', passId: 'first', role: 'fit', grid: FULL, localArtifact: { row: 8, magnitude: 0.0008 } },
    { probeId: 'probe-B', side: 'lower', passId: 'repeat', role: 'repeat-evidence', grid: LOWER_FULL },
  ],
  template: { u: [0.1, 0.3, 0.5, 0.7, 0.9], v: [0.12, 0.3, 0.45, 0.6, 0.78, 0.94], tolerance: 0.0011 },
  seed: 6006,
  expected: { hypothesis: 'instrument-drift', pendingRegion: true, outcome: '漂移：复测否定折线，局部降权并保留待确认区' },
};

export const SCENARIOS: ScenarioSpec[] = [
  S1_DRIFT_NO_REPEAT,
  S2_POLYLINE_TWO_PROBES,
  S3_ONE_PROBE_OFFSET,
  S4_CLEAN_LABEL_ERRORS,
  S5_REPEAT_MISSES_BAND,
  S6_REPEAT_DENIES,
];

export function scenarioById(id: string): ScenarioSpec | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Measurement file generation
// ---------------------------------------------------------------------------

export interface ScenarioBundle {
  spec: ScenarioSpec;
  file: MeasurementFile;
  /** the intended repeat evidence mode */
  repeatMode: RepeatMode;
  repeatSide: string;
  testSide: string;
  template: TemplatePoint[];
  /** truth samples on the test side, for error studies */
  truthSamples: { u: number; v: number; side: string; point: Vec3 }[];
  /** records deliberately given a bad label, for tests */
  dirtyLabelRecords: number[];
}

function label(probeId: string, passId: string, side: string, i: number, j: number): string {
  return `${side.slice(0, 1).toUpperCase()}-${probeId}-${passId}-${String(i).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
}

export function generateScenario(spec: ScenarioSpec): ScenarioBundle {
  const rng = mulberry32(spec.seed);
  const records: MeasurementRecord[] = [];
  const dirtyLabelRecords: number[] = [];
  const repeatSides = new Set(spec.probes.filter((p) => p.role === 'repeat-evidence').map((p) => p.side));
  const testSide = spec.probes.find((p) => p.role === 'fit')?.side ?? 'upper';
  const repeatProbe = spec.probes.find((p) => p.role === 'repeat-evidence');

  for (const probe of spec.probes) {
    const sideSign = probe.side === 'lower' ? -1 : 1;
    for (let j = 0; j < probe.grid.nv; j++) {
      const v = probe.grid.vMin + ((probe.grid.vMax - probe.grid.vMin) * j) / (probe.grid.nv - 1);
      for (let i = 0; i < probe.grid.nu; i++) {
        const u = probe.grid.uMin + ((probe.grid.uMax - probe.grid.uMin) * i) / (probe.grid.nu - 1);
        const truthPoint = wingPoint(u, v, sideSign, spec.truth);
        const normal = wingNormal(u, v, sideSign, spec.truth);
        // spec.noise.sigma is the total 3D point error; spread it isotropically so
        // the Euclidean distance RMS equals sigma rather than sqrt(3)*sigma.
        const s3 = spec.noise.sigma / Math.sqrt(3);
        let p: Vec3 = [
          truthPoint[0] + s3 * gaussian(rng),
          truthPoint[1] + s3 * gaussian(rng),
          truthPoint[2] + s3 * gaussian(rng),
        ];
        if (probe.offsetZ) p = [p[0], p[1], p[2] + probe.offsetZ];
        if (probe.localArtifact && j === probe.localArtifact.row) {
          const m = probe.localArtifact.magnitude;
          p = [p[0] + normal[0] * m, p[1] + normal[1] * m, p[2] + normal[2] * m];
        }
        const jitter = spec.noise.normalJitter;
        const n: Vec3 = [
          normal[0] + jitter * gaussian(rng),
          normal[1] + jitter * gaussian(rng),
          normal[2] + jitter * gaussian(rng),
        ];
        let params: [number, number] | null = [u, v];
        if (spec.noise.dropLabelProbability && rng() < spec.noise.dropLabelProbability) {
          params = null;
          dirtyLabelRecords.push(records.length);
        }
        records.push({
          label: label(probe.probeId, probe.passId, probe.side, i, j),
          params,
          point: p,
          normal: n,
          probeId: probe.probeId,
          passId: probe.passId,
          side: probe.side,
        });
      }
    }
  }

  if (spec.noise.duplicateLabelProbability) {
    for (let k = 1; k < records.length; k++) {
      if (rng() < spec.noise.duplicateLabelProbability && records[k].params) {
        // copy both parameter labels from an earlier record on the same probe
        let donor = k - 1;
        while (donor >= 0 && records[donor].probeId !== records[k].probeId) donor--;
        if (donor >= 0 && records[donor].params) {
          records[k].params = [records[donor].params![0], records[donor].params![1]];
          dirtyLabelRecords.push(k);
        }
      }
    }
  }

  const template: TemplatePoint[] = [];
  for (const u of spec.template.u) {
    for (const v of spec.template.v) {
      template.push({
        u,
        v,
        point: wingPoint(u, v, 1, spec.truth),
        tolerance: spec.template.tolerance,
        side: 'upper',
      });
    }
  }

  const truthSamples: ScenarioBundle['truthSamples'] = [];
  for (let i = 0; i <= 24; i++) {
    for (let j = 0; j <= 20; j++) {
      const u = i / 24;
      const v = j / 20;
      truthSamples.push({ u, v, side: testSide, point: wingPoint(u, v, testSide === 'lower' ? -1 : 1, spec.truth) });
    }
  }

  const file: MeasurementFile = {
    id: spec.id,
    description: spec.title,
    records,
    metadata: {
      specimen: 'WT-07',
      createdAt: '2026-11-24T08:00:00Z',
      unit: 'm',
      uMeaning: '归一化弦向 (0=前缘, 1=后缘)',
      vMeaning: '归一化展向 (0=根部站位, 1=翼尖站位)',
      uRange: [0, 1],
      vRange: [0, 1],
      operator: 'cell-02',
    },
  };

  return {
    spec,
    file,
    repeatMode: repeatProbe ? (repeatProbe.side === testSide ? 'same-side' : 'opposite-side') : 'none',
    repeatSide: repeatProbe?.side ?? '',
    testSide,
    template,
    truthSamples,
    dirtyLabelRecords,
  };
}

/** Map verified records to observations for one role. Records whose labels failed
 *  validation never reach this function. `side` is copied onto the observation so
 *  probe statistics can separate the surfaces. */
export function recordsToObservations(
  file: MeasurementFile,
  acceptedIndices: number[],
  role: 'fit' | 'repeat-evidence',
  probes: ProbePlan[],
): Observation[] {
  const roleOf = new Map(probes.map((p) => [p.probeId, p.role]));
  const out: Observation[] = [];
  for (const index of acceptedIndices) {
    const r = file.records[index];
    if (!r.params || !r.point) continue;
    if (roleOf.get(r.probeId) !== role) continue;
    out.push({
      id: r.label,
      u: r.params[0],
      v: r.params[1],
      point: r.point,
      normal: r.normal ?? undefined,
      probeId: r.probeId,
      passId: r.passId,
      side: r.side,
    });
  }
  return out;
}

/** Identify probe ids by role. */
export function probesByRole(spec: ScenarioSpec, role: 'fit' | 'repeat-evidence'): string[] {
  return spec.probes.filter((p) => p.role === role).map((p) => p.probeId);
}

export function repeatSides(spec: ScenarioSpec): string[] {
  return [...new Set(spec.probes.filter((p) => p.role === 'repeat-evidence').map((p) => p.side))];
}

export function hasRepeatEvidence(spec: ScenarioSpec): boolean {
  return spec.probes.some((p) => p.role === 'repeat-evidence');
}
