/**
 * 3D viewer view.
 *
 * Reads from workspace.instance.parts. Renders each part as a BoxGeometry with
 * status-colored material plus an outline. Renders each hypothesis at its
 * coordinates as a small red sphere. Click → open detail modal.
 *
 * Lazy-initialized when the 3D tab is first activated — Three.js + a WebGL
 * context is expensive to bring up on page load, especially on mobile.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const materials = {
  intact: new THREE.MeshBasicMaterial({ color: 0xd0d0d0, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.FrontSide }),
  defective: new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.FrontSide }),
  missing: new THREE.MeshBasicMaterial({ color: 0xffde59, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.FrontSide }),
  new: new THREE.MeshBasicMaterial({ color: 0xc000ff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.FrontSide }),
  repaired: new THREE.MeshBasicMaterial({ color: 0x97c459, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.FrontSide }),
  discarded: new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.FrontSide }),
  selected: new THREE.MeshBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.FrontSide }),
  outline: new THREE.LineBasicMaterial({ color: 0x1a1a1a }),
  hypothesis: new THREE.MeshBasicMaterial({ color: 0xff1744, transparent: true, opacity: 0.95 }),
  hypothesisGhost: new THREE.MeshBasicMaterial({ color: 0xff1744, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false }),
  selectedHypothesis: new THREE.MeshBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.95 }),
  selectedHypothesisGhost: new THREE.MeshBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false })
};

export function createViewer3D(canvas, infoBox, onSelect) {
  const wrap = canvas.parentElement;
  let scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfdfcf9);
  const objectGroup = new THREE.Group();
  scene.add(objectGroup);
  const partMeshes = new Map();
  const hypSpheres = [];
  let activeAnims = [];
  const ANIM_MS = 700;

  const camera = new THREE.PerspectiveCamera(28, wrap.clientWidth / wrap.clientHeight, 0.01, 1000);
  camera.position.set(-1.5, 1.2, -1.5);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.autoClear = false;
  renderer.sortObjects = true;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(2, 3, 2);
  scene.add(dir);

  const axesScene = new THREE.Scene();
  const axesCamera = new THREE.OrthographicCamera(-2.5, 2.5, 2.5, -2.5, -10, 10);
  axesScene.add(new THREE.AxesHelper(1.5));

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let exploded = false;
  let selection = { partId: null, hypothesisId: null };
  let downPos = null;

  function materialForPart(status) { return materials[status] || materials.intact; }

  function rebuild(workspace) {
    while (objectGroup.children.length) objectGroup.remove(objectGroup.children[0]);
    partMeshes.clear();
    (workspace.instance?.parts || []).forEach(part => {
      const d = part.dimensions || {};
      const geo = new THREE.BoxGeometry(d.width || 0.1, d.height || 0.1, d.depth || 0.1);
      const mesh = new THREE.Mesh(geo, materialForPart(part.status));
      const o = part.origin || { x: 0, y: 0, z: 0 };
      mesh.position.set(o.x || 0, o.y || 0, o.z || 0);
      if (part.rotation) mesh.rotation.set(part.rotation.x || 0, part.rotation.y || 0, part.rotation.z || 0, 'YXZ');
      mesh.userData.part = part;
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), materials.outline));
      objectGroup.add(mesh);
      partMeshes.set(part.id, mesh);
    });

    // Compute scale from the object's bounding box, after parts are added
    const objBox = new THREE.Box3().setFromObject(objectGroup);
    const objSize = objBox.isEmpty() ? new THREE.Vector3(1, 1, 1) : objBox.getSize(new THREE.Vector3());
    const objExtent = Math.max(objSize.x, objSize.y, objSize.z, 0.1);
    const sphereRadius = objExtent * 0.025;   // 2.5% of largest dimension
    const outlineRadius = sphereRadius * 1.03;

    hypSpheres.forEach(s => scene.remove(s));
    hypSpheres.length = 0;
    (workspace.hypotheses || []).forEach(h => {
      if (!h.coordinates) return;
      const geo = new THREE.SphereGeometry(sphereRadius, 18, 18);
      const sphere = new THREE.Mesh(geo, materials.hypothesis);
      sphere.position.set(h.coordinates.x || 0, h.coordinates.y || 0, h.coordinates.z || 0);
      sphere.userData.hypothesis = h;

      const ghost = new THREE.Mesh(geo, materials.hypothesisGhost);
      ghost.renderOrder = 999;
      ghost.userData.hypothesisGhost = true;
      sphere.add(ghost);

      hypSpheres.push(sphere);
      scene.add(sphere);
    });

    applySelection();
  }

  function frame() {
    const box = new THREE.Box3().setFromObject(objectGroup);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const fov = camera.fov * Math.PI / 180;
    let distance = maxDim / (2 * Math.tan(fov / 1.2));
    distance *= 1.8;
    const lookDir = new THREE.Vector3(-1, 0.5, -1).normalize();
    camera.position.copy(lookDir.multiplyScalar(distance).add(center));
    controls.target.copy(center);
    controls.update();
  }

  function applySelection() {
    partMeshes.forEach((mesh, id) => {
      mesh.material = id === selection.partId ? materials.selected : materialForPart(mesh.userData.part.status);
    });
    hypSpheres.forEach(s => {
      const isSelected = s.userData.hypothesis.id === selection.hypothesisId;
      s.material = isSelected ? materials.selectedHypothesis : materials.hypothesis;
      // First child is the ghost overlay
      const ghost = s.children.find(c => c.userData.hypothesisGhost);
      if (ghost) ghost.material = isSelected ? materials.selectedHypothesisGhost : materials.hypothesisGhost;
    });
    updateInfoBox();
  }

  function updateInfoBox(hoverHit = null) {
    if (selection.partId) {
      const p = (currentWorkspace?.instance?.parts || []).find(x => x.id === selection.partId);
      if (p) {
        const d = p.dimensions || {};
        const w = Math.round((d.width || 0) * 1000) / 10;
        const h = Math.round((d.height || 0) * 1000) / 10;
        const dp = Math.round((d.depth || 0) * 1000) / 10;
        infoBox.textContent = `Part: ${p.id}\nStatus: ${p.status}\nSize: ${w} × ${h} × ${dp} cm`;
        return;
      }
    }
    if (selection.hypothesisId) {
      const h = (currentWorkspace?.hypotheses || []).find(x => x.id === selection.hypothesisId);
      if (h) {
        infoBox.textContent = `Condition: ${h.type}\nStatus: ${h.status}\nPart: ${h.partRef || '—'}\n${h.description || ''}`;
        return;
      }
    }
    if (hoverHit) {
      if (hoverHit.type === 'part') infoBox.textContent = `${hoverHit.data.id} (${hoverHit.data.status})`;
      else infoBox.textContent = `${hoverHit.data.type} on ${hoverHit.data.partRef || '—'}`;
      return;
    }
    infoBox.textContent = '';
  }

  function hitTest(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects([...hypSpheres, ...objectGroup.children], true)
      .filter(h => h.object.type !== 'LineSegments');
    for (const h of hits) {
      let item = h.object;
      while (item && !item.userData.part && !item.userData.hypothesis && item.parent && item.parent !== scene) item = item.parent;
      if (item?.userData?.hypothesis) return { type: 'hypothesis', data: item.userData.hypothesis };
      if (item?.userData?.part) return { type: 'part', data: item.userData.part };
    }
    return null;
  }

  /**
   * Like hitTest but limited to parts and returning the world-space hit
   * point. Used by "place new condition" mode to capture both the part
   * identity AND the precise 3D location where the user clicked.
   */
  function hitTestPart(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(objectGroup.children, true)
      .filter(h => h.object.type !== 'LineSegments');
    for (const h of hits) {
      let item = h.object;
      while (item && !item.userData.part && item.parent && item.parent !== scene) item = item.parent;
      if (item?.userData?.part) {
        return { part: item.userData.part, point: h.point.clone() };
      }
    }
    return null;
  }

  // -------- Place mode (used when adding a new condition manually) -------
  let placeMode = false;
  let placeCallback = null;     // (result) => void with { part, point }
  let placeMarker = null;       // a temporary pulsing sphere
  let placeMarkerTime = 0;

  function setPlaceMode(active, onPlace) {
    placeMode = !!active;
    placeCallback = active ? onPlace : null;
    if (!active && placeMarker) {
      scene.remove(placeMarker);
      placeMarker.geometry.dispose();
      placeMarker.material.dispose();
      placeMarker = null;
    }
    renderer.domElement.style.cursor = active ? 'crosshair' : '';
  }

  function showPlaceMarker(point) {
    if (!placeMarker) {
      const geo = new THREE.SphereGeometry(0.012, 16, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x1f4e79,           // accent blue from tokens
        transparent: true,
        opacity: 0.85,
        depthTest: false
      });
      placeMarker = new THREE.Mesh(geo, mat);
      placeMarker.renderOrder = 999;
      scene.add(placeMarker);
    }
    placeMarker.position.copy(point);
  }

  function hidePlaceMarker() {
    if (placeMarker) {
      scene.remove(placeMarker);
      placeMarker.geometry.dispose();
      placeMarker.material.dispose();
      placeMarker = null;
    }
  }

  renderer.domElement.addEventListener('pointermove', e => {
    if (placeMode) {
      const hit = hitTestPart(e);
      if (hit) showPlaceMarker(hit.point);
      else hidePlaceMarker();
      return;
    }
    updateInfoBox(hitTest(e));
  });
  renderer.domElement.addEventListener('pointerdown', e => { downPos = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 6) return;

    if (placeMode) {
      const hit = hitTestPart(e);
      if (hit && placeCallback) placeCallback({ part: hit.part, point: hit.point });
      return;
    }

    const hit = hitTest(e);
    if (!hit) { selection = { partId: null, hypothesisId: null }; applySelection(); onSelect?.(null); return; }
    if (hit.type === 'part') { selection = { partId: hit.data.id, hypothesisId: null }; }
    else { selection = { hypothesisId: hit.data.id, partId: hit.data.partRef }; }
    applySelection();
    onSelect?.(hit);
  });

  function toggleExplode() {
    if (!exploded) doExplode();
    else doRestore();
  }

  function doExplode() {
    exploded = true;
    activeAnims = [];
    const box = new THREE.Box3().setFromObject(objectGroup);
    const center = box.getCenter(new THREE.Vector3());
    const explodeDistance = 0.18;

    const offsetByPart = new Map();
    partMeshes.forEach((mesh, partId) => {
      const direction = mesh.position.clone().sub(center);
      if (direction.length() < 0.001) direction.set(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5);
      direction.normalize();
      const offset = direction.multiplyScalar(explodeDistance);
      offsetByPart.set(partId, offset);
      activeAnims.push({ mesh, start: mesh.position.clone(), end: mesh.position.clone().add(offset), startTime: performance.now() });
    });

    hypSpheres.forEach(sphere => {
      const h = sphere.userData.hypothesis;
      const offset = offsetByPart.get(h.partRef);
      if (!offset) return;
      activeAnims.push({ mesh: sphere, start: sphere.position.clone(), end: sphere.position.clone().add(offset), startTime: performance.now() });
    });
  }

  function doRestore() {
    exploded = false;
    activeAnims = [];

    (currentWorkspace?.instance?.parts || []).forEach(part => {
      const mesh = partMeshes.get(part.id);
      if (!mesh) return;
      const o = part.origin || { x: 0, y: 0, z: 0 };
      activeAnims.push({ mesh, start: mesh.position.clone(), end: new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0), startTime: performance.now() });
    });

    hypSpheres.forEach(sphere => {
      const h = sphere.userData.hypothesis;
      if (!h.coordinates) return;
      activeAnims.push({ mesh: sphere, start: sphere.position.clone(), end: new THREE.Vector3(h.coordinates.x || 0, h.coordinates.y || 0, h.coordinates.z || 0), startTime: performance.now() });
    });
  }

  function tick() {
    requestAnimationFrame(tick);
    if (activeAnims.length) {
      const now = performance.now();
      activeAnims.forEach(a => {
        const p = Math.min((now - a.startTime) / ANIM_MS, 1);
        const e = 1 - Math.pow(1 - p, 3);
        a.mesh.position.lerpVectors(a.start, a.end, e);
      });
      activeAnims = activeAnims.filter(a => performance.now() - a.startTime < ANIM_MS);
    }
    // Pulse the place marker to draw attention to it
    if (placeMarker) {
      const t = performance.now() * 0.004;
      const pulse = 1 + Math.sin(t) * 0.25;
      placeMarker.scale.setScalar(pulse);
      placeMarker.material.opacity = 0.55 + Math.sin(t) * 0.3;
    }
    controls.update();
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.setViewport(8, 8, 72, 72);
    axesCamera.quaternion.copy(camera.quaternion);
    renderer.render(axesScene, axesCamera);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  }
  tick();

  let currentWorkspace = null;
  let lastGeometryKey = '';

  function geometryKey(ws) {
    // Hash inputs that affect the scene geometry (not selection, intent,
    // chat, plans). If this string doesn't change, the 3D view doesn't need
    // to rebuild — and the camera doesn't need to reframe.
    const parts = (ws.instance?.parts || []).map(p => {
      const d = p.dimensions || {};
      const o = p.origin || {};
      return `${p.id}|${p.status}|${o.x},${o.y},${o.z}|${d.width},${d.height},${d.depth}`;
    }).join(';');
    const hyps = (ws.hypotheses || []).map(h => {
      const c = h.coordinates;
      const k = c ? `${c.x},${c.y},${c.z}` : '_';
      return `${h.id}|${h.partRef || '_'}|${k}`;
    }).join(';');
    return `${parts}::${hyps}`;
  }

  return {
    render(workspace) {
      currentWorkspace = workspace;
      const key = geometryKey(workspace);
      if (key !== lastGeometryKey) {
        rebuild(workspace);
        // Frame only on first render; otherwise keep user's camera angle.
        if (!lastGeometryKey) frame();
        lastGeometryKey = key;
      } else {
        // Geometry unchanged — update part/hypothesis references in
        // userData so click handlers still match latest state, then
        // re-apply selection styling.
        (workspace.instance?.parts || []).forEach(p => {
          const m = partMeshes.get(p.id);
          if (m) m.userData.part = p;
        });
        const hypById = new Map((workspace.hypotheses || []).map(h => [h.id, h]));
        hypSpheres.forEach(s => {
          const fresh = hypById.get(s.userData.hypothesis.id);
          if (fresh) s.userData.hypothesis = fresh;
        });
        applySelection();
      }
    },
    refit() {
      // Manual reframe — for the user to recenter when they want to.
      frame();
    },
    select({ partId = null, hypothesisId = null }) {
      selection = { partId, hypothesisId };
      applySelection();
    },
    resize() {
      camera.aspect = wrap.clientWidth / wrap.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    },
    toggleExplode,
    isExploded: () => exploded,
    setPlaceMode
  };
}
