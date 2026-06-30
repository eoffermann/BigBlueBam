import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {
  Crosshair,
  FastForward,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Rewind,
  RotateCcw,
  StepBack,
  StepForward,
} from 'lucide-react';
import type {
  MediaMeta,
  ViewpointAnchor,
  ViewpointAnnotation,
  ViewpointCamera,
  ViewpointSurface,
  ViewpointTime,
} from '@/hooks/use-bay';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Custom three.js review viewer (Bay FBX 3D review).
//
// Phase A (static): loads the GLB proxy, orbits/pans/zooms, captures + restores
// camera viewpoints, picks a geometry-anchored surface spot (screen fallback),
// and renders markers for existing viewpoint annotations.
//
// Phase B (animated takes): when the proxy carries animation clips, an
// AnimationMixer drives a frame-accurate transport (play/pause, scrub, J/K/L,
// frame-step, loop, clip selector). Captured viewpoints pin a `time` sub-anchor
// (clip + frame). Surface spots on a SkinnedMesh re-resolve against the DEFORMED
// geometry at the current frame (CPU linear-blend skinning of the hit triangle),
// so a highlight stays glued to the surface as the skeleton poses (§6.2).
// ---------------------------------------------------------------------------

interface ModelViewerProps {
  /** The GLB proxy URL (binRawUrl(binId, 'proxy')). */
  src: string;
  mediaMeta?: MediaMeta | null;
  /** Called when the reviewer remembers a viewpoint (camera only) or drops a
   *  spot (camera + surface). The page wires this to its pending-anchor flow. */
  onCaptureViewpoint?: (anchor: ViewpointAnchor) => void;
  /** Existing viewpoint annotations, rendered as clickable markers. */
  annotations?: ViewpointAnnotation[];
  /** When set/changed, fly the camera back to this anchor and show its spot. */
  focusAnchor?: ViewpointAnchor | null;
  className?: string;
}

// --- pure three.js helpers -------------------------------------------------

/** glTF node path (ancestor names joined by '/') used to re-find a mesh. */
function nodePathOf(obj: THREE.Object3D): string {
  const parts: string[] = [];
  let cur: THREE.Object3D | null = obj;
  while (cur && cur.parent) {
    if (cur.name) parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join('/') || obj.name || obj.uuid;
}

/** Re-find a mesh by stored node path; tolerant of path vs. bare-name drift. */
function findMeshByPath(root: THREE.Object3D, path: string | undefined): THREE.Mesh | null {
  if (!path) return null;
  const last = path.split('/').pop();
  let exact: THREE.Mesh | null = null;
  let byName: THREE.Mesh | null = null;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const p = nodePathOf(o);
    if (!exact && p === path) exact = mesh;
    if (!byName && (o.name === last || o.name === path)) byName = mesh;
  });
  return exact ?? byName;
}

/** Barycentric coords of a world-space hit point within its (world) triangle. */
function barycentricOf(
  mesh: THREE.Mesh,
  face: THREE.Face,
  worldPoint: THREE.Vector3,
): [number, number, number] {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const a = new THREE.Vector3().fromBufferAttribute(pos, face.a).applyMatrix4(mesh.matrixWorld);
  const b = new THREE.Vector3().fromBufferAttribute(pos, face.b).applyMatrix4(mesh.matrixWorld);
  const c = new THREE.Vector3().fromBufferAttribute(pos, face.c).applyMatrix4(mesh.matrixWorld);
  const out = new THREE.Vector3();
  THREE.Triangle.getBarycoord(worldPoint, a, b, c, out);
  return [out.x, out.y, out.z];
}

/** Triangle vertex indices of a stored `tri` within a geometry primitive. */
function triIndices(
  geom: THREE.BufferGeometry,
  tri: number,
): [number, number, number] | null {
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const base = tri * 3;
  let ia: number;
  let ib: number;
  let ic: number;
  if (geom.index) {
    ia = geom.index.getX(base);
    ib = geom.index.getX(base + 1);
    ic = geom.index.getX(base + 2);
  } else {
    ia = base;
    ib = base + 1;
    ic = base + 2;
  }
  if (ia == null || ib == null || ic == null) return null;
  if (ia >= pos.count || ib >= pos.count || ic >= pos.count) return null;
  return [ia, ib, ic];
}

// Scratch objects reused across CPU-skinning math (no per-vertex allocation).
const _sv = new THREE.Vector3();
const _sw = new THREE.Vector3();
const _bm = new THREE.Matrix4();

/**
 * CPU linear-blend skinning for ONE vertex of a SkinnedMesh, to WORLD space, at
 * the skeleton's CURRENT pose (§6.2). Mirrors three.js's skinning shader:
 *
 *   skinVertex = bindMatrix · position                       (vertex in bind-world)
 *   skinned    = Σ_b weight_b · (bone_b.matrixWorld · boneInverse_b) · skinVertex
 *   world      = mesh.matrixWorld · bindMatrixInverse · skinned
 *
 * `bone.matrixWorld` is live because the AnimationMixer has already been scrubbed
 * to the target frame and the scene's world matrices updated. We read the
 * skeleton's own `boneInverses` (the inverse bind matrices three.js computed at
 * bind time) rather than recomputing them.
 */
function skinVertexWorld(
  vid: number,
  mesh: THREE.SkinnedMesh,
  skeleton: THREE.Skeleton,
  out: THREE.Vector3,
): THREE.Vector3 {
  const geom = mesh.geometry as THREE.BufferGeometry;
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const skinIndex = geom.attributes.skinIndex as THREE.BufferAttribute | undefined;
  const skinWeight = geom.attributes.skinWeight as THREE.BufferAttribute | undefined;
  out.set(0, 0, 0);
  if (!skinIndex || !skinWeight) {
    // No skin data on this primitive — treat as a rigid vertex.
    return out.fromBufferAttribute(pos, vid).applyMatrix4(mesh.matrixWorld);
  }
  _sv.fromBufferAttribute(pos, vid).applyMatrix4(mesh.bindMatrix);
  const ix = [skinIndex.getX(vid), skinIndex.getY(vid), skinIndex.getZ(vid), skinIndex.getW(vid)];
  const iw = [skinWeight.getX(vid), skinWeight.getY(vid), skinWeight.getZ(vid), skinWeight.getW(vid)];
  for (let k = 0; k < 4; k++) {
    const w = iw[k];
    const bi = ix[k];
    if (!w || bi === undefined) continue;
    const bone = skeleton.bones[bi];
    const inv = skeleton.boneInverses[bi];
    if (!bone || !inv) continue;
    _bm.multiplyMatrices(bone.matrixWorld, inv);
    _sw.copy(_sv).applyMatrix4(_bm).multiplyScalar(w);
    out.add(_sw);
  }
  out.applyMatrix4(mesh.bindMatrixInverse);
  out.applyMatrix4(mesh.matrixWorld);
  return out;
}

/**
 * Resolve a geometry-mode surface anchor on a SkinnedMesh to a world point at the
 * CURRENT pose: skin the hit triangle's three vertices, then combine them by the
 * stored barycentric weights. Returns null if the anchor lacks tri/bary.
 */
function resolveSkinnedPoint(
  surface: ViewpointSurface,
  mesh: THREE.SkinnedMesh,
): THREE.Vector3 | null {
  if (surface.tri == null || !surface.bary || !mesh.skeleton) return null;
  const tri = triIndices(mesh.geometry as THREE.BufferGeometry, surface.tri);
  if (!tri) return null;
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  skinVertexWorld(tri[0], mesh, mesh.skeleton, p0);
  skinVertexWorld(tri[1], mesh, mesh.skeleton, p1);
  skinVertexWorld(tri[2], mesh, mesh.skeleton, p2);
  const [w0, w1, w2] = surface.bary;
  return p0.multiplyScalar(w0).add(p1.multiplyScalar(w1)).add(p2.multiplyScalar(w2));
}

/**
 * Resolve a geometry-mode surface anchor to a world point at the current pose.
 * For a SkinnedMesh this re-resolves against the DEFORMED geometry (§6.2); for a
 * rigid mesh it interpolates the stored triangle's local vertices by the
 * barycentric weights then transforms by the node's world matrix. Falls back to
 * `local_point`.
 */
function resolveSurfaceWorldPoint(
  root: THREE.Object3D,
  surface: ViewpointSurface | undefined,
): THREE.Vector3 | null {
  if (!surface || surface.mode !== 'geometry') return null;
  const mesh = findMeshByPath(root, surface.node);
  if (!mesh) return null;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh && surface.tri != null && surface.bary) {
    const skinned = resolveSkinnedPoint(surface, mesh as THREE.SkinnedMesh);
    if (skinned) return skinned;
  }
  if (surface.tri == null || !surface.bary) {
    return surface.local_point
      ? mesh.localToWorld(new THREE.Vector3(...surface.local_point))
      : null;
  }
  const geom = mesh.geometry as THREE.BufferGeometry;
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const tri = triIndices(geom, surface.tri);
  if (!tri) {
    return surface.local_point
      ? mesh.localToWorld(new THREE.Vector3(...surface.local_point))
      : null;
  }
  const [w0, w1, w2] = surface.bary;
  const local = new THREE.Vector3()
    .fromBufferAttribute(pos, tri[0])
    .multiplyScalar(w0)
    .add(new THREE.Vector3().fromBufferAttribute(pos, tri[1]).multiplyScalar(w1))
    .add(new THREE.Vector3().fromBufferAttribute(pos, tri[2]).multiplyScalar(w2));
  return mesh.localToWorld(local);
}

/** Barycentric coords against POSED world vertices (skinned-aware capture). */
function barycentricPosed(
  mesh: THREE.Mesh,
  face: THREE.Face,
  worldPoint: THREE.Vector3,
): [number, number, number] {
  const skinned = mesh as THREE.SkinnedMesh;
  if (skinned.isSkinnedMesh && skinned.skeleton) {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    skinVertexWorld(face.a, skinned, skinned.skeleton, a);
    skinVertexWorld(face.b, skinned, skinned.skeleton, b);
    skinVertexWorld(face.c, skinned, skinned.skeleton, c);
    const out = new THREE.Vector3();
    THREE.Triangle.getBarycoord(worldPoint, a, b, c, out);
    return [out.x, out.y, out.z];
  }
  return barycentricOf(mesh, face, worldPoint);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A glTF animation clip resolved against its media_meta descriptor. */
interface ResolvedClip {
  id: string;
  name: string;
  fps: number;
  frameCount: number;
  duration: number;
  clip: THREE.AnimationClip;
}

/** Light, serializable mirror of ResolvedClip for the transport UI. */
type ClipMeta = Omit<ResolvedClip, 'clip'>;

/** Re-glue the active spot + annotation markers to the current pose. Cheap: only
 *  the hit triangle of each shown surface is re-skinned. */
function refreshSurfaces(e: Engine) {
  if (!e.root) return;
  if (e.shownSurface && e.shownSurface.mode === 'geometry') {
    const p = resolveSurfaceWorldPoint(e.root, e.shownSurface);
    if (p) e.spot.position.copy(p);
  }
  for (const child of e.markers.children) {
    const surf = child.userData.surface as ViewpointSurface | undefined;
    if (!surf) continue;
    const p = resolveSurfaceWorldPoint(e.root, surf);
    if (p) child.position.copy(p);
  }
}

/** Pose the active clip to an exact frame, re-glue surfaces, render on demand. */
function poseFrame(e: Engine, frame: number) {
  const rc = e.clips[e.activeClipIndex];
  if (!rc || !e.mixer) return;
  e.animTime = clampN(frame, 0, rc.frameCount - 1) / rc.fps;
  e.mixer.setTime(e.animTime);
  e.scene.updateMatrixWorld(true);
  refreshSurfaces(e);
  e.renderer.render(e.scene, e.camera);
}

/** Switch the active AnimationAction (THREE side only; no React state). */
function selectClipInternal(e: Engine, idx: number) {
  const rc = e.clips[idx];
  if (!rc || !e.mixer) return;
  e.mixer.stopAllAction();
  const action = e.mixer.clipAction(rc.clip);
  action.reset();
  action.play();
  e.activeAction = action;
  e.activeClipIndex = idx;
  e.animTime = 0;
}

/** Advance playback by `dt` seconds, honoring direction/speed/loop. Calls back
 *  to mirror the integer frame into React state and to auto-pause at a boundary. */
function advancePlayback(
  e: Engine,
  dt: number,
  onFrame: (f: number) => void,
  onPause: () => void,
) {
  const rc = e.clips[e.activeClipIndex];
  if (!rc || !e.mixer) return;
  const maxT = rc.frameCount > 1 ? (rc.frameCount - 1) / rc.fps : rc.duration;
  let nt = e.animTime + dt * e.speed * e.direction;
  if (e.loop && maxT > 0) {
    nt = ((nt % maxT) + maxT) % maxT;
  } else if (nt >= maxT) {
    nt = maxT;
    e.playing = false;
    onPause();
  } else if (nt <= 0) {
    nt = 0;
    e.playing = false;
    onPause();
  }
  e.animTime = nt;
  e.mixer.setTime(nt);
  e.scene.updateMatrixWorld(true);
  refreshSurfaces(e);
  onFrame(clampN(Math.round(nt * rc.fps), 0, rc.frameCount - 1));
}

interface Engine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  raycaster: THREE.Raycaster;
  root: THREE.Object3D | null;
  sphere: THREE.Sphere;
  markers: THREE.Group;
  spot: THREE.Mesh;
  grid: THREE.GridHelper | null;
  raf: number;
  tweenRaf: number;
  ro: ResizeObserver | null;
  // --- Phase B animation transport --------------------------------------
  mixer: THREE.AnimationMixer | null;
  clips: ResolvedClip[];
  activeClipIndex: number;
  activeAction: THREE.AnimationAction | null;
  playing: boolean;
  direction: number; // +1 forward, -1 reverse
  speed: number; // 1 / 2 / 4 (J/L)
  animTime: number; // seconds within the active clip
  loop: boolean;
  lastTick: number; // perf timestamp of the previous animated frame
  /** The geometry surface currently shown by the spot — re-glued each frame. */
  shownSurface: ViewpointSurface | null;
}

export function ModelViewer({
  src,
  mediaMeta,
  onCaptureViewpoint,
  annotations,
  focusAnchor,
  className,
}: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [spotMode, setSpotMode] = useState(false);
  const spotModeRef = useRef(spotMode);
  spotModeRef.current = spotMode;
  // Screen-mode highlight (camera-relative box) drawn as an HTML overlay.
  const [screenRect, setScreenRect] = useState<ViewpointSurface['rect'] | null>(null);

  // -- Animated-transport state (Phase B). Empty for static models. ----------
  const [clipMetas, setClipMetas] = useState<ClipMeta[]>([]);
  const [clipIndex, setClipIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [loopOn, setLoopOn] = useState(false);
  const animated = clipMetas.length > 0;
  const activeClip = clipMetas[clipIndex];

  // Keep the latest callbacks/props in refs so the long-lived pointer handler
  // (bound once at setup) always sees current values without re-binding.
  const captureRef = useRef(onCaptureViewpoint);
  captureRef.current = onCaptureViewpoint;

  // -- Snapshot the live camera into a serializable anchor camera. -----------
  const snapshotCamera = (): ViewpointCamera => {
    const e = engineRef.current!;
    const c = e.camera;
    const t = e.controls.target;
    return {
      position: [c.position.x, c.position.y, c.position.z],
      target: [t.x, t.y, t.z],
      up: [c.up.x, c.up.y, c.up.z],
      fov: c.fov,
      projection: 'perspective',
    };
  };

  // -- Snapshot the pinned animation moment (omitted for static models). -----
  const snapshotTime = (): ViewpointTime | undefined => {
    const e = engineRef.current;
    if (!e || !e.mixer || e.activeClipIndex < 0) return undefined;
    const rc = e.clips[e.activeClipIndex];
    if (!rc) return undefined;
    const f = clampN(Math.round(e.animTime * rc.fps), 0, rc.frameCount - 1);
    return { clip_id: rc.id, frame: f, time_sec: f / rc.fps, fps: rc.fps };
  };

  // -- Transport handlers (drive the engine + mirror into React state). ------
  const togglePlay = () => {
    const e = engineRef.current;
    if (!e || !e.mixer) return;
    if (e.playing) {
      e.playing = false;
      setPlaying(false);
    } else {
      e.direction = 1;
      e.speed = 1;
      e.lastTick = performance.now();
      e.playing = true;
      setPlaying(true);
    }
  };

  // J = reverse (repeat to speed up), K = pause, L = forward (repeat to speed up).
  const jkl = (key: 'j' | 'k' | 'l') => {
    const e = engineRef.current;
    if (!e || !e.mixer) return;
    if (key === 'k') {
      e.playing = false;
      setPlaying(false);
      return;
    }
    const dir = key === 'l' ? 1 : -1;
    if (e.playing && e.direction === dir) {
      e.speed = Math.min(4, e.speed * 2);
    } else {
      e.direction = dir;
      e.speed = 1;
      e.lastTick = performance.now();
      e.playing = true;
      setPlaying(true);
    }
  };

  const stepFrame = (delta: number) => {
    const e = engineRef.current;
    if (!e || !e.mixer) return;
    e.playing = false;
    setPlaying(false);
    const rc = e.clips[e.activeClipIndex];
    if (!rc) return;
    const cur = Math.round(e.animTime * rc.fps);
    const f = clampN(cur + delta, 0, rc.frameCount - 1);
    poseFrame(e, f);
    setFrame(f);
  };

  const scrubTo = (f: number) => {
    const e = engineRef.current;
    if (!e || !e.mixer) return;
    const rc = e.clips[e.activeClipIndex];
    if (!rc) return;
    const ff = clampN(Math.round(f), 0, rc.frameCount - 1);
    poseFrame(e, ff);
    setFrame(ff);
  };

  const selectClip = (idx: number) => {
    const e = engineRef.current;
    if (!e || !e.mixer || !e.clips[idx]) return;
    selectClipInternal(e, idx);
    e.playing = false;
    poseFrame(e, 0);
    setClipIndex(idx);
    setFrame(0);
    setPlaying(false);
  };

  // -- Frame the camera to the model bounding sphere. ------------------------
  const frameCamera = (sphere: THREE.Sphere) => {
    const e = engineRef.current!;
    const r = sphere.radius > 0 ? sphere.radius : 1;
    const dist = (r / Math.sin((e.camera.fov * Math.PI) / 180 / 2)) * 1.4;
    const dir = new THREE.Vector3(1, 0.65, 1).normalize();
    e.camera.position.copy(sphere.center).add(dir.multiplyScalar(dist));
    e.camera.up.set(0, 1, 0);
    e.camera.near = Math.max(r / 1000, 0.001);
    e.camera.far = dist + r * 12;
    e.camera.updateProjectionMatrix();
    e.controls.target.copy(sphere.center);
    e.controls.update();
  };

  // -- Tween camera back to a remembered view, then resolve its spot. --------
  const focusTo = (anchor: ViewpointAnchor | null | undefined) => {
    const e = engineRef.current;
    if (!e || !anchor) return;
    const cam = anchor.camera;

    // Animated note: select the clip + scrub to the pinned frame BEFORE resolving
    // the surface, so the spot lands on the deformed geometry at that frame.
    const t = anchor.time;
    if (t && e.mixer && e.clips.length) {
      let idx = e.clips.findIndex((c) => c.id === t.clip_id);
      if (idx < 0) idx = Math.max(0, e.activeClipIndex);
      if (idx !== e.activeClipIndex) selectClipInternal(e, idx);
      const rc = e.clips[idx];
      if (rc) {
        const f = clampN(
          t.frame != null ? Math.round(t.frame) : Math.round((t.time_sec ?? 0) * rc.fps),
          0,
          rc.frameCount - 1,
        );
        e.playing = false;
        poseFrame(e, f);
        setClipIndex(idx);
        setFrame(f);
        setPlaying(false);
      }
    }

    const placeSpot = () => {
      // After arriving, resolve + show the surface highlight. Remember the surface
      // so the render loop re-glues it to the deformed mesh while scrubbing/playing.
      e.shownSurface = anchor.surface?.mode === 'geometry' ? anchor.surface : null;
      if (anchor.surface?.mode === 'geometry' && e.root) {
        const p = resolveSurfaceWorldPoint(e.root, anchor.surface);
        if (p) {
          const radius = anchor.surface.radius ?? e.sphere.radius * 0.025;
          e.spot.scale.setScalar(Math.max(radius, e.sphere.radius * 0.004));
          e.spot.position.copy(p);
          e.spot.visible = true;
          setScreenRect(null);
          return;
        }
      }
      e.spot.visible = false;
      setScreenRect(anchor.surface?.mode === 'screen' ? anchor.surface.rect ?? null : null);
    };

    if (!cam || typeof cam === 'string') {
      placeSpot();
      return;
    }

    cancelAnimationFrame(e.tweenRaf);
    const fromPos = e.camera.position.clone();
    const fromTarget = e.controls.target.clone();
    const fromUp = e.camera.up.clone();
    const fromFov = e.camera.fov;
    const toPos = new THREE.Vector3(...cam.position);
    const toTarget = new THREE.Vector3(...cam.target);
    const toUp = new THREE.Vector3(...cam.up);
    const toFov = cam.fov ?? fromFov;
    const start = performance.now();
    const dur = 400;
    e.controls.enabled = false;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      // easeInOutQuad — no animation dep.
      const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      e.camera.position.lerpVectors(fromPos, toPos, k);
      e.controls.target.lerpVectors(fromTarget, toTarget, k);
      e.camera.up.lerpVectors(fromUp, toUp, k).normalize();
      e.camera.fov = fromFov + (toFov - fromFov) * k;
      e.camera.updateProjectionMatrix();
      e.controls.update();
      if (t < 1) {
        e.tweenRaf = requestAnimationFrame(step);
      } else {
        e.controls.enabled = true;
        placeSpot();
      }
    };
    e.tweenRaf = requestAnimationFrame(step);
  };
  const focusRef = useRef(focusTo);
  focusRef.current = focusTo;

  // -- One-time scene setup + teardown. --------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: setup runs once
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b0f);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    camera.position.set(3, 2, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const hemi = new THREE.HemisphereLight(0xffffff, 0x33343a, 1.1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(4, 6, 3);
    scene.add(dir);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const markers = new THREE.Group();
    scene.add(markers);

    // The focus / spot highlight (a unit sphere we scale + position).
    const spot = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.85 }),
    );
    spot.visible = false;
    spot.renderOrder = 2;
    scene.add(spot);

    const engine: Engine = {
      scene,
      camera,
      renderer,
      controls,
      raycaster: new THREE.Raycaster(),
      root: null,
      sphere: new THREE.Sphere(new THREE.Vector3(), 1),
      markers,
      spot,
      grid: null,
      raf: 0,
      tweenRaf: 0,
      ro: null,
      mixer: null,
      clips: [],
      activeClipIndex: -1,
      activeAction: null,
      playing: false,
      direction: 1,
      speed: 1,
      animTime: 0,
      loop: false,
      lastTick: 0,
      shownSurface: null,
    };
    engineRef.current = engine;

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    engine.ro = ro;

    // Pointer: distinguish an orbit-drag from a click; on click, either pick a
    // surface spot (spot mode) or focus an annotation marker.
    let downX = 0;
    let downY = 0;
    let downT = 0;
    const onDown = (ev: PointerEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
      downT = performance.now();
    };
    const onUp = (ev: PointerEvent) => {
      const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
      if (moved > 5 || performance.now() - downT > 500) return; // it was a drag
      const rect = renderer.domElement.getBoundingClientRect();
      const nx = (ev.clientX - rect.left) / rect.width;
      const ny = (ev.clientY - rect.top) / rect.height;
      const ndc = new THREE.Vector2(nx * 2 - 1, -(ny * 2) + 1);
      engine.raycaster.setFromCamera(ndc, camera);

      if (!spotModeRef.current) {
        // Marker focus.
        const mHits = engine.raycaster.intersectObjects(markers.children, false);
        const hitMarker = mHits[0]?.object;
        const anchor = hitMarker?.userData?.anchor as ViewpointAnchor | undefined;
        if (anchor) focusRef.current(anchor);
        return;
      }

      // Spot mode: raycast against the model meshes.
      const meshes: THREE.Object3D[] = [];
      engine.root?.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o);
      });
      const hits = engine.raycaster.intersectObjects(meshes, false);
      const hit = hits[0];
      let surface: ViewpointSurface;
      if (hit?.face && hit.faceIndex != null) {
        const mesh = hit.object as THREE.Mesh;
        const local = mesh.worldToLocal(hit.point.clone());
        const radius = Math.max(engine.sphere.radius * 0.025, 1e-4);
        surface = {
          mode: 'geometry',
          node: nodePathOf(mesh),
          primitive: 0,
          tri: hit.faceIndex,
          // Skinned-aware: bary against the POSED triangle so it re-resolves at
          // any frame; for a rigid mesh this is the static barycentric.
          bary: barycentricPosed(mesh, hit.face, hit.point),
          local_point: [local.x, local.y, local.z],
          radius,
        };
        // Immediate visual feedback at the picked point; keep it glued while scrubbing.
        engine.shownSurface = surface;
        spot.scale.setScalar(radius);
        spot.position.copy(hit.point);
        spot.visible = true;
        setScreenRect(null);
      } else {
        // Raycast missed (or no index) → screen-space box fallback.
        surface = {
          mode: 'screen',
          rect: {
            x: Number(clamp01(nx - 0.07).toFixed(4)),
            y: Number(clamp01(ny - 0.05).toFixed(4)),
            w: 0.14,
            h: 0.1,
          },
        };
        engine.shownSurface = null;
        spot.visible = false;
        setScreenRect(surface.rect ?? null);
      }
      const time = snapshotTime();
      captureRef.current?.({
        type: 'viewpoint',
        camera: snapshotCamera(),
        surface,
        ...(time ? { time } : {}),
      });
      setSpotMode(false);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    const loop = (now?: number) => {
      engine.raf = requestAnimationFrame(loop);
      controls.update();
      if (engine.mixer && engine.playing) {
        const t = now ?? performance.now();
        const dt = engine.lastTick ? (t - engine.lastTick) / 1000 : 0;
        engine.lastTick = t;
        advancePlayback(engine, dt, setFrame, () => setPlaying(false));
      } else {
        engine.lastTick = now ?? performance.now();
      }
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(engine.raf);
      cancelAnimationFrame(engine.tweenRaf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose();
      // Dispose everything in the scene graph.
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      engineRef.current = null;
    };
  }, []);

  // -- Load (or reload) the GLB when src changes. ----------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable helpers/refs
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !src) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReady(false);

    // Tear down any prior animation transport before swapping models.
    if (e.mixer) {
      e.mixer.stopAllAction();
      if (e.root) e.mixer.uncacheRoot(e.root as THREE.Object3D);
    }
    e.mixer = null;
    e.clips = [];
    e.activeAction = null;
    e.activeClipIndex = -1;
    e.playing = false;
    e.animTime = 0;
    e.shownSurface = null;
    setClipMetas([]);
    setClipIndex(0);
    setFrame(0);
    setPlaying(false);

    // Remove any previously-loaded model.
    if (e.root) {
      e.scene.remove(e.root);
      e.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
      e.root = null;
    }
    e.spot.visible = false;
    setScreenRect(null);

    const loader = new GLTFLoader();
    // Decode meshopt-compressed proxies (MIT decoder bundled with three).
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      src,
      (gltf) => {
        if (cancelled || !engineRef.current) return;
        const root = gltf.scene;
        e.scene.add(root);
        e.root = root;
        root.updateWorldMatrix(true, true);

        const box = new THREE.Box3().setFromObject(root);
        const sphere = new THREE.Sphere();
        box.getBoundingSphere(sphere);
        if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) sphere.radius = 1;
        e.sphere.copy(sphere);

        // Subtle ground grid sized to the model, seated at its base.
        if (e.grid) {
          e.scene.remove(e.grid);
          e.grid.geometry.dispose();
          (e.grid.material as THREE.Material).dispose();
        }
        const gridSize = sphere.radius * 6;
        const grid = new THREE.GridHelper(gridSize, 20, 0x444450, 0x2a2a33);
        grid.position.set(sphere.center.x, box.min.y, sphere.center.z);
        (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.4;
        e.scene.add(grid);
        e.grid = grid;

        frameCamera(sphere);

        // -- Animation transport (Phase B). Build an AnimationMixer when the
        //    proxy carries clips, mapping each media_meta descriptor to its glTF
        //    clip by index (name match as fallback). ----------------------------
        const gltfClips = gltf.animations ?? [];
        const metaAnims = mediaMeta?.animations ?? [];
        if ((mediaMeta?.has_animation || gltfClips.length > 0) && gltfClips.length > 0) {
          const mixer = new THREE.AnimationMixer(root);
          const resolved: ResolvedClip[] = gltfClips.map((clip, i) => {
            const meta =
              metaAnims[i] ?? metaAnims.find((m) => m.name && m.name === clip.name);
            const fps = meta?.fps && meta.fps > 0 ? meta.fps : 30;
            const frameCount =
              meta?.frame_count && meta.frame_count > 0
                ? meta.frame_count
                : Math.max(1, Math.round(clip.duration * fps) + 1);
            return {
              id: meta?.id ?? `anim_${i}`,
              name: meta?.name ?? clip.name ?? `Clip ${i + 1}`,
              fps,
              frameCount,
              duration: meta?.duration_sec ?? clip.duration,
              clip,
            };
          });
          e.mixer = mixer;
          e.clips = resolved;
          selectClipInternal(e, 0);
          e.playing = false;
          mixer.setTime(0);
          e.scene.updateMatrixWorld(true);
          setClipMetas(
            resolved.map((r) => ({
              id: r.id,
              name: r.name,
              fps: r.fps,
              frameCount: r.frameCount,
              duration: r.duration,
            })),
          );
          setClipIndex(0);
          setFrame(0);
          setPlaying(false);
        }

        setLoading(false);
        setReady(true);
      },
      undefined,
      (err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to load 3D model.');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [src]);

  // -- (Re)build annotation markers when annotations or the model change. -----
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !ready) return;
    // Clear existing markers.
    for (const child of [...e.markers.children]) {
      e.markers.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    }
    const markerR = Math.max(e.sphere.radius * 0.018, 1e-4);
    for (const ann of annotations ?? []) {
      const surface = ann.anchor?.surface;
      if (!surface || surface.mode !== 'geometry' || !e.root) continue;
      const p = resolveSurfaceWorldPoint(e.root, surface);
      if (!p) continue;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(markerR, 16, 12),
        new THREE.MeshBasicMaterial({
          color: ann.resolved ? 0x6b7280 : 0x3b82f6,
          transparent: true,
          opacity: 0.9,
        }),
      );
      marker.position.copy(p);
      marker.userData.anchor = ann.anchor;
      // Stored so the render loop can re-glue skinned markers to the live pose.
      marker.userData.surface = surface;
      marker.renderOrder = 1;
      e.markers.add(marker);
    }
  }, [annotations, ready]);

  // -- Fly to a focused annotation when the page sets focusAnchor. ------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusRef is stable
  useEffect(() => {
    if (!ready || !focusAnchor) return;
    focusRef.current(focusAnchor);
  }, [focusAnchor, ready]);

  // Mirror the loop toggle onto the engine (read by the render loop).
  useEffect(() => {
    const e = engineRef.current;
    if (e) e.loop = loopOn;
  }, [loopOn]);

  // -- Keyboard transport: J/K/L, ',' / '.' frame step, space = play/pause. ---
  // biome-ignore lint/correctness/useExhaustiveDependencies: handlers read live refs
  useEffect(() => {
    if (!animated) return;
    const onKey = (ev: KeyboardEvent) => {
      const tgt = ev.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
        return;
      }
      switch (ev.key) {
        case 'j':
        case 'J':
          jkl('j');
          break;
        case 'k':
        case 'K':
          jkl('k');
          break;
        case 'l':
        case 'L':
          jkl('l');
          break;
        case ',':
          stepFrame(-1);
          break;
        case '.':
          stepFrame(1);
          break;
        case ' ':
          togglePlay();
          break;
        default:
          return;
      }
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [animated]);

  const btn =
    'inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs font-medium text-white/90 backdrop-blur hover:bg-black/60';

  return (
    <div className={cn('relative aspect-video w-full bg-[#0b0b0f]', className)}>
      <div ref={hostRef} className="absolute inset-0" />

      {/* Screen-mode highlight overlay (camera-relative box). */}
      {screenRect && (
        <div
          className="absolute border-2 border-amber-400 bg-amber-400/15 pointer-events-none"
          style={{
            left: `${screenRect.x * 100}%`,
            top: `${screenRect.y * 100}%`,
            width: `${screenRect.w * 100}%`,
            height: `${screenRect.h * 100}%`,
          }}
        />
      )}

      {/* Loading / error states. */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/70">
          <p>{error}</p>
          <p className="text-xs text-white/40">The proxy may still be processing — download the original to view.</p>
        </div>
      )}

      {/* Bottom controls: animated transport (§7.3) above the viewport toolbar. */}
      {ready && (
        <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2">
          {/* Animated transport — mirrors the video player's vocabulary. */}
          {animated && activeClip && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-white/15 bg-black/50 px-2 py-1.5 backdrop-blur">
              <button
                type="button"
                className={btn}
                title="Reverse / faster (J)"
                onClick={() => jkl('j')}
              >
                <Rewind className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className={btn}
                title="Previous frame (,)"
                onClick={() => stepFrame(-1)}
              >
                <StepBack className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className={cn(btn, playing && 'border-amber-400 bg-amber-500/30 text-white')}
                title={playing ? 'Pause (K / space)' : 'Play (L / space)'}
                onClick={togglePlay}
              >
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className={btn}
                title="Next frame (.)"
                onClick={() => stepFrame(1)}
              >
                <StepForward className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className={btn}
                title="Forward / faster (L)"
                onClick={() => jkl('l')}
              >
                <FastForward className="h-3.5 w-3.5" />
              </button>

              <input
                type="range"
                min={0}
                max={Math.max(0, activeClip.frameCount - 1)}
                step={1}
                value={frame}
                onChange={(ev) => scrubTo(Number(ev.target.value))}
                className="h-1.5 flex-1 min-w-[6rem] cursor-pointer accent-amber-400"
                aria-label="Scrub animation"
              />

              <span className="tabular-nums text-[11px] text-white/80">
                f{frame} / {activeClip.frameCount} · {activeClip.fps}fps
              </span>

              {clipMetas.length > 1 && (
                <select
                  value={clipIndex}
                  onChange={(ev) => selectClip(Number(ev.target.value))}
                  title="Animation clip"
                  className="rounded-md border border-white/15 bg-black/40 px-1.5 py-1 text-[11px] text-white/90 outline-none"
                >
                  {clipMetas.map((c, i) => (
                    <option key={c.id} value={i} className="text-black">
                      {c.name}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                aria-pressed={loopOn}
                className={cn(btn, loopOn && 'border-amber-400 bg-amber-500/30 text-white')}
                title="Loop the clip"
                onClick={() => setLoopOn((v) => !v)}
              >
                <Repeat className="h-3.5 w-3.5" /> Loop
              </button>
            </div>
          )}

          {/* Viewport toolbar (§7.5): reset · remember viewpoint · spot. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btn}
              title="Reset view"
              onClick={() => {
                const e = engineRef.current;
                if (e) frameCamera(e.sphere);
                setSpotMode(false);
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset view
            </button>
            <button
              type="button"
              className={btn}
              title="Remember this viewpoint as the anchor for a note"
              onClick={() => {
                if (!engineRef.current) return;
                setSpotMode(false);
                engineRef.current.spot.visible = false;
                engineRef.current.shownSurface = null;
                setScreenRect(null);
                const time = snapshotTime();
                captureRef.current?.({
                  type: 'viewpoint',
                  camera: snapshotCamera(),
                  ...(time ? { time } : {}),
                });
              }}
            >
              <Maximize2 className="h-3.5 w-3.5" /> Remember viewpoint
            </button>
            <button
              type="button"
              aria-pressed={spotMode}
              className={cn(btn, spotMode && 'border-amber-400 bg-amber-500/30 text-white')}
              title="Click the surface to anchor a spot"
              onClick={() => setSpotMode((s) => !s)}
            >
              <Crosshair className="h-3.5 w-3.5" /> {spotMode ? 'Click the model…' : 'Spot'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ModelViewer;
