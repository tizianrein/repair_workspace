/**
 * The artefact, as each participant recorded it.
 *
 * Members are boxes in the workspace's own coordinates; a member is coloured by
 * what was actually observed on it, so a beam carrying a confirmed condition
 * reads red without anyone having had to set a status by hand.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The workspace palette, so a member reads the same colour here as it does
// in the app the participants used.
export const STATUS_COLOR = {
  intact:    0xd0d0d0,
  suspected: 0xe8a33d,
  defective: 0xff4d4d,
  missing:   0xffde59,
  repaired:  0x97c459,
  new:       0xc000ff,
  discarded: 0x111111,
};

const OPACITY = { intact: 0.55, suspected: 0.78, defective: 0.78, missing: 0.5, repaired: 0.75, new: 0.75, discarded: 0.15 };

export function createViewer({ canvas, wrap, onPickPart, onPickCondition, onHover }) {
  const scene = new THREE.Scene();
  const world = new THREE.Group();          // parts + markers, centred as a unit
  scene.add(world);
  const partGroup = new THREE.Group();
  const markerGroup = new THREE.Group();
  const scanGroup = new THREE.Group();
  world.add(partGroup, markerGroup, scanGroup);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.9;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.panSpeed = 0.9;
  // One finger turns it, two fingers pinch to zoom and drag to move it.
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  scene.add(new THREE.AmbientLight(0xffffff, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(2, 3.5, 2);
  scene.add(key);

  const outlineMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.55 });

  // With the scan on, the boxes drop away and the outline is all that is left,
  // so the outline carries the member's condition instead of the fill.
  const statusOutline = new Map();
  function outlineFor(status) {
    if (status === 'intact') return outlineMat;
    if (!statusOutline.has(status)) {
      statusOutline.set(status, new THREE.LineBasicMaterial({
        color: STATUS_COLOR[status] ?? STATUS_COLOR.intact, transparent: true, opacity: 0.95,
      }));
    }
    return statusOutline.get(status);
  }
  const dimOutline = new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.14 });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const labelLayer = document.createElement('div');
  Object.assign(labelLayer.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', display: 'none',
  });
  wrap.appendChild(labelLayer);

  let partMeshes = [];
  let markers = [];
  let labels = [];
  let exploded = false;
  let showLabels = false;
  let homeTarget = new THREE.Vector3();
  let homeDistance = 4;
  let radius = 1;
  let worldBox = null;
  let fitPoints = [];
  let anchor = null;
  let framed = false;
  let highlight = null;          // Set of part ids emphasised by a chosen strategy
  let selectedPart = null;
  let scanRoot = null;
  let scanMode = false;

  const matCache = new Map();
  function material(status, emphasis) {
    const k = `${status}|${emphasis}`;
    if (matCache.has(k)) return matCache.get(k);
    const base = STATUS_COLOR[status] ?? STATUS_COLOR.intact;
    const m = new THREE.MeshLambertMaterial({
      color: base,
      transparent: true,
      opacity: emphasis === 'dim' ? 0.12 : (OPACITY[status] ?? 0.6),
      depthWrite: emphasis !== 'dim',
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    if (emphasis === 'on') m.emissive = new THREE.Color(base).multiplyScalar(0.35);
    matCache.set(k, m);
    return m;
  }

  // ------------------------------------------------------------- build ---
  function setModel(parts, conditions, opts = {}) {
    // Measure in an un-offset frame. setFromObject reports WORLD bounds, so
    // measuring while the previous centring offset was still applied fed that
    // offset back in and the artefact crept further off-centre on every switch.
    world.position.set(0, 0, 0);
    world.updateMatrixWorld(true);

    partGroup.clear(); markerGroup.clear();
    labelLayer.replaceChildren();
    partMeshes = []; markers = []; labels = []; fitPoints = [];
    selectedPart = null;
    highlight = opts.highlightParts ? new Set(opts.highlightParts) : null;

    for (const p of parts) {
      const d = p.dimensions || {};
      const geo = new THREE.BoxGeometry(d.width || 0.1, d.height || 0.1, d.depth || 0.1);
      const mesh = new THREE.Mesh(geo, material(p.status || 'intact', 'base'));
      const o = p.origin || {};
      mesh.position.set(o.x || 0, o.y || 0, o.z || 0);
      const r = p.rotation || {};
      mesh.rotation.set(r.x || 0, r.y || 0, r.z || 0, 'YXZ');
      mesh.userData.part = p;
      mesh.userData.home = mesh.position.clone();
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), outlineMat));
      partGroup.add(mesh);
      partMeshes.push(mesh);

      // Framing uses the members themselves. The assembly's axis-aligned box
      // is mostly air for an L-shaped corner, and fitting it leaves the model
      // small in the middle of the canvas.
      mesh.updateMatrixWorld(true);
      const hw = (d.width || .1) / 2, hh = (d.height || .1) / 2, hd = (d.depth || .1) / 2;
      for (let i = 0; i < 8; i++) {
        fitPoints.push(new THREE.Vector3(i & 1 ? hw : -hw, i & 2 ? hh : -hh, i & 4 ? hd : -hd)
          .applyMatrix4(mesh.matrixWorld));
      }

      const el = document.createElement('div');
      el.className = 'part-label';
      el.textContent = p.id;
      labelLayer.appendChild(el);
      labels.push({ el, mesh });
    }

    const box = new THREE.Box3().setFromObject(partGroup);
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());

    // Anchor on the first model and never move again. Every participant's model
    // describes the same physical corner, so switching between them must not
    // shift the artefact or disturb the camera.
    if (!anchor) anchor = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    world.position.copy(anchor).negate();
    world.updateMatrixWorld(true);

    const extent = Math.max(size.x, size.y, size.z, 0.2);
    radius = box.isEmpty() ? 1 : box.getBoundingSphere(new THREE.Sphere()).radius;
    worldBox = box.isEmpty() ? null : box;
    homeTarget = new THREE.Vector3(0, 0, 0);

    const r = extent * 0.02;
    const sphere = new THREE.SphereGeometry(r, 20, 14);
    for (const c of conditions) {
      if (!c.coordinates) continue;
      const colour = c.status === 'refuted' ? 0x8a8a83 : (c.status === 'confirmed' ? 0xff1744 : 0xb87a00);
      const dot = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: colour }));
      const ghost = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false,
      }));
      ghost.renderOrder = 999;
      dot.position.set(c.coordinates.x || 0, c.coordinates.y || 0, c.coordinates.z || 0);
      ghost.position.copy(dot.position);
      dot.userData.condition = c; ghost.userData.condition = c;
      markerGroup.add(dot, ghost);
      markers.push(dot);
    }

    // Only frame on the first model. Re-framing on every participant switch is
    // what made the camera jump.
    if (!framed) { resetView(); framed = true; }
  }

  function setHighlight(partIds) {
    highlight = partIds && partIds.length ? new Set(partIds) : null;
    applyMaterials();
  }

  function applyMaterials() {
    for (const m of partMeshes) {
      const p = m.userData.part;
      let emphasis = 'base';
      // With the scan visible the boxes are in the way: drop them to outlines
      // so the conditions read against the real timber.
      if (scanMode) emphasis = 'dim';
      else if (selectedPart && p.id === selectedPart) emphasis = 'on';
      else if (highlight) emphasis = highlight.has(p.id) ? 'on' : 'dim';
      m.material = material(p.status || 'intact', emphasis);
      m.children[0].material = scanMode ? outlineFor(p.status || 'intact')
        : (emphasis === 'dim' ? dimOutline : outlineMat);
    }
  }

  function selectPart(id) { selectedPart = id; applyMaterials(); }

  // ------------------------------------------------------------ camera ---
  const VIEW_DIR = new THREE.Vector3(0.78, 0.44, 0.78).normalize();

  /**
   * Frame the assembly exactly.
   *
   * A bounding-sphere fit leaves a flat object like this frame small and
   * off-centre in a portrait canvas. Instead: project the eight corners of the
   * box into the camera's own basis, pan the target until they sit symmetric,
   * and pull back only as far as the widest corner needs. Two passes converge.
   */
  function fitView() {
    if (!fitPoints.length) return { target: new THREE.Vector3(), distance: 4 };
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * Math.max(camera.aspect, 0.2);

    const forward = VIEW_DIR.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const c = new THREE.Vector3();
    const corners = fitPoints.map(p => {
      c.copy(p).add(world.position);
      return { u: c.dot(right), v: c.dot(up), w: c.dot(forward) };
    });
    if (!corners.length) return { target: new THREE.Vector3(), distance: 4 };

    let cu = (Math.min(...corners.map(p => p.u)) + Math.max(...corners.map(p => p.u))) / 2;
    let cv = (Math.min(...corners.map(p => p.v)) + Math.max(...corners.map(p => p.v))) / 2;
    const cw = (Math.min(...corners.map(p => p.w)) + Math.max(...corners.map(p => p.w))) / 2;
    let d = radius * 3;

    for (let pass = 0; pass < 3; pass++) {
      d = 0;
      for (const p of corners) {
        d = Math.max(d, (p.w - cw) + Math.abs(p.u - cu) / tanH,
                        (p.w - cw) + Math.abs(p.v - cv) / tanV);
      }
      d *= 1.12;
      // Perspective makes near corners spread wider; re-centre on what is drawn.
      let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
      for (const p of corners) {
        const depth = d - (p.w - cw);
        lo = Math.min(lo, (p.u - cu) / depth); hi = Math.max(hi, (p.u - cu) / depth);
        lo2 = Math.min(lo2, (p.v - cv) / depth); hi2 = Math.max(hi2, (p.v - cv) / depth);
      }
      cu += ((lo + hi) / 2) * d;
      cv += ((lo2 + hi2) / 2) * d;
    }

    const target = right.clone().multiplyScalar(cu)
      .add(up.clone().multiplyScalar(cv))
      .add(forward.clone().multiplyScalar(cw));
    return { target, distance: Math.max(d, radius * 0.4) };
  }

  function resetView() {
    const fit = fitView();
    homeTarget = fit.target;
    homeDistance = fit.distance;
    controls.target.copy(homeTarget);
    camera.position.copy(homeTarget).add(VIEW_DIR.clone().multiplyScalar(homeDistance));
    camera.near = homeDistance / 400; camera.far = homeDistance * 40;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function frameOn(vec3) {
    const target = vec3.clone().add(world.position);
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(target);
    camera.position.copy(target).add(dir.multiplyScalar(Math.max(radius * 0.75, homeDistance * 0.32)));
    controls.update();
  }

  function focusPart(id) {
    const m = partMeshes.find(x => x.userData.part.id === id);
    if (m) { selectPart(id); frameOn(m.userData.home); }
  }

  function focusCondition(id) {
    const m = markers.find(x => x.userData.condition.id === id);
    if (m) frameOn(m.position);
  }

  function toggleExplode() {
    exploded = !exploded;
    return exploded;
  }

  function toggleLabels() {
    showLabels = !showLabels;
    labelLayer.style.display = showLabels ? 'block' : 'none';
    return showLabels;
  }

  // -------------------------------------------------------------- scan ---
  async function showScan(url, onProgress) {
    if (!scanRoot) {
      const loader = new GLTFLoader();
      const gltf = await new Promise((res, rej) => loader.load(url, res, onProgress, rej));
      scanRoot = gltf.scene;
      scanGroup.add(scanRoot);
    }
    scanRoot.visible = true;
    scanMode = true;
    applyMaterials();
    return true;
  }

  function hideScan() {
    if (scanRoot) scanRoot.visible = false;
    scanMode = false;
    applyMaterials();
  }

  // ---------------------------------------------------------- picking ---
  function hits(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const onMarker = raycaster.intersectObjects(markerGroup.children, false);
    if (onMarker.length) return { type: 'condition', data: onMarker[0].object.userData.condition, ev };

    // Condition markers are a couple of centimetres across on a two-metre
    // frame, which is a few pixels on a phone. Accept the nearest one within
    // a fingertip of the tap before falling through to the member behind it.
    const tol = ev.pointerType === 'touch' ? 30 : 12;
    let best = null, bestD = Infinity;
    const v2 = new THREE.Vector3();
    for (const m of markers) {
      v2.copy(m.position).add(world.position).project(camera);
      if (v2.z > 1) continue;
      const sx = (v2.x * 0.5 + 0.5) * rect.width;
      const sy = (-v2.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - (ev.clientX - rect.left), sy - (ev.clientY - rect.top));
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best && bestD <= tol) return { type: 'condition', data: best.userData.condition, ev };

    const onPart = raycaster.intersectObjects(partMeshes, false);
    if (onPart.length) return { type: 'part', data: onPart[0].object.userData.part, ev };
    return null;
  }

  let userMoved = false;
  controls.addEventListener('start', () => { userMoved = true; });

  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return;
    const hit = hits(e);
    if (!hit) { selectPart(null); onHover?.(null); return; }
    if (hit.type === 'condition') onPickCondition?.(hit.data);
    else { selectPart(hit.data.id); onPickPart?.(hit.data); }
  });
  renderer.domElement.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    onHover?.(hits(e));
  });
  renderer.domElement.addEventListener('pointerleave', () => onHover?.(null));

  // ---------------------------------------------------------- run loop ---
  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved) resetView();
  }
  new ResizeObserver(resize).observe(wrap);
  resize();

  const v = new THREE.Vector3();
  function tick() {
    requestAnimationFrame(tick);
    for (const m of partMeshes) {
      const home = m.userData.home;
      const goal = exploded ? home.clone().multiplyScalar(1.45) : home;
      m.position.lerp(goal, 0.12);
    }
    controls.update();
    renderer.render(scene, camera);

    if (showLabels) {
      const rect = wrap.getBoundingClientRect();
      for (const { el, mesh } of labels) {
        v.copy(mesh.position).add(world.position).project(camera);
        const visible = v.z < 1;
        el.style.display = visible ? 'block' : 'none';
        if (visible) {
          el.style.left = `${(v.x * 0.5 + 0.5) * rect.width}px`;
          el.style.top = `${(-v.y * 0.5 + 0.5) * rect.height}px`;
        }
      }
    }
  }
  tick();

  return { setModel, setHighlight, selectPart, focusPart, focusCondition, resetView, toggleExplode, toggleLabels, showScan, hideScan };
}
