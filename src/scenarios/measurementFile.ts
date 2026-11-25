import type { Vec3 } from '../core/types.js';

/** A measurement file as delivered by the scanning cell. Labels are supplied by
 *  the process planner; this tool must verify them, never invent them. */

export interface MeasurementRecord {
  /** label exactly as it appears in the file; may be missing or duplicated */
  label: string;
  /** exactly two numeric parameter labels, or null when the file is incomplete */
  params: [number, number] | null;
  point: Vec3 | null;
  normal: Vec3 | null;
  probeId: string;
  passId: string;
  side: string;
  /** free-form annotation from the operator */
  note?: string;
}
export interface MeasurementFile {
  id: string;
  description: string;
  records: MeasurementRecord[];
  metadata: {
    specimen: string;
    createdAt: string;
    unit: string;
    /** declared parameterization axis meaning, so the tool can validate */
    uMeaning: string;
    vMeaning: string;
    /** declared parameter range the labels are expected to cover */
    uRange: [number, number];
    vRange: [number, number];
    operator: string;
  };
}

export interface LabelIssue {
  kind: 'missing' | 'duplicate' | 'out-of-range' | 'non-numeric' | 'missing-point';
  label: string;
  recordIndex: number;
  detail: string;
}

export interface LabelValidation {
  ok: boolean;
  issues: LabelIssue[];
  accepted: { record: MeasurementRecord; index: number }[];
  rejected: { record: MeasurementRecord; index: number; issues: LabelIssue[] }[];
  duplicateGroups: { key: string; indices: number[] }[];
  coverage: { u: [number, number]; v: [number, number] } | null;
  checked: number;
}

/** Verify parameter labels. Nothing is repaired, imputed, or reordered:
 *  missing or duplicate labels are reported and the affected records are held
 *  out of the fit rather than quietly filled in. */
export function validateLabels(file: MeasurementFile, tolerance = 1e-6): LabelValidation {
  const issues: LabelIssue[] = [];
  const seen = new Map<string, number[]>();
  const rejectedIdx = new Set<number>();

  file.records.forEach((r, index) => {
    const local: LabelIssue[] = [];
    if (r.point === null) {
      local.push({ kind: 'missing-point', label: r.label, recordIndex: index, detail: '记录没有坐标值' });
    }
    if (r.params === null) {
      local.push({ kind: 'missing' as const, label: r.label, recordIndex: index, detail: '缺少二维参数标签，不能推断，已排除' });
    } else {
      const [u, v] = r.params;
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        local.push({ kind: 'non-numeric', label: r.label, recordIndex: index, detail: `参数标签非数值 (${u},${v})` });
      } else {
        const [u0, u1] = file.metadata.uRange;
        const [v0, v1] = file.metadata.vRange;
        if (u < u0 - tolerance || u > u1 + tolerance || v < v0 - tolerance || v > v1 + tolerance) {
          local.push({
            kind: 'out-of-range',
            label: r.label,
            recordIndex: index,
            detail: `标签 (${u.toFixed(4)},${v.toFixed(4)}) 超出声明范围 u∈[${u0},${u1}] v∈[${v0},${v1}]`,
          });
        }
        // Duplicate = the same (u,v) label appearing twice *within one probe pass*.
        // Two different probes legitimately measure the same parameter point; that
        // is corroborating evidence, not a duplicate label. The key therefore
        // includes the probe and pass identity.
        const key = `${r.probeId}|${r.passId}|${round(u, 5)}|${round(v, 5)}`;
        const list = seen.get(key) ?? [];
        list.push(index);
        seen.set(key, list);
      }
    }
    if (local.length) {
      issues.push(...local);
      rejectedIdx.add(index);
    }
  });

  const duplicateGroups: { key: string; indices: number[] }[] = [];
  for (const [key, indices] of seen) {
    if (indices.length > 1) {
      duplicateGroups.push({ key, indices });
      const [probeId, passId] = key.split('|');
      for (const i of indices) {
        rejectedIdx.add(i);
        issues.push({
          kind: 'duplicate',
          label: file.records[i].label,
          recordIndex: i,
          detail: `探头 ${probeId} 的 ${passId} 批次中，参数点 (${key.split('|')[2]}, ${key.split('|')[3]}) 重复出现 ${indices.length} 次；不做平均或任意保留，整组排除待人工确认`,
        });
      }
    }
  }

  const accepted: LabelValidation['accepted'] = [];
  const rejected: LabelValidation['rejected'] = [];
  file.records.forEach((record, index) => {
    if (rejectedIdx.has(index)) {
      rejected.push({
        record,
        index,
        issues: issues.filter((i) => i.recordIndex === index),
      });
    } else {
      accepted.push({ record, index });
    }
  });

  let coverage: LabelValidation['coverage'] = null;
  const good = accepted.filter((a) => a.record.params !== null);
  if (good.length) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const a of good) {
      const [u, v] = a.record.params as [number, number];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    coverage = { u: [u0, u1], v: [v0, v1] };
  }

  return { ok: issues.length === 0, issues, accepted, rejected, duplicateGroups, coverage, checked: file.records.length };
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Serialize to a flat CSV so the same validation path can run on real files. */
export function fileToCsv(file: MeasurementFile): string {
  const head = 'label,u,v,x,y,z,nx,ny,nz,probe,pass,side,note';
  const rows = file.records.map((r) => {
    const p = r.point ?? [NaN, NaN, NaN];
    const n = r.normal ?? [NaN, NaN, NaN];
    const u = r.params ? r.params[0] : NaN;
    const v = r.params ? r.params[1] : NaN;
    return [r.label, u, v, p[0], p[1], p[2], n[0], n[1], n[2], r.probeId, r.passId, r.side, r.note ?? '']
      .map((x) => (typeof x === 'number' ? (Number.isFinite(x) ? x.toPrecision(12) : '') : String(x)))
      .join(',');
  });
  return [head, ...rows].join('\n') + '\n';
}

export function csvToFile(id: string, description: string, csv: string, metadata: MeasurementFile['metadata']): MeasurementFile {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = (name: string) => header.indexOf(name);
  const num = (s: string): number | null => {
    if (s === undefined || s.trim() === '') return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  };
  const records: MeasurementRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split(',');
    const u = num(c[idx('u')]);
    const v = num(c[idx('v')]);
    const x = num(c[idx('x')]);
    const y = num(c[idx('y')]);
    const z = num(c[idx('z')]);
    const nx = num(c[idx('nx')]);
    const ny = num(c[idx('ny')]);
    const nz = num(c[idx('nz')]);
    records.push({
      label: c[idx('label')],
      params: u === null || v === null ? null : [u, v],
      point: x === null || y === null || z === null ? null : [x, y, z],
      normal: nx === null || ny === null || nz === null ? null : [nx, ny, nz],
      probeId: c[idx('probe')],
      passId: c[idx('pass')],
      side: c[idx('side')],
      note: c[idx('note')] || undefined,
    });
  }
  return { id, description, records, metadata };
}
