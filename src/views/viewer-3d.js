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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
  // Optional textured-mesh overlay loaded from an example's mesh.glb.
  // Coexists with the box parts in the same world-space coordinates;
  // the example author is responsible for alignment.
  const meshGroup = new THREE.Group();
  scene.add(meshGroup);
  // displayMode controls visibility of box parts vs. the textured mesh.
  // 'boxes' | 'mesh' | 'both'. Defaults to 'boxes'; flipped to 'both'
  // automatically when a mesh is loaded.
  let displayMode = 'boxes';
  let loadedMesh = null;     // root Object3D from GLTFLoader
  const gltfLoader = new GLTFLoader();
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
    // Compute the union of the box parts AND the mesh overlay. If the
    // mesh is wildly off-position (alignment bug), this keeps it in
    // frame so the user can see and diagnose it rather than staring
    // at an empty viewport.
    const box = new THREE.Box3().setFromObject(objectGroup);
    if (loadedMesh) {
      const meshBox = new THREE.Box3().setFromObject(loadedMesh);
      if (!meshBox.isEmpty()) {
        if (box.isEmpty()) box.copy(meshBox);
        else box.union(meshBox);
      }
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const fov = camera.fov * Math.PI / 180;
    // Standard "fit-to-view" distance, then back off so the object sits
    // comfortably in the frame rather than touching the edges.
    let distance = maxDim / (2 * Math.tan(fov / 2));
    distance *= 2.4;
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

  /**
   * Raycast against the textured mesh overlay. Returns the world-space
   * hit point and the nearest part by bounding-box distance. Used when
   * the mesh is visible so the user can click directly on the scan.
   * Returns null if the mesh isn't loaded or the ray missed.
   */
  function hitTestMesh(event) {
    if (!loadedMesh) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(loadedMesh, true);
    if (!hits.length) return null;
    const point = hits[0].point.clone();
    const part = nearestPartToPoint(point);
    return part ? { part, point } : null;
  }

  /**
   * Find the part whose oriented bounding box is closest to a world-
   * space point. Returns null when there are no parts (empty workspace).
   *
   * Note: we use distanceToPoint on each part mesh's Box3 — that's
   * close enough for typical box-part scales and is robust against the
   * "click between two close parts" edge case (the part whose box
   * actually contains the point gets distance 0). For oriented parts
   * the bounding box is in WORLD space (computed via setFromObject),
   * so rotation is correctly accounted for as an axis-aligned hull
   * of the rotated geometry. Slightly loose but consistent.
   */
  function nearestPartToPoint(worldPoint) {
    let best = null;
    let bestDist = Infinity;
    const tmpBox = new THREE.Box3();
    partMeshes.forEach((mesh) => {
      tmpBox.setFromObject(mesh);
      const d = tmpBox.distanceToPoint(worldPoint);
      if (d < bestDist) {
        bestDist = d;
        best = mesh.userData.part;
      }
    });
    return best;
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

  // When the mesh overlay is visible, click & hover prefer to hit the
  // mesh first (it's what the user sees). Falls through to the box
  // raycast when the mesh isn't visible or the ray misses it.
  function meshIsHittable() {
    return !!loadedMesh && (displayMode === 'mesh' || displayMode === 'both');
  }

  renderer.domElement.addEventListener('pointermove', e => {
    if (placeMode) {
      const hit = meshIsHittable() ? (hitTestMesh(e) || hitTestPart(e)) : hitTestPart(e);
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
      // Mesh-visible: prefer the mesh raycast (gives the precise surface
      // point the user clicked AND the nearest part via heuristic). Fall
      // back to the box raycast if the mesh ray missed (e.g. clicked the
      // background but a box was there).
      const hit = meshIsHittable() ? (hitTestMesh(e) || hitTestPart(e)) : hitTestPart(e);
      if (hit && placeCallback) placeCallback({ part: hit.part, point: hit.point });
      return;
    }

    // For selection (not placement) we keep the existing hitTest which
    // also picks up hypothesis spheres. When the mesh is visible and
    // the user clicks on bare mesh (no hypothesis, no box ray-hit), we
    // resolve the click to the nearest part via the mesh hit so they
    // still get a selection.
    let hit = hitTest(e);
    if (!hit && meshIsHittable()) {
      const meshHit = hitTestMesh(e);
      if (meshHit) hit = { type: 'part', data: meshHit.part };
    }
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

  // Apply the current displayMode to the two groups. Toggling visibility
  // is enough — the raycast lookups gate themselves on meshIsHittable()
  // so invisible objects don't grab clicks. We also tune the mesh
  // material opacity here so that "Both" mode lets the colored box
  // parts read through, while "Mesh" mode shows the scan at full
  // opacity for an undisturbed look.
  function applyDisplayMode() {
    objectGroup.visible = displayMode !== 'mesh';
    meshGroup.visible = displayMode !== 'boxes';
    const opacity = displayMode === 'both' ? 0.45 : 1.0;
    setMeshOpacity(opacity);
  }

  // Walk the loaded glTF scene and set each mesh material's opacity.
  // We mutate the existing materials in place rather than swapping them
  // out — that preserves all the textures, normal maps, and PBR
  // settings GLTFLoader configured. transparent must be toggled too;
  // a MeshStandardMaterial ignores opacity unless transparent is true.
  function setMeshOpacity(opacity) {
    if (!loadedMesh) return;
    const isTranslucent = opacity < 1.0;
    loadedMesh.traverse(obj => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => {
        if (!m) return;
        m.transparent = isTranslucent;
        m.opacity = opacity;
        // depthWrite off when translucent so the boxes behind the
        // mesh aren't z-fought into invisibility by mesh-front fragments.
        // Re-enable in opaque mode so the mesh occludes itself properly.
        m.depthWrite = !isTranslucent;
        m.needsUpdate = true;
      });
    });
  }

  // Disposes anything currently in meshGroup. We recurse because a glTF
  // scene can be a tree of Mesh / Group / Object3D nodes, each owning
  // geometry/materials/textures. Without this, repeated mesh loads
  // would leak GPU resources just like the WebGL-context bug from
  // earlier in the session.
  function clearMeshGroup() {
    meshGroup.traverse(obj => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => {
          if (!m) return;
          // Dispose textures referenced by this material before the
          // material itself, otherwise the texture handles leak.
          ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach(k => {
            if (m[k]) m[k].dispose();
          });
          m.dispose();
        });
      }
    });
    while (meshGroup.children.length) meshGroup.remove(meshGroup.children[0]);
    loadedMesh = null;
  }

  /**
   * Load a textured glb from a URL. Replaces any previously loaded mesh.
   * Returns a promise that resolves with true on success, false on
   * failure (caller may want to know to update toolbar UI).
   *
   * Assumes the mesh is already aligned to workspace world coordinates.
   * Convention is to bundle these as /examples/<slug>/mesh.glb.
   */
  function loadMesh(url) {
    clearMeshGroup();
    return new Promise(resolve => {
      gltfLoader.load(
        url,
        gltf => {
          loadedMesh = gltf.scene;
          meshGroup.add(loadedMesh);
          // Auto-switch to 'both' on first mesh load so the user
          // immediately sees the scan. If they had explicitly set a
          // mode before loading, this overrides — but in practice
          // mesh loading happens during example load, before any
          // mode interaction.
          displayMode = 'both';
          applyDisplayMode();
          // Reframe so the user actually sees the mesh, even if it's
          // far from the box parts. Without this a misaligned scan
          // would silently sit off-screen.
          frame();
          resolve(true);
        },
        undefined,
        err => {
          console.warn('[viewer-3d] mesh load failed', url, err);
          resolve(false);
        }
      );
    });
  }

  function clearMesh() {
    clearMeshGroup();
    displayMode = 'boxes';
    applyDisplayMode();
  }

  function setDisplayMode(mode) {
    if (!['boxes', 'mesh', 'both'].includes(mode)) return;
    // 'mesh' / 'both' are meaningful only when a mesh is loaded.
    if ((mode === 'mesh' || mode === 'both') && !loadedMesh) mode = 'boxes';
    displayMode = mode;
    applyDisplayMode();
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
    setPlaceMode,
    // Mesh overlay API
    loadMesh,
    clearMesh,
    hasMesh: () => !!loadedMesh,
    setDisplayMode,
    getDisplayMode: () => displayMode
  };
}
