/** The four canonical fabrication packages (曲面测点资料包).
 *
 *  Cross the two design axes:
 *    - truth method  : analytic (evaluate directly) vs section (assemble from
 *                      calibrated sections and interpolate),
 *    - sampling table: A coarse (apex row absent) vs B refined (apex measured).
 *
 *  These four together demonstrate the decisive result: analytic-coarse and
 *  section-refined have SIMILAR in-sample residual but very different mating
 *  behaviour, so residual cannot decide which edge needs more measurement —
 *  the actual per-edge mating coverage can. See `docs`/README and the tests. */

import { buildPackage } from './package.js';
import { NOMINAL_TRUTH_SPEC } from './truthSurface.js';
import { coarseSectionStations } from './package.js';
import type { BuildOptions } from './package.js';
import type { Conventions, FabricationPackage } from './types.js';

const BASE = {
  spec: NOMINAL_TRUTH_SPEC,
  seed: 7007,
  tolerance: 0.0009,
  createdAt: '2026-11-26T00:00:00Z',
};

/** Analytic truth, sparse table: the apex row is missing, so the crest is lost.
 *  Mating coverage is low and the assembler asks for MORE MEASUREMENT. */
export const CONV_ANALYTIC_COARSE: Conventions = {
  fitRmsMax: 0.0012,
  coverageMin: 0.9,
  matingCoverageMin: null,
  matingCoverageMax: 0.86,
  edgeCoverageMin: null,
  ridgeBandObservations: { max: 60 },
  expectLostFeature: true,
  expectMaxGapMin: 0.0018,
  truthErrorBandMax: null,
  expectEdgeAdvice: 'add-measurement',
  expectMethod: 'analytic',
};

/** Analytic truth, refined table: the apex row is measured, so the crest is
 *  recovered. This is the reference "good" package. */
export const CONV_ANALYTIC_REFINED: Conventions = {
  fitRmsMax: 0.0012,
  coverageMin: 0.9,
  matingCoverageMin: 0.9,
  matingCoverageMax: null,
  edgeCoverageMin: 0.85,
  ridgeBandObservations: { min: 100 },
  expectLostFeature: false,
  expectMaxGapMin: null,
  truthErrorBandMax: 0.0009,
  expectEdgeAdvice: 'none',
  expectMethod: 'analytic',
};

/** Section-assembled truth, refined table: the apex samples EXIST (the table is
 *  dense) yet the crest is still lost, because linear interpolation across too
 *  coarse calibrated sections chopped the peak off. Coverage is low but the
 *  apex is measured, so the assembler asks for a METHOD REVIEW, not more points.
 *  Crucially its in-sample residual is *lower* than the analytic-refined one. */
export const CONV_SECTION_REFINED: Conventions = {
  fitRmsMax: 0.0012,
  coverageMin: 0.9,
  matingCoverageMin: null,
  matingCoverageMax: 0.8,
  edgeCoverageMin: null,
  ridgeBandObservations: { min: 100 },
  expectLostFeature: true,
  expectMaxGapMin: 0.0022,
  truthErrorBandMax: 0.0013,
  expectEdgeAdvice: 'method-review',
  expectMethod: 'section',
};

export const CONV_SECTION_COARSE: Conventions = {
  ...CONV_ANALYTIC_COARSE,
  expectMethod: 'section',
};

const OPTIONS = {
  'analytic-coarse': {
    ...BASE,
    id: 'WT-07-analytic-coarse',
    title: '解析真值 · 采样表 A（尖棱处稀疏）',
    method: 'analytic',
    table: 'coarse',
    conventions: CONV_ANALYTIC_COARSE,
  },
  'analytic-refined': {
    ...BASE,
    id: 'WT-07-analytic-refined',
    title: '解析真值 · 采样表 B（尖棱处加密）',
    method: 'analytic',
    table: 'refined',
    conventions: CONV_ANALYTIC_REFINED,
  },
  'section-refined': {
    ...BASE,
    id: 'WT-07-section-refined',
    title: '标定截面拼装真值 · 采样表 B（峰顶已测仍失棱）',
    method: 'section',
    table: 'refined',
    sectionStations: coarseSectionStations(),
    conventions: CONV_SECTION_REFINED,
  },
  'section-coarse': {
    ...BASE,
    id: 'WT-07-section-coarse',
    title: '标定截面拼装真值 · 采样表 A（双重不足）',
    method: 'section',
    table: 'coarse',
    sectionStations: coarseSectionStations(),
    conventions: CONV_SECTION_COARSE,
  },
} satisfies Record<string, BuildOptions>;

export type PackageKey = keyof typeof OPTIONS;
export const PACKAGE_KEYS = Object.keys(OPTIONS) as PackageKey[];

export const PACKAGE_LIST: { key: PackageKey; id: string; title: string; description: string }[] = [
  { key: 'analytic-coarse', id: OPTIONS['analytic-coarse'].id, title: OPTIONS['analytic-coarse'].title, description: '尖棱峰顶未测：扣合率偏低，应补测该段棱边。' },
  { key: 'analytic-refined', id: OPTIONS['analytic-refined'].id, title: OPTIONS['analytic-refined'].title, description: '峰顶已测：棱被重建，扣合率高。' },
  { key: 'section-refined', id: OPTIONS['section-refined'].id, title: OPTIONS['section-refined'].title, description: '峰顶已测仍失棱：截面插值抹平，应复核成型方法。' },
  { key: 'section-coarse', id: OPTIONS['section-coarse'].id, title: OPTIONS['section-coarse'].title, description: '截面拼装 + 稀疏采样：采样与方法双重不足。' },
];

export function buildCanonicalPackage(key: PackageKey): FabricationPackage {
  const opts = OPTIONS[key];
  if (!opts) throw new Error(`未知资料包: ${key}`);
  return buildPackage(opts);
}

export function buildAllCanonicalPackages(): Record<PackageKey, FabricationPackage> {
  const out = {} as Record<PackageKey, FabricationPackage>;
  for (const key of PACKAGE_KEYS) out[key] = buildCanonicalPackage(key);
  return out;
}

export function canonicalOptions(key: PackageKey): BuildOptions {
  return OPTIONS[key];
}
