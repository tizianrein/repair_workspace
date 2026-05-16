/**
 * Mini 3D preview for the detail modal.
 *
 * Lightweight, display-only version of viewer-3d. No interaction beyond
 * passive rotation/zoom drag. Used to show the user which parts and
 * conditions a step/part/condition references, in spatial context.
 *
 * Reads the SAME schema as viewer-3d.js (width/height/depth, origin.x/y/z,
 * optional rotation). Always keep them in sync — if the main viewer is
 * fixed for a new schema, fix this one too.
 *
 * Renders box primitives for parts (highlighting those in `highlightPartIds`)
 * and small spheres for conditions (highlighting those in `highlightHypIds`).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createMiniViewer3D(container) {
  const width = container.clientWidth || 300;
  const height = container.clientHeight || 180;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f4f0);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 100);
  camera.position.set(2, 2, 2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableZoom = true;
  controls.zoomSpeed = 0.5;
  controls.rotateSpeed = 0.6;

  const objectGroup = new THREE.Group();
  scene.add(objectGroup);
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);

  let animationId = null;
  let disposed = false;
  function tick() {
    if (disposed) return;
    animationId = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  function clear() {
    while (objectGroup.children.length) {
      const c = objectGroup.children[0];
      objectGroup.remove(c);
      c.geometry?.dispose();
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
      else c.material?.dispose();
    }
    while (markerGroup.children.length) {
      const c = markerGroup.children[0];
      markerGroup.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
  }

  // Map mesh.uuid → part.id so raycast click results can be turned into part IDs.
  // Rebuilt every render(). Edge LineSegments are NOT entered here; only the
  // solid box meshes that should be clickable.
  const meshToPartId = new Map();

  // Reverse map (partId → { mesh, edges }) used by updateHighlights() to
  // re-skin parts without rebuilding the scene.
  const partIdToObjects = new Map();

  // Shared materials — created once, reused across renders. Mini-viewer
  // recreates the scene on every render(), but the material handles persist.
  const matDim = new THREE.MeshBasicMaterial({
    color: 0xd0d0d0, transparent: true, opacity: 0.40, depthWrite: false
  });
  const matHighlight = new THREE.MeshBasicMaterial({
    color: 0xff4d4d, transparent: true, opacity: 0.85, depthWrite: false
  });
  const matConnected = new THREE.MeshBasicMaterial({
    color: 0x2266aa, transparent: true, opacity: 0.75, depthWrite: false
  });
  const matEdge = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5 });
  const matEdgeHighlight = new THREE.LineBasicMaterial({ color: 0x7a1418 });
  const matEdgeConnected = new THREE.LineBasicMaterial({ color: 0x113a66 });

  /**
   * Render the artefact with optional highlights.
   * @param ws workspace
   * @param opts.highlightPartIds   parts rendered in highlight (red) color
   * @param opts.highlightHypIds    hypothesis ids whose markers to draw
   * @param opts.connectedPartIds   parts rendered in connection (blue) color
   * @param opts.onPartClick        (partId) => void; if set, parts become clickable via raycast
   */
  function render(ws, opts = {}) {
    const {
      highlightPartIds = [],
      highlightHypIds = [],
      connectedPartIds = [],
      onPartClick = null
    } = opts;
    clear();
    meshToPartId.clear();
    partIdToObjects.clear();
    const parts = ws.instance?.parts || [];
    if (!parts.length) return;

    const highlightSet = new Set(highlightPartIds);
    const hypSet = new Set(highlightHypIds);
    const connectedSet = new Set(connectedPartIds);

    for (const part of parts) {
      const d = part.dimensions || {};
      const w = Math.max(d.width || 0.1, 0.005);
      const h = Math.max(d.height || 0.1, 0.005);
      const dp = Math.max(d.depth || 0.1, 0.005);
      const geo = new THREE.BoxGeometry(w, h, dp);

      const isHL = highlightSet.has(part.id);
      const isConn = !isHL && connectedSet.has(part.id);
      const fillMat = isHL ? matHighlight : (isConn ? matConnected : matDim);
      const edgeMat = isHL ? matEdgeHighlight : (isConn ? matEdgeConnected : matEdge);

      const mesh = new THREE.Mesh(geo, fillMat);
      const o = part.origin || { x: 0, y: 0, z: 0 };
      mesh.position.set(o.x || 0, o.y || 0, o.z || 0);
      if (part.rotation) {
        mesh.rotation.set(part.rotation.x || 0, part.rotation.y || 0, part.rotation.z || 0, 'YXZ');
      }
      objectGroup.add(mesh);
      meshToPartId.set(mesh.uuid, part.id);

      const edges = new THREE.EdgesGeometry(geo);
      const lines = new THREE.LineSegments(edges, edgeMat);
      lines.position.copy(mesh.position);
      lines.rotation.copy(mesh.rotation);
      objectGroup.add(lines);

      partIdToObjects.set(part.id, { mesh, lines });
    }

    // Hypothesis markers — small red spheres. Sized proportionally to the
    // bounding box, computed after parts are added.
    const objBox = new THREE.Box3().setFromObject(objectGroup);
    const objExtent = objBox.isEmpty()
      ? 0.1
      : Math.max(...objBox.getSize(new THREE.Vector3()).toArray(), 0.1);
    const sphereRadius = Math.max(objExtent * 0.018, 0.005);

    const markerGeo = new THREE.SphereGeometry(sphereRadius, 12, 12);
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0xc1272d, depthTest: false, transparent: true, opacity: 0.95
    });
    for (const h of (ws.hypotheses || [])) {
      const shouldShow = hypSet.has(h.id) || highlightSet.has(h.partRef);
      if (!shouldShow) continue;
      const c = h.coordinates;
      let pos = null;
      if (c && (c.x != null || c.y != null || c.z != null)) {
        pos = new THREE.Vector3(c.x || 0, c.y || 0, c.z || 0);
      } else {
        // Fall back to parent part's center
        const p = parts.find(pp => pp.id === h.partRef);
        if (!p) continue;
        const o = p.origin || {};
        pos = new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0);
      }
      const m = new THREE.Mesh(markerGeo, markerMat);
      m.position.copy(pos);
      m.renderOrder = 999;
      markerGroup.add(m);
    }

    // Frame the camera so the whole object fits comfortably
    if (!objBox.isEmpty()) {
      const center = objBox.getCenter(new THREE.Vector3());
      const size = objBox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.5);
      const fov = camera.fov * Math.PI / 180;
      let distance = maxDim / (2 * Math.tan(fov / 2));
      distance *= 2.4;
      const dir = new THREE.Vector3(-1, 0.6, -1).normalize();
      camera.position.copy(dir.multiplyScalar(distance).add(center));
      controls.target.copy(center);
      controls.minDistance = distance * 0.3;
      controls.maxDistance = distance * 3;
      controls.update();
    }

    // Replace any previously-installed click handler. The handler closure
    // captures `onPartClick` and the current mesh map.
    installClickHandler(onPartClick);
  }

  // ----- Click / tap handling -----
  // We distinguish a tap (intent: click) from a drag (intent: orbit) by
  // measuring pointer travel between pointerdown and pointerup. If the
  // pointer moved more than CLICK_THRESHOLD pixels, the gesture is an
  // orbit and we ignore it as far as part-selection goes.
  const CLICK_THRESHOLD_PX = 5;
  let pointerDownX = 0, pointerDownY = 0, pointerDownTime = 0;
  let currentClickCallback = null;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function onPointerDown(e) {
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
    pointerDownTime = Date.now();
  }
  function onPointerUp(e) {
    if (!currentClickCallback) return;
    const dx = e.clientX - pointerDownX;
    const dy = e.clientY - pointerDownY;
    const dist = Math.hypot(dx, dy);
    if (dist > CLICK_THRESHOLD_PX) return; // it's an orbit, not a tap
    if (Date.now() - pointerDownTime > 600) return; // long press, ignore

    // Compute NDC and raycast
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const meshes = objectGroup.children.filter(c => c.isMesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;
    const partId = meshToPartId.get(hits[0].object.uuid);
    if (partId) currentClickCallback(partId);
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  function installClickHandler(cb) {
    currentClickCallback = typeof cb === 'function' ? cb : null;
    // Cursor feedback so it's clear the viewer is interactive
    renderer.domElement.style.cursor = currentClickCallback ? 'pointer' : 'default';
  }

  // Public helper for in-place click-handler updates (used when the same
  // viewer instance is reused across detail-modal refreshes).
  function setOnPartClick(cb) { installClickHandler(cb); }

  function resize() {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 180;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    currentClickCallback = null;
    clear();
    // Dispose shared materials owned by this viewer instance — they live
    // in the closure, so once the viewer goes away they would otherwise
    // leak GPU resources.
    matDim.dispose();
    matHighlight.dispose();
    matConnected.dispose();
    matEdge.dispose();
    matEdgeHighlight.dispose();
    matEdgeConnected.dispose();
    controls.dispose();
    // Critical: renderer.dispose() alone does NOT release the WebGL
    // context — Chrome holds onto it until GC, and the per-tab limit is
    // ~16 live contexts. Without forceContextLoss(), opening/closing the
    // modal 16 times tips the tab into a WebGL crash (the ":(" page).
    const gl = renderer.getContext();
    const loseExt = gl && gl.getExtension('WEBGL_lose_context');
    if (loseExt) loseExt.loseContext();
    renderer.forceContextLoss?.();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  /**
   * Cheaply re-skin parts without rebuilding the scene. Used by the
   * detail editor when the user toggles a connection — keeps camera
   * position, rotation and zoom intact.
   *
   * @param opts.highlightPartIds  parts to render in red (typically the
   *                               currently-edited part — unchanged here)
   * @param opts.connectedPartIds  parts to render in blue
   */
  function updateHighlights({ highlightPartIds = [], connectedPartIds = [] } = {}) {
    const highlightSet = new Set(highlightPartIds);
    const connectedSet = new Set(connectedPartIds);
    partIdToObjects.forEach((objs, partId) => {
      const isHL = highlightSet.has(partId);
      const isConn = !isHL && connectedSet.has(partId);
      objs.mesh.material = isHL ? matHighlight : (isConn ? matConnected : matDim);
      objs.lines.material = isHL ? matEdgeHighlight : (isConn ? matEdgeConnected : matEdge);
    });
  }

  return { render, resize, destroy, updateHighlights, setOnPartClick };
}
