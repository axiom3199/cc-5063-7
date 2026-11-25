import { buildSession } from '../src/scenarios/session.js';
import { SCENARIOS } from '../src/scenarios/scenarios.js';
import type { ProbeStats } from '../src/core/arbitration.js';

/** Human-readable arbitration report for every scenario. `npm run report`. */

function probeLine(p: ProbeStats): string {
  const rm = p.rowModel;
  return (
    p.probeId +
    ' 中位偏差=' + (p.templateBias * 1000).toFixed(3) + 'mm' +
    ' 行模型=' + rm.kind +
    '(dBIC=' + rm.dbic.toFixed(1) + ' 幅值=' + (rm.magnitude * 1000).toFixed(2) + 'mm@v' + rm.station.toFixed(3) + ')' +
    (p.globalOffset ? ' [整体偏移]' : '')
  );
}

let failures = 0;
for (const spec of SCENARIOS) {
  const s = buildSession(spec);
  const a = s.arbitration;
  const band = a.evidence.band;
  const tf = a.evidence.templateFold;
  const okHyp = a.hypothesis === spec.expected.hypothesis;
  const okPending = (a.pendingRegion !== null) === spec.expected.pendingRegion;
  if (!okHyp || !okPending) failures++;
  console.log((okHyp && okPending ? '✓ ' : '✗ ') + spec.id + ' —— ' + spec.title);
  console.log('  预期：假设=' + spec.expected.hypothesis + ' 待确认区=' + (spec.expected.pendingRegion ? '有' : '无') + '；' + spec.expected.outcome);
  console.log('  实际：假设=' + a.hypothesis + ' 待确认区=' + (a.pendingRegion ? '有' : '无') + ' 就绪=' + s.readiness.state + ' 可加工=' + s.readiness.canExportMachinable);
  console.log('  偏离带：' + (band ? 'v=' + band.vCenter.toFixed(3) + ' 形态=' + band.signature + ' 幅值=' + (band.magnitude * 1000).toFixed(2) + 'mm dBIC=' + band.dbic.toFixed(1) + ' 探头=' + band.probeIds.join(',') : '无'));
  console.log('  样板试配：' + (tf ? (tf.improvement >= 1.08 ? '检出折线 v=' + tf.at.toFixed(3) + ' 改善 ' + tf.improvement.toFixed(2) + '×' : '无折线（最大改善 ' + tf.improvement.toFixed(2) + '×）') : '无样板'));
  console.log('  复测：复现=' + String(a.repeat.reproduces) + ' 覆盖=' + a.repeat.covers + (a.repeat.reproducedSlope !== null ? ' 斜率突变=' + a.repeat.reproducedSlope.toFixed(3) + 'mm/u' : ''));
  console.log('  探头：' + a.evidence.probes.map(probeLine).join(' ｜ '));
  console.log('  选定：' + a.chosen.id + ' 样板失败=' + a.chosen.template.failures + ' RMS=' + (a.chosen.rms * 1000).toFixed(3) + 'mm 留出=' + (a.chosen.rmsHoldout * 1000).toFixed(3) + 'mm 控制点=' + a.chosen.controlPoints);
  console.log('  候选：' + a.candidates.map((c) => c.id + '(样板失败=' + c.template.failures + ',留出=' + (c.rmsHoldout * 1000).toFixed(3) + 'mm)').join(' ｜ '));
  if (a.overfitComparison) console.log('  过拟合比较：' + a.overfitComparison.verdict + ' —— ' + a.overfitComparison.explanation);
  if (a.pendingRegion) console.log('  待确认区：v∈[' + a.pendingRegion.vRange[0].toFixed(2) + ', ' + a.pendingRegion.vRange[1].toFixed(2) + '] —— ' + a.pendingRegion.reason);
  console.log('');
}
if (failures > 0) {
  console.error(failures + ' 个场景的判定与预期不符');
  process.exit(1);
}
console.log('全部 ' + SCENARIOS.length + ' 个场景判定与预期一致。');
