/** Assemble a self-contained fabrication package (曲面测点资料包) and verify it
 *  against its declared conventions.
 *
 *  The package embeds everything the fitter needs (observations + recipe) and
 *  everything verification needs (truth spec + grid + fixture + provenance), but
 *  keeps them in separate fields. `analyse` runs the fitter on the observations
 *  and the assembler on the resulting surface + fixture. */

import { fitFromPackage } from './fitAdapter.js';
import { buildFixture } from './fixture.js';
import { fabricateObservations } from './fabricate.js';
import { analyseReconstruction } from './analysis.js';
import { buildSamplingTables, coarseSpanwiseLadder } from './sampling.js';
import { NOMINAL_TRUTH_SPEC, ridgeBandHalfWidth, sampleTruthGrid, truthPoint } from './truthSurface.js';
import { ridgeBandPointCount } from './sampling.js';
import type {
  ConventionCheck,
  Conventions,
  ConventionsResult,
  FabricationMethod,
  FabricationPackage,
  FitRecipe,
  Provenance,
  ReconstructionAnalysis,
  SamplePlan,
  TruthSpec,
} from './types.js';

export const PACKAGE_SCHEMA_VERSION = '1.0.0';
export const GENERATOR = 'design-observation-fabricator';
export const GENERATOR_VERSION = '1.0.0';

export interface BuildOptions {
  id: string;
  title: string;
  method: FabricationMethod;
  /** which sampling table: 'coarse' (A) or 'refined' (B) */
  table: 'coarse' | 'refined';
  /** calibrated spanwise stations for the section method; ignored for analytic */
  sectionStations?: number[] | null;
  spec?: TruthSpec;
  recipe?: FitRecipe;
  seed?: number;
  tolerance?: number;
  createdAt?: string;
  /** explicit conventions; when omitted a table-derived default is used */
  conventions?: Conventions;
  /** extra provenance notes */
  notes?: string[];
}

export const DEFAULT_RECIPE: FitRecipe = {
  degreeU: 3,
  degreeV: 3,
  countU: 8,
  countV: 9,
  tensionWeight: 0.015,
  blendWeight: 0.004,
  priorWeight: 0.0008,
  robust: 'huber',
  normalWeight: 0.35,
  // The tent apex has a genuine normal discontinuity; noisy measured normals
  // there disagree with any single crease normal and pull the fit off. Position
  // data carries the arris, so the recipe leaves normals out of this fit.
  useNormals: false,
  // a C0 crease at the ridge station lets the surface carry the arris when the
  // apex was measured; without a measured apex the crease has nothing to fold on
  crease: { axis: 'v', at: NOMINAL_TRUTH_SPEC.ridgeV },
};

const DEFAULT_METADATA = {
  specimen: 'WT-07',
  unit: 'm',
  uMeaning: '归一化弦向 (0=前缘, 1=后缘)',
  vMeaning: '归一化展向 (0=根部, 1=翼尖)',
  operator: 'cell-02/design-fab',
};

export function buildPackage(options: BuildOptions): FabricationPackage {
  const spec = options.spec ?? NOMINAL_TRUTH_SPEC;
  const seed = options.seed ?? 7007;
  const noiseSigma = 0.00035;
  const normalJitter = 0.004;
  const tolerance = options.tolerance ?? 0.0009;
  const recipe = options.recipe ?? { ...DEFAULT_RECIPE, crease: { axis: 'v' as const, at: spec.ridgeV } };
  const sectionStations = options.method === 'section' ? (options.sectionStations ?? coarseSectionStations(spec)) : null;

  const tables = buildSamplingTables(spec, noiseSigma, normalJitter, seed);
  const plan: SamplePlan = options.table === 'refined' ? tables.refined : tables.coarse;

  const observations = fabricateObservations(plan, {
    spec,
    method: options.method,
    sectionStations,
    labelConfidence: 0.985,
  });

  const fixture = buildFixture(spec, tolerance);
  const grid = sampleTruthGrid(spec, 81, 81);

  const provenance: Provenance = {
    generator: GENERATOR,
    generatorVersion: GENERATOR_VERSION,
    method: options.method,
    sectionStations,
    samplingTable: plan.id,
    seed,
    noiseSigma,
    normalJitter,
    outlierCount: plan.outlierPlan?.count ?? 0,
    tolerance,
    truthSpecId: spec.id,
    generatedAt: options.createdAt ?? '2026-11-26T00:00:00Z',
    notes: [
      options.method === 'analytic'
        ? '真值由解析曲面逐点求值后采样，尖棱在任意 v 上连续可分辨。'
        : `真值由 ${sectionStations?.length ?? 0} 个标定截面装配后沿展向线性插值，截面间距外的尖棱被插值抹平。`,
      options.table === 'coarse'
        ? '采用采样表 A：展向梯级均匀，尖棱站位的峰顶落在两排之间，未直接测到。'
        : '采用采样表 B：仅在尖棱附近加密展向测排，其余与采样表 A 相同。',
      `注入 ${plan.outlierPlan?.count ?? 0} 个沿法向 ${(((plan.outlierPlan?.magnitude ?? 0) * 1000)).toFixed(2)} mm 的离群点，拟合器不得读取该标注。`,
      ...(options.notes ?? []),
    ],
  };

  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    id: options.id,
    title: options.title,
    createdAt: options.createdAt ?? '2026-11-26T00:00:00Z',
    provenance,
    truth: {
      spec,
      method: options.method,
      sectionStations,
      grid: { nu: 81, nv: 81, points: grid },
    },
    fixture,
    plan,
    observations,
    recipe,
    conventions: options.conventions ?? defaultConventions(options.method, options.table),
    metadata: DEFAULT_METADATA,
  };
}

/** Calibrated sections for the section method: the coarse spanwise ladder,
 *  which brackets the apex v=ridgeV without sampling it. Because the apex falls
 *  between two sections, linear interpolation chops the tent's peak off — the
 *  signature failure of an under-resolved section method. */
export function coarseSectionStations(spec: TruthSpec = NOMINAL_TRUTH_SPEC): number[] {
  return coarseSpanwiseLadder(spec);
}

function defaultConventions(method: FabricationMethod, table: 'coarse' | 'refined'): Conventions {
  const coarse = table === 'coarse';
  return {
    fitRmsMax: 0.0012,
    coverageMin: 0.9,
    matingCoverageMin: coarse ? null : 0.9,
    matingCoverageMax: coarse ? 0.85 : null,
    edgeCoverageMin: coarse ? null : 0.85,
    ridgeBandObservations: coarse ? { max: 60 } : { min: 100 },
    expectLostFeature: coarse,
    expectMaxGapMin: coarse ? 0.0018 : null,
    truthErrorBandMax: coarse ? null : 0.0009,
    expectEdgeAdvice: coarse ? 'add-measurement' : 'none',
    expectMethod: method,
  };
}

/** Fit + verify a package. This is the single entry point used by both the
 *  reconstruction script and the UI. */
export function analysePackage(pkg: FabricationPackage): { analysis: ReconstructionAnalysis; fit: ReturnType<typeof fitFromPackage>; conventions: ConventionsResult } {
  const fit = fitFromPackage(pkg.observations, pkg.recipe);
  const analysis = analyseReconstruction(fit, pkg.observations, pkg.fixture, pkg.truth.spec);
  const conventions = checkConventions(pkg, analysis, fit.rms, fit.rmsHoldout);
  return { analysis, fit, conventions };
}

/** Translate the declared conventions into pass/fail checks. Every check must be
 *  backed by a number the analysis actually computed — nothing is asserted that
 *  was not measured. */
export function checkConventions(
  pkg: FabricationPackage,
  analysis: ReconstructionAnalysis,
  fitRms: number,
  fitRmsHoldout: number,
): ConventionsResult {
  const c = pkg.conventions;
  const checks: ConventionCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });

  add('fit-rms', '拟合残差 RMS 在限值内', fitRms <= c.fitRmsMax, `参与拟合 RMS ${(fitRms * 1000).toFixed(3)} mm ≤ 限值 ${(c.fitRmsMax * 1000).toFixed(3)} mm；留出 ${(fitRmsHoldout * 1000).toFixed(3)} mm`);

  add(
    'coverage',
    '参数域观测覆盖率达标',
    analysis.coverage.occupancy >= c.coverageMin,
    `占用 ${(analysis.coverage.occupancy * 100).toFixed(0)}% (${analysis.coverage.totalBins - analysis.coverage.emptyBins}/${analysis.coverage.totalBins} 分箱) ≥ ${(c.coverageMin * 100).toFixed(0)}%`,
  );

  if (c.matingCoverageMin !== null) {
    add(
      'mating-min',
      '与独立样板整体扣合率达标',
      analysis.mating.coverage >= c.matingCoverageMin,
      `扣合 ${(analysis.mating.coverage * 100).toFixed(0)}% ≥ ${(c.matingCoverageMin * 100).toFixed(0)}%，最大间隙 ${(analysis.mating.maxGap * 1000).toFixed(3)} mm`,
    );
  }
  if (c.matingCoverageMax !== null) {
    add(
      'mating-max',
      '该包整体扣合率应偏低（用于记录采样/成型不足）',
      analysis.mating.coverage <= c.matingCoverageMax,
      `扣合 ${(analysis.mating.coverage * 100).toFixed(0)}% ≤ ${(c.matingCoverageMax * 100).toFixed(0)}%`,
    );
  }
  if (c.expectMaxGapMin !== null) {
    add(
      'max-gap',
      '应出现可见扣合间隙（棱被削平）',
      analysis.mating.maxGap >= c.expectMaxGapMin,
      `最大间隙 ${(analysis.mating.maxGap * 1000).toFixed(3)} mm ≥ ${(c.expectMaxGapMin * 1000).toFixed(3)} mm`,
    );
  }

  if (c.edgeCoverageMin !== null) {
    const green = analysis.mating.segments.every((s) => s.coverage >= c.edgeCoverageMin!);
    const detail = analysis.mating.segments.map((s) => `${s.label} ${(s.coverage * 100).toFixed(0)}%`).join('，');
    add('edge-coverage', '各棱边分段扣合率达标', green, `${detail} ≥ ${(c.edgeCoverageMin * 100).toFixed(0)}%`);
  }

  if (c.ridgeBandObservations) {
    const { min, max } = c.ridgeBandObservations;
    const count = analysis.coverage.ridgeBandCount;
    const ok = (min === undefined || count >= min) && (max === undefined || count <= max);
    add('ridge-band', '尖棱带内测点数量符合采样表', ok, `尖棱带内 ${count} 个测点` + (min !== undefined ? `，下限 ${min}` : '') + (max !== undefined ? `，上限 ${max}` : ''));
  }

  if (c.truthErrorBandMax !== null) {
    add('band-max', '尖棱带真值误差不超过上限', analysis.truthError.bandRms <= c.truthErrorBandMax, `带内真值 RMS ${(analysis.truthError.bandRms * 1000).toFixed(3)} mm ≤ ${(c.truthErrorBandMax * 1000).toFixed(3)} mm`);
  }

  add(
    'lost-feature',
    c.expectLostFeature ? '应检出丢失特征（采样不足）' : '不应检出丢失特征',
    c.expectLostFeature ? analysis.lostFeatures.length > 0 : analysis.lostFeatures.length === 0,
    `检出 ${analysis.lostFeatures.length} 处` + (analysis.lostFeatures[0] ? `，首处 v≈${analysis.lostFeatures[0].v.toFixed(2)} 幅值 ${(analysis.lostFeatures[0].magnitude * 1000).toFixed(2)} mm` : ''),
  );

  if (c.expectEdgeAdvice !== null) {
    const adv = analysis.edgeAdvice.advice;
    add('edge-advice', `棱边补测建议应为 "${c.expectEdgeAdvice}"`, adv === c.expectEdgeAdvice, `实际 "${adv}"：${analysis.edgeAdvice.detail}`);
  }

  if (c.expectMethod !== null) {
    add('method', '真值成型方法标注', pkg.provenance.method === c.expectMethod, `标注方法 ${pkg.provenance.method}`);
  }

  return { ok: checks.every((c2) => c2.ok), checks };
}

/** Load a package from JSON text (or an already-parsed object) with light
 *  structural validation. */
export function parsePackage(input: string | unknown): FabricationPackage {
  const obj = (typeof input === 'string' ? JSON.parse(input) : input) as FabricationPackage;
  if (!obj || obj.schemaVersion !== PACKAGE_SCHEMA_VERSION) throw new Error(`不支持的资料包版本: ${obj?.schemaVersion ?? '缺失'}`);
  if (!Array.isArray(obj.observations) || obj.observations.length === 0) throw new Error('资料包没有观测记录');
  if (!obj.truth?.spec) throw new Error('资料包缺少真值规格');
  if (!obj.fixture?.points?.length) throw new Error('资料包缺少独立样板');
  return obj;
}

export function truthGridAt(pkg: FabricationPackage, i: number, j: number): [number, number, number] {
  const { nu, nv, points } = pkg.truth.grid;
  const k = Math.min(nu - 1, Math.max(0, i)) * nv + Math.min(nv - 1, Math.max(0, j));
  return points[k];
}

export function truthHeight(u: number, v: number, pkg: FabricationPackage): number {
  return truthPoint(u, v, pkg.truth.spec)[2];
}

export function ridgeBandCountOf(plan: SamplePlan, spec: TruthSpec): number {
  return ridgeBandPointCount(plan, spec, ridgeBandHalfWidth(spec));
}
