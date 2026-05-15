/**
 * Mini 3D preview for the detail modal.
 *
 * Lightweight, display-only version of viewer-3d. No interaction beyond
 * passive rotation drag. Used to show the user which parts and conditions
 * a step / part / condition references, in spatial context.
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
  function tick() {
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

  /**
   * Render the artefact with optional highlights.
   * @param ws workspace
   * @param highlightPartIds array of part ids to render in highlight color
   * @param highlightHypIds array of hypothesis ids whose markers to draw
   */
  function render(ws, { highlightPartIds = [], highlightHypIds = [] } = {}) {
    clear();
    const parts = ws.instance?.parts || [];
    if (!parts.length) return;

    const highlightSet = new Set(highlightPartIds);
    const hypSet = new Set(highlightHypIds);

    const matDim = new THREE.MeshBasicMaterial({
      color: 0xd0d0d0, transparent: true, opacity: 0.35, depthWrite: false
    });
    const matHighlight = new THREE.MeshBasicMaterial({
      color: 0xff4d4d, transparent: true, opacity: 0.85, depthWrite: false
    });
    const matEdge = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.6 });
    const matEdgeHighlight = new THREE.LineBasicMaterial({ color: 0x7a1418 });

    for (const part of parts) {
      const dim = part.dimensions || { w: 0.05, h: 0.05, d: 0.05 };
      const w = Math.max(dim.w || 0.05, 0.005);
      const h = Math.max(dim.h || 0.05, 0.005);
      const d = Math.max(dim.d || 0.05, 0.005);
      const geo = new THREE.BoxGeometry(w, h, d);
      const isHL = highlightSet.has(part.id);
      const mesh = new THREE.Mesh(geo, isHL ? matHighlight : matDim);
      mesh.position.set(
        (part.origin?.x || 0) + w / 2,
        (part.origin?.y || 0) + h / 2,
        (part.origin?.z || 0) + d / 2
      );
      objectGroup.add(mesh);

      const edges = new THREE.EdgesGeometry(geo);
      const lines = new THREE.LineSegments(edges, isHL ? matEdgeHighlight : matEdge);
      lines.position.copy(mesh.position);
      objectGroup.add(lines);
    }

    // Hypothesis markers (small red spheres)
    const markerGeo = new THREE.SphereGeometry(0.015, 12, 12);
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0xc1272d, depthTest: false, transparent: true, opacity: 0.9
    });
    for (const h of (ws.hypotheses || [])) {
      if (!hypSet.has(h.id) && !highlightSet.has(h.partRef)) continue;
      const c = h.coordinates;
      if (!c) {
        // Fall back to parent part centre
        const p = parts.find(p => p.id === h.partRef);
        if (!p) continue;
        const x = (p.origin?.x || 0) + (p.dimensions?.w || 0.05) / 2;
        const y = (p.origin?.y || 0) + (p.dimensions?.h || 0.05) / 2;
        const z = (p.origin?.z || 0) + (p.dimensions?.d || 0.05) / 2;
        const m = new THREE.Mesh(markerGeo, markerMat);
        m.position.set(x, y, z);
        m.renderOrder = 999;
        markerGroup.add(m);
      } else {
        const m = new THREE.Mesh(markerGeo, markerMat);
        m.position.set(c.x || 0, c.y || 0, c.z || 0);
        m.renderOrder = 999;
        markerGroup.add(m);
      }
    }

    // Frame the camera to fit the assembly
    const box = new THREE.Box3().setFromObject(objectGroup);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.5);
      const fov = camera.fov * Math.PI / 180;
      let distance = maxDim / (2 * Math.tan(fov / 2));
      distance *= 2.6;
      const dir = new THREE.Vector3(-1, 0.5, -1).normalize();
      camera.position.copy(dir.multiplyScalar(distance).add(center));
      controls.target.copy(center);
      controls.update();
    }
  }

  function resize() {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 180;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function destroy() {
    if (animationId) cancelAnimationFrame(animationId);
    clear();
    controls.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  return { render, resize, destroy };
}
