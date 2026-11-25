import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultGeometry, fitSurface, applyCrease } from '../src/core/fit.js';
import { evaluateSurface, curvatureStats } from '../src/core/surface.js';
import { uniformInterior } from '../src/core/bspline.js';
import type { ControlLattice, FitRequest, FitResult, Observation, SurfaceGeometryConfig, Vec3 } from '../src/core/types.js';
import { NOMINAL_TRUTH, cloneTruth, wingNormal, wingPoint } from '../src/scenarios/wingtipGeometry.js';
import type { WingtipTruth } from '../src/scenarios/wingtipGeometry.js';
import { gaussian, mulberry32 } from '../src/scenarios/scenarios.js';
import { pickHoldout } from '../src/core/arbitration.js';

/**
 * Validation study (验证研究)
 *
 * A known analytic surface is sampled, a controlled perturbation is injected in a
 * declared region, and the fit is judged against the truth — including in regions
 * that were never sampled. This is what separates "the surface passes through the
 * points" from "the surface approximates the specimen".
 *
 * Reported for every case:
 *   - position residual  (sampled points, unsampled strip, whole patch)
 *   - normal error       (mean and max angular error)
 *   - unsampled-region change (max deviation of the surface in a held-out strip)
 *   - complexity (control points, free unknowns) and shape cost (curvature, blend)
 */

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../data/validation');

interface StudyGrid {
  nu: number;
  nv: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

const GRID: StudyGrid = { nu: 17, nv: 15, uMin: 0.03, uMax: 0.97, vMin: 0.04, vMax: 0.96 };
/** Scoring box: strictly inside the sampled grid. The analytic thickness shape
 *  has an infinite chordwise derivative at u→0 (a sqrt-like leading edge), so
 *  scoring there measures the analytic singularity, not the fit. */
const SCORE_BOX = { uMin: 0.10, uMax: 0.90, vMin: 0.07, vMax: 0.93 };
/** A contiguous spanwise strip that is never sampled, used to measure how the fit
 *  behaves where it has no data. */
const UNSAMPLED = { vMin: 0.40, vMax: 0.48 };

interface Perturbation {
  kind: 'none' | 'noise' | 'spike' | 'step' | 'bump';
  /** location / magnitude description for the report */
  description: string;
  apply?: (u: number, v: number, z: number) => number;
}

interface StudyOptions {
  truth: WingtipTruth;
  perturbation: Perturbation;
  /** deterministic noise, total 3D sigma in metres */
  sigma: number;
  seed: number;
  geometry: SurfaceGeometryConfig;
  crease: { axis: 'u' | 'v'; at: number } | null;
  robust: 'none' | 'tukey' | 'huber';
  /** corridor around the perturbed region excluded from the scored sample set */
  excludeBand?: { vMin: number; vMax: number };
}

function geometryBase(countU: number, countV: number, overrides: Partial<SurfaceGeometryConfig> = {}): SurfaceGeometryConfig {
  return defaultGeometry({
    degreeU: 3,
    degreeV: 3,
    countU,
    countV,
    interiorU: uniformInterior(countU, 3),
    interiorV: uniformInterior(countV, 3),
    tensionWeightU: 0.015,
    tensionWeightV: 0.015,
    blendWeightU: 0.004,
    blendWeightV: 0.004,
    priorWeight: 0.0008,
    robustCutoff: 3.2,
    robustIterations: 8,
    ...overrides,
  });
}

function sampleObservations(options: StudyOptions): { observations: Observation[]; unsampled: Observation[] } {
  const rng = mulberry32(options.seed);
  const s3 = options.sigma / Math.sqrt(3);
  const observations: Observation[] = [];
  const unsampled: Observation[] = [];
  // dense truth grid for scoring, with a contiguous unsampled strip removed from the fit
  for (let j = 0; j < GRID.nv; j++) {
    const v = GRID.vMin + ((GRID.vMax - GRID.vMin) * j) / (GRID.nv - 1);
    for (let i = 0; i < GRID.nu; i++) {
      const u = GRID.uMin + ((GRID.uMax - GRID.uMin) * i) / (GRID.nu - 1);
      const truthP = wingPoint(u, v, 1, options.truth);
      const perturbed: Vec3 = [truthP[0], truthP[1], options.perturbation.apply ? options.perturbation.apply(u, v, truthP[2]) : truthP[2]];
      const measured: Vec3 = [perturbed[0] + s3 * gaussian(rng), perturbed[1] + s3 * gaussian(rng), perturbed[2] + s3 * gaussian(rng)];
      const jitter = 0.004;
      const baseN = wingNormal(u, v, 1, options.truth);
      const normal: Vec3 = [baseN[0] + jitter * gaussian(rng), baseN[1] + jitter * gaussian(rng), baseN[2] + jitter * gaussian(rng)];
      const o: Observation = { id: `S-${i}-${j}`, u, v, point: measured, normal, probeId: 'probe-A', passId: 'first' };
      if (v >= UNSAMPLED.vMin && v <= UNSAMPLED.vMax) unsampled.push({ ...o, point: truthP, id: `U-${i}-${j}`, normal: baseN });
      else observations.push(o);
    }
  }
  return { observations, unsampled };
}

/** The spanwise row nearest a station, among the sampled rows. */
function nearestRow(station: number): number {
  let best = GRID.vMin;
  let bestD = Infinity;
  for (let j = 0; j < GRID.nv; j++) {
    const v = GRID.vMin + ((GRID.vMax - GRID.vMin) * j) / (GRID.nv - 1);
    const d = Math.abs(v - station);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

interface ScoreSet {
  count: number;
  rmsPosition: number;
  maxPosition: number;
  meanNormalAngleDeg: number;
  maxNormalAngleDeg: number;
}

function score(lat: ControlLattice, points: { u: number; v: number; point: Vec3; normal?: Vec3 }[], truth: WingtipTruth, excludeBand?: { vMin: number; vMax: number }): ScoreSet {
  let sq = 0;
  let maxP = 0;
  let n = 0;
  let sumAngle = 0;
  let maxAngle = 0;
  for (const p of points) {
    if (excludeBand && p.v >= excludeBand.vMin && p.v <= excludeBand.vMax) continue;
    const truthP = wingPoint(p.u, p.v, 1, truth);
    const e = evaluateSurface(lat, p.u, p.v);
    const d = Math.hypot(e.point[0] - truthP[0], e.point[1] - truthP[1], e.point[2] - truthP[2]);
    sq += d * d;
    maxP = Math.max(maxP, d);
    n++;
    const truthN = wingNormal(p.u, p.v, 1, truth);
    const dotN = e.normal[0] * truthN[0] + e.normal[1] * truthN[1] + e.normal[2] * truthN[2];
    // normals are compared by direction, sign-unified
    const angle = (Math.acos(Math.min(1, Math.abs(dotN))) * 180) / Math.PI;
    sumAngle += angle;
    maxAngle = Math.max(maxAngle, angle);
  }
  return {
    count: n,
    rmsPosition: n ? Math.sqrt(sq / n) : 0,
    maxPosition: maxP,
    meanNormalAngleDeg: n ? sumAngle / n : 0,
    maxNormalAngleDeg: maxAngle,
  };
}

/** Change of the surface inside the unsampled strip relative to the truth, sampled
 *  on a fine grid — the "未采样区域的变化" the study must quantify. */
function unsampledChange(lat: ControlLattice, truth: WingtipTruth): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let k = 0; k <= 16; k++) {
    const v = UNSAMPLED.vMin + ((UNSAMPLED.vMax - UNSAMPLED.vMin) * k) / 16;
    for (let m = 0; m <= 16; m++) {
      const u = SCORE_BOX.uMin + ((SCORE_BOX.uMax - SCORE_BOX.uMin) * m) / 16;
      const e = evaluateSurface(lat, u, v);
      const t = wingPoint(u, v, 1, truth);
      const d = Math.hypot(e.point[0] - t[0], e.point[1] - t[1], e.point[2] - t[2]);
      max = Math.max(max, d);
      sum += d;
      n++;
    }
  }
  return { max, mean: n ? sum / n : 0 };
}

function fitCase(options: StudyOptions): { fit: FitResult; gridScore: ScoreSet; unsampledScore: ScoreSet; change: { max: number; mean: number } } {
  let geometry = options.geometry;
  if (options.crease) {
    const applied = applyCrease(geometry, { enabled: true, direction: options.crease.axis, at: options.crease.at, hard: true });
    geometry = applied.geometry;
  }
  const { observations, unsampled } = sampleObservations(options);
  const holdout = pickHoldout(observations);
  const request: FitRequest = {
    observations,
    settings: {
      geometry,
      minWeight: 1e-6,
      useNormals: true,
      normalWeight: 0.35,
      crease: null,
      robust: options.robust,
      offsetProbeWeight: 0.12,
      controlPointBoost: { u: 0, v: 0 },
    },
    holdoutIds: holdout,
  };
  const fit = fitSurface(request);
  // score the fitted surface against the analytic truth at the sampled locations
  // and at an independent dense grid, excluding the perturbation corridor where the
  // data itself is not the truth
  const gridPts: { u: number; v: number; point: Vec3 }[] = [];
  for (let i = 0; i <= 40; i++) {
    const u = SCORE_BOX.uMin + ((SCORE_BOX.uMax - SCORE_BOX.uMin) * i) / 40;
    for (let j = 0; j <= 32; j++) {
      const v = SCORE_BOX.vMin + ((SCORE_BOX.vMax - SCORE_BOX.vMin) * j) / 32;
      gridPts.push({ u, v, point: [0, 0, 0] });
    }
  }
  const gridScore = score(fit.lattice, gridPts, options.truth, options.excludeBand);
  const unsampledScore = score(fit.lattice, unsampled, options.truth);
  return { fit, gridScore, unsampledScore, change: unsampledChange(fit.lattice, options.truth) };
}

interface StudyRow {
  label: string;
  controlPoints: number;
  freeUnknowns: number;
  dataPerUnknown: number;
  rmsSampled: number;
  maxSampled: number;
  unsampledRms: number;
  unsampledMax: number;
  changeMax: number;
  changeMean: number;
  meanNormalDeg: number;
  maxNormalDeg: number;
  maxCurvature: number;
  blend: number;
  curvatureMem: number;
  rmsHoldout: number;
}

function row(label: string, r: ReturnType<typeof fitCase>, options: StudyOptions): StudyRow {
  const diag = r.fit.diagnostics;
  const cs = curvatureStats(r.fit.lattice, 40, 40);
  return {
    label,
    controlPoints: r.fit.lattice.countU * r.fit.lattice.countV,
    freeUnknowns: r.fit.lattice.countU * r.fit.lattice.countV * 3,
    dataPerUnknown: diag.dataPerUnknown,
    rmsSampled: r.gridScore.rmsPosition,
    maxSampled: r.gridScore.maxPosition,
    unsampledRms: r.unsampledScore.rmsPosition,
    unsampledMax: r.unsampledScore.maxPosition,
    changeMax: r.change.max,
    changeMean: r.change.mean,
    meanNormalDeg: r.gridScore.meanNormalAngleDeg,
    maxNormalDeg: r.gridScore.maxNormalAngleDeg,
    maxCurvature: cs.maxAbs,
    blend: r.fit.fairness.blend,
    curvatureMem: cs.meanAbs,
    rmsHoldout: r.fit.rmsHoldout,
  };
  void options;
}

const mm = (x: number): string => (x * 1000).toFixed(3);
const deg = (x: number): string => x.toFixed(3);

function printTable(title: string, rows: StudyRow[]): void {
  console.log('\n' + title);
  const header = ['方案', '控制点', '数据/未知', '采样RMS', '采样MAX', '未采RMS', '未采MAX', '未采区变化MAX', '法向°(均/最大)', '曲率MAX', 'blend', '留出RMS'];
  console.log(header.join(' | '));
  for (const r of rows) {
    console.log(
      [
        r.label,
        String(r.controlPoints),
        r.dataPerUnknown.toFixed(2),
        mm(r.rmsSampled),
        mm(r.maxSampled),
        mm(r.unsampledRms),
        mm(r.unsampledMax),
        mm(r.changeMax),
        deg(r.meanNormalDeg) + '/' + deg(r.maxNormalDeg),
        r.maxCurvature.toFixed(2),
        r.blend.toFixed(5),
        mm(r.rmsHoldout),
      ].join(' | '),
    );
  }
}

interface JsonReport {
  generatedAt: string;
  grid: StudyGrid;
  unsampledStrip: { vMin: number; vMax: number };
  cases: Record<string, { rows: StudyRow[]; note: string }>;
}

const report: JsonReport = {
  generatedAt: new Date().toISOString(),
  grid: GRID,
  unsampledStrip: UNSAMPLED,
  cases: {},
};

// ---------------------------------------------------------------------------
// Case 1 — clean surface: representation error and noise floor
// ---------------------------------------------------------------------------
{
  const rows: StudyRow[] = [];
  for (const [cu, cv] of [
    [8, 9],
    [9, 11],
    [10, 11],
  ]) {
    const options: StudyOptions = {
      truth: cloneTruth(NOMINAL_TRUTH),
      perturbation: { kind: 'noise', description: '无扰动，仅有测量噪声' },
      sigma: 0.00035,
      seed: 11,
      geometry: geometryBase(cu, cv),
      crease: null,
      robust: 'huber',
    };
    rows.push(row(`${cu}×${cv}`, fitCase(options), options));
  }
  report.cases.clean = {
    note: '已知解析翼尖曲面 + 0.35 mm 各向同性噪声，无结构扰动。控制点增加时采样/未采样残差与曲率一并给出，作为复杂度基线。',
    rows,
  };
  printTable('案例 1 · 清洁曲面（已知真值 + 噪声）', rows);
}

// ---------------------------------------------------------------------------
// Case 2 — single-row spike: control points vs robust weights (overfit evidence)
// ---------------------------------------------------------------------------
{
  const spikeV = nearestRow(0.62);
  const spike: Perturbation = {
    kind: 'spike',
    description: `v=${spikeV.toFixed(3)} 整排沿法向抬高 0.8 mm（仪器漂移或设计折线待判）`,
    apply: (_u, v, z) => (Math.abs(v - spikeV) < 1e-6 ? z + 0.0008 : z),
  };
  const rows: StudyRow[] = [];
  const configs: [string, number, number, 'none' | 'tukey' | 'huber'][] = [
    ['基准 8×9 + Huber 降权', 8, 9, 'huber'],
    ['加控制点 10×11（无降权）', 10, 11, 'none'],
    ['加控制点 12×13（无降权）', 12, 13, 'none'],
    ['加控制点 14×16（无降权）', 14, 16, 'none'],
  ];
  for (const [label, cu, cv, robust] of configs) {
    const options: StudyOptions = {
      truth: cloneTruth(NOMINAL_TRUTH),
      perturbation: spike,
      sigma: 0.00035,
      seed: 22,
      geometry: geometryBase(cu, cv),
      crease: null,
      robust,
      // the injected row is not truth; exclude it from the shape-error score
      excludeBand: { vMin: spikeV - 0.02, vMax: spikeV + 0.02 },
    };
    rows.push(row(label, fitCase(options), options));
  }
  report.cases.singleRow = {
    note: '在 v=0.62 注入 0.8 mm 单排抬高（非真值）。比较增设控制点与稳健降权：加控制点会以采样残差换取未采样条带与曲率代价。',
    rows,
  };
  printTable('案例 2 · 单排抬高：加控制点 vs 降权（过拟合检验）', rows);
}

// ---------------------------------------------------------------------------
// Case 3 — real design fold: crease must be preserved, not smoothed
// ---------------------------------------------------------------------------
{
  const foldV = 0.62;
  const truth = cloneTruth(NOMINAL_TRUTH);
  truth.folds = [{ at: foldV, angle: (2.8 * Math.PI) / 180 }];
  const rows: StudyRow[] = [];
  const configs: [string, SurfaceGeometryConfig, { axis: 'u' | 'v'; at: number } | null, 'none' | 'tukey' | 'huber'][] = [
    ['平滑 8×9', geometryBase(8, 9), null, 'huber'],
    ['折线 8×9 C0@0.62', geometryBase(8, 9), { axis: 'v', at: foldV }, 'none'],
    ['折线 10×11 C0@0.62', geometryBase(10, 11), { axis: 'v', at: foldV }, 'none'],
  ];
  for (const [label, geometry, crease, robust] of configs) {
    const options: StudyOptions = {
      truth,
      perturbation: { kind: 'none', description: '真值含设计折线' },
      sigma: 0.00035,
      seed: 33,
      geometry,
      crease,
      robust,
    };
    rows.push(row(label, fitCase(options), options));
  }
  report.cases.fold = {
    note: '真值本身在该站位含 2.8° 设计折线。平滑曲面在前缘附近误差被放大；折线模型（相同控制点数，仅展向节点重数不同）恢复真值。',
    rows,
  };
  printTable('案例 3 · 设计折线：保留 vs 平滑', rows);
}

// ---------------------------------------------------------------------------
// Case 4 — perturbed bump in a sampled region: noise vs sharp-edge prior
// ---------------------------------------------------------------------------
{
  const bumpU = 0.5;
  const bumpV = 0.62;
  const bump: Perturbation = {
    kind: 'bump',
    description: '局部法向凸起 0.6 mm，半径 0.08（参数域）',
    apply: (u, v, z) => {
      const r = Math.hypot(u - bumpU, v - bumpV);
      return r < 0.08 ? z + 0.0006 * Math.cos((r / 0.08) * (Math.PI / 2)) ** 2 : z;
    },
  };
  const rows: StudyRow[] = [];
  const configs: [string, number, number, 'none' | 'tukey' | 'huber'][] = [
    ['基准 8×9 + Huber 降权', 8, 9, 'huber'],
    ['加控制点 11×13（无降权）', 11, 13, 'none'],
    ['加控制点 13×15（无降权）', 13, 15, 'none'],
  ];
  for (const [label, cu, cv, robust] of configs) {
    const options: StudyOptions = {
      truth: cloneTruth(NOMINAL_TRUTH),
      perturbation: bump,
      sigma: 0.00035,
      seed: 44,
      geometry: geometryBase(cu, cv),
      crease: null,
      robust,
      excludeBand: { vMin: bumpV - 0.08, vMax: bumpV + 0.08 },
    };
    rows.push(row(label, fitCase(options), options));
  }
  report.cases.bump = {
    note: '在已采样区域注入局部 0.6 mm 凸起（非真值）。加控制点可穿过它，但未采样条带误差与曲率同时上升；稳健降权保持形态。',
    rows,
  };
  printTable('案例 4 · 局部凸起：噪声 vs 锐边先验', rows);
}

// ---------------------------------------------------------------------------
// Persist JSON next to the data directory
// ---------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const outPath = resolve(OUT, 'study.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('\n验证研究结果已写入 ' + outPath);
