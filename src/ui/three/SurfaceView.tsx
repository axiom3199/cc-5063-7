import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ViewerMesh } from '../workbench.js';

export interface SurfaceViewProps {
  mesh: ViewerMesh;
  /** measured points to overlay, coloured by residual magnitude */
  points: { position: [number, number, number]; distance: number; weight: number }[];
  /** pending-confirmation region drawn as a translucent band in parameter space */
  pendingBand: { vMin: number; vMax: number } | null;
  /** currently inspected parameter location, drawn as a marker */
  marker: { u: number; v: number } | null;
  uRange: [number, number];
  vRange: [number, number];
  onPick: (param: { u: number; v: number }) => void;
}

/** Three.js viewport: the fitted surface shaded by residual, the measured points,
 *  the pending band and the inspection marker. Clicking the surface reports the
 *  parameter pair at the click so the side panel can show local residuals. */
export function SurfaceView(props: SurfaceViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    surface?: THREE.Mesh;
    markers?: THREE.Group;
    pending?: THREE.Mesh;
    pendingBorder?: THREE.LineSegments;
    hit?: THREE.Mesh;
    target?: THREE.Vector3;
    dragging?: boolean;
    onPickRef: (p: { u: number; v: number }) => void;
  }>({ onPickRef: props.onPick });
  state.current.onPickRef = props.onPick;

  // scene setup once
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1115);
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.01, 20);
    // the specimen data is a z-up panel (x = chord, y = span, z = height), so the
    // camera orbits with +z as its up vector rather than three.js' default +y
    const target = new THREE.Vector3(0.5, 0.5, 0.06);
    camera.up.set(0, 0, 1);
    camera.position.set(0.5, -0.55, 1.15);
    camera.lookAt(target);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(1.2, -1.4, 2.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.55);
    rim.position.set(-1.5, 1.2, 0.4);
    scene.add(rim);

    const grid = new THREE.GridHelper(2, 20, 0x2a3240, 0x1a2029);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(0.5, 0.5, -0.12);
    scene.add(grid);

    const markers = new THREE.Group();
    scene.add(markers);

    const hit = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(hit);

    state.current = { ...state.current, renderer, scene, camera, markers, hit };

    const resize = () => {
      if (!el.clientWidth || !el.clientHeight) return;
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // orbit by mouse drag, in a z-up spherical frame
    let lastX = 0;
    let lastY = 0;
    let azimuth = Math.atan2(camera.position.y - target.y, camera.position.x - target.x);
    let elevation = Math.asin((camera.position.z - target.z) / camera.position.distanceTo(target));
    const radius = camera.position.distanceTo(target);
    const down = (e: PointerEvent) => {
      state.current.dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const up = () => {
      state.current.dragging = false;
    };
    const move = (e: PointerEvent) => {
      if (!state.current.dragging || !state.current.camera) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const cam = state.current.camera;
      azimuth -= dx * 0.008;
      elevation = Math.max(0.12, Math.min(Math.PI / 2 - 0.06, elevation + dy * 0.008));
      cam.position.set(
        target.x + radius * Math.cos(elevation) * Math.cos(azimuth),
        target.y + radius * Math.cos(elevation) * Math.sin(azimuth),
        target.z + radius * Math.sin(elevation),
      );
      cam.lookAt(target);
    };
    let downAt = 0;
    const click = (e: PointerEvent) => {
      if (!state.current.renderer || !state.current.camera || !state.current.surface) return;
      if (Date.now() - downAt > 350) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, state.current.camera);
      const hits = ray.intersectObject(state.current.surface, false);
      if (hits.length === 0) return;
      const hit = hits[0];
      const geo = state.current.surface.geometry as THREE.BufferGeometry;
      const uv = geo.getAttribute('uv');
      const index = geo.getIndex();
      const face = hit.faceIndex;
      if (face === undefined || face === null || !uv || !index) return;
      // faceIndex indexes the index buffer, not the vertex attributes — resolve
      // the three vertex ids first, then interpolate uv barycentrically.
      const ia = index.getX(face * 3);
      const ib = index.getX(face * 3 + 1);
      const ic = index.getX(face * 3 + 2);
      if (ia === undefined || ib === undefined || ic === undefined) return;
      // three.js reports barycentric weights on `face` for indexed geometry only
      // via `hit.uv`; compute manually from the local-space triangle instead.
      const p = state.current.surface.worldToLocal(hit.point.clone());
      const pos = geo.getAttribute('position');
      const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia);
      const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib);
      const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic);
      const v0 = new THREE.Vector3(bx - ax, by - ay, bz - az);
      const v1 = new THREE.Vector3(cx - ax, cy - ay, cz - az);
      const v2 = new THREE.Vector3(p.x - ax, p.y - ay, p.z - az);
      const d00 = v0.dot(v0), d01 = v0.dot(v1), d11 = v1.dot(v1);
      const d20 = v2.dot(v0), d21 = v2.dot(v1);
      const den = d00 * d11 - d01 * d01;
      const b1 = den === 0 ? 0 : (d11 * d20 - d01 * d21) / den;
      const b2 = den === 0 ? 0 : (d00 * d21 - d01 * d20) / den;
      const b0 = 1 - b1 - b2;
      const ua = uv.getX(ia), va = uv.getY(ia);
      const ub = uv.getX(ib), vb = uv.getY(ib);
      const uc = uv.getX(ic), vc = uv.getY(ic);
      const u = b0 * ua + b1 * ub + b2 * uc;
      const v = b0 * va + b1 * vb + b2 * vc;
      if (!Number.isFinite(u) || !Number.isFinite(v)) return;
      state.current.onPickRef({ u, v });
    };
    const pDown = (e: PointerEvent) => {
      downAt = Date.now();
      down(e);
    };
    renderer.domElement.addEventListener('pointerdown', pDown);
    window.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('click', click);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pDown);
      window.removeEventListener('pointerup', up);
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('click', click);
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  // surface geometry
  useEffect(() => {
    const s = state.current;
    if (!s.scene) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(props.mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(props.mesh.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(props.mesh.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(props.mesh.indices, 1));
    // uv attribute for picking: grid parameter pair per vertex
    const uv = new Float32Array(props.mesh.nu * props.mesh.nv * 2);
    for (let i = 0; i < props.mesh.nu; i++) {
      for (let j = 0; j < props.mesh.nv; j++) {
        const k = i * props.mesh.nv + j;
        uv[k * 2] = props.uRange[0] + ((props.uRange[1] - props.uRange[0]) * i) / (props.mesh.nu - 1);
        uv[k * 2 + 1] = props.vRange[0] + ((props.vRange[1] - props.vRange[0]) * j) / (props.mesh.nv - 1);
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.05, flatShading: false });
    if (s.surface) {
      s.scene.remove(s.surface);
      s.surface.geometry.dispose();
      (s.surface.material as THREE.Material).dispose();
    }
    const mesh = new THREE.Mesh(geo, mat);
    s.scene.add(mesh);
    s.surface = mesh;
    s.camera!.up.set(0, 0, 1);
    s.camera!.lookAt(0.5, 0.5, 0.06);
  }, [props.mesh, props.uRange, props.vRange]);

  // point and marker overlays
  useEffect(() => {
    const s = state.current;
    if (!s.markers || !s.scene) return;
    while (s.markers.children.length) {
      const c = s.markers.children.pop()!;
      (c as THREE.Mesh).geometry?.dispose();
      ((c as THREE.Mesh).material as THREE.Material)?.dispose();
    }
    const scale = Math.max(1e-4, s.surface ? medianPoint(props.points) : 1e-3);
    for (const p of props.points) {
      const t = Math.min(1, p.distance / scale);
      const color = new THREE.Color().setHSL(0.58 - 0.58 * t, 0.85, 0.55);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 8), new THREE.MeshBasicMaterial({ color }));
      dot.position.set(p.position[0], p.position[1], p.position[2]);
      s.markers.add(dot);
    }
    if (props.marker && s.surface) {
      const pos = positionAtParam(props.marker.u, props.marker.v, props.mesh, props.uRange, props.vRange);
      if (pos) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.02, 0.0025, 8, 32),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        ring.position.set(pos[0], pos[1], pos[2]);
        s.markers.add(ring);
      }
    }
    if (s.pending) {
      s.markers.remove(s.pending);
      s.pending.geometry.dispose();
      (s.pending.material as THREE.Material).dispose();
      s.pending = undefined;
    }
    if (s.pendingBorder) {
      s.markers.remove(s.pendingBorder);
      s.pendingBorder.geometry.dispose();
      (s.pendingBorder.material as THREE.Material).dispose();
      s.pendingBorder = undefined;
    }
    if (props.pendingBand) {
      const geo = pendingRibbon(props.mesh, props.uRange, props.vRange, props.pendingBand.vMin, props.pendingBand.vMax);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
      const band = new THREE.Mesh(geo, mat);
      band.renderOrder = 2;
      s.markers.add(band);
      s.pending = band;
      const border = pendingBorder(props.mesh, props.uRange, props.vRange, props.pendingBand.vMin, props.pendingBand.vMax);
      s.markers.add(border);
      s.pendingBorder = border;
    }
  }, [props.points, props.marker, props.pendingBand, props.mesh, props.uRange, props.vRange]);

  return <div className="viewport" ref={host} />;
}

function medianPoint(points: { distance: number }[]): number {
  if (!points.length) return 1e-4;
  const sorted = points.map((p) => p.distance).sort((a, b) => a - b);
  return Math.max(sorted[Math.floor(sorted.length / 2)], 1e-4);
}

function positionAtParam(
  u: number,
  v: number,
  mesh: ViewerMesh,
  uRange: [number, number],
  vRange: [number, number],
): [number, number, number] | null {
  const p = paramPoint(u, v, mesh, uRange, vRange);
  const n = paramNormal(u, v, mesh, uRange, vRange);
  const lift = 0.004;
  return [p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift];
}

/** A thin translucent ribbon over the parameter strip v ∈ [vMin, vMax]. Emitted
 *  on both sides of the surface: the normal's sign depends on how the lattice was
 *  built, so a single offset can land behind the panel and vanish. Offsetting both
 *  ways guarantees one copy faces the camera, and the other is depth-culled. */
function pendingRibbon(
  mesh: ViewerMesh,
  uRange: [number, number],
  vRange: [number, number],
  vMin: number,
  vMax: number,
): THREE.BufferGeometry {
  const nu = 24;
  const positions = new Float32Array(nu * 2 * 3 * 2);
  const indices: number[] = [];
  const lift = 0.0025;
  let write = 0;
  for (const sign of [1, -1]) {
    const base = write / 3;
    for (let i = 0; i < nu; i++) {
      const u = uRange[0] + ((uRange[1] - uRange[0]) * i) / (nu - 1);
      const a = paramPoint(u, vMin, mesh, uRange, vRange);
      const b = paramPoint(u, vMax, mesh, uRange, vRange);
      const na = paramNormal(u, vMin, mesh, uRange, vRange);
      const nb = paramNormal(u, vMax, mesh, uRange, vRange);
      positions[write++] = a[0] + sign * na[0] * lift;
      positions[write++] = a[1] + sign * na[1] * lift;
      positions[write++] = a[2] + sign * na[2] * lift;
      positions[write++] = b[0] + sign * nb[0] * lift;
      positions[write++] = b[1] + sign * nb[1] * lift;
      positions[write++] = b[2] + sign * nb[2] * lift;
    }
    for (let i = 0; i < nu - 1; i++) {
      const k0 = base + i * 2;
      const c = base + (i + 1) * 2;
      indices.push(k0, k0 + 1, c, c, k0 + 1, c + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

/** The two boundary curves of the pending strip, drawn as bright lines so the
 *  region stays legible against the residual heat shading. */
function pendingBorder(
  mesh: ViewerMesh,
  uRange: [number, number],
  vRange: [number, number],
  vMin: number,
  vMax: number,
): THREE.LineSegments {
  const nu = 64;
  const lift = 0.0035;
  const verts: number[] = [];
  const at = (u: number, v: number, sign: number): [number, number, number] => {
    const p = paramPoint(u, v, mesh, uRange, vRange);
    const n = paramNormal(u, v, mesh, uRange, vRange);
    return [p[0] + sign * n[0] * lift, p[1] + sign * n[1] * lift, p[2] + sign * n[2] * lift];
  };
  for (const sign of [1, -1]) {
    for (const v of [vMin, vMax]) {
      for (let i = 0; i < nu - 1; i++) {
        const u0 = uRange[0] + ((uRange[1] - uRange[0]) * i) / (nu - 1);
        const u1 = uRange[0] + ((uRange[1] - uRange[0]) * (i + 1)) / (nu - 1);
        verts.push(...at(u0, v, sign), ...at(u1, v, sign));
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85 });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 3;
  return lines;
}

/** Bilinearly interpolated surface normal at a parameter pair. */
function paramNormal(
  u: number,
  v: number,
  mesh: ViewerMesh,
  uRange: [number, number],
  vRange: [number, number],
): [number, number, number] {
  const fi = ((u - uRange[0]) / (uRange[1] - uRange[0])) * (mesh.nu - 1);
  const fj = ((v - vRange[0]) / (vRange[1] - vRange[0])) * (mesh.nv - 1);
  const i = Math.max(0, Math.min(mesh.nu - 2, Math.floor(fi)));
  const j = Math.max(0, Math.min(mesh.nv - 2, Math.floor(fj)));
  const di = fi - i;
  const dj = fj - j;
  const at = (ii: number, jj: number): [number, number, number] => {
    const k = (ii * mesh.nv + jj) * 3;
    return [mesh.normals[k], mesh.normals[k + 1], mesh.normals[k + 2]];
  };
  const a = at(i, j);
  const b = at(i + 1, j);
  const c = at(i, j + 1);
  const d = at(i + 1, j + 1);
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = a[k] * (1 - di) * (1 - dj) + b[k] * di * (1 - dj) + c[k] * (1 - di) * dj + d[k] * di * dj;
  }
  const len = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / len, out[1] / len, out[2] / len];
}

function paramPoint(
  u: number,
  v: number,
  mesh: ViewerMesh,
  uRange: [number, number],
  vRange: [number, number],
): [number, number, number] {
  const fi = ((u - uRange[0]) / (uRange[1] - uRange[0])) * (mesh.nu - 1);
  const fj = ((v - vRange[0]) / (vRange[1] - vRange[0])) * (mesh.nv - 1);
  const i = Math.max(0, Math.min(mesh.nu - 2, Math.floor(fi)));
  const j = Math.max(0, Math.min(mesh.nv - 2, Math.floor(fj)));
  const di = fi - i;
  const dj = fj - j;
  const at = (ii: number, jj: number): [number, number, number] => {
    const k = (ii * mesh.nv + jj) * 3;
    return [mesh.positions[k], mesh.positions[k + 1], mesh.positions[k + 2]];
  };
  const p00 = at(i, j);
  const p10 = at(i + 1, j);
  const p01 = at(i, j + 1);
  const p11 = at(i + 1, j + 1);
  return [0, 1, 2].map(
    (c) => p00[c] * (1 - di) * (1 - dj) + p10[c] * di * (1 - dj) + p01[c] * (1 - di) * dj + p11[c] * di * dj,
  ) as [number, number, number];
}
