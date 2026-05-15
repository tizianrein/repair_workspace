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
      color: 0xd0d0d0, transparent: true, opacity: 0.40, depthWrite: false
    });
    const matHighlight = new THREE.MeshBasicMaterial({
      color: 0xff4d4d, transparent: true, opacity: 0.85, depthWrite: false
    });
    const matEdge = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5 });
    const matEdgeHighlight = new THREE.LineBasicMaterial({ color: 0x7a1418 });

    for (const part of parts) {
      const d = part.dimensions || {};
      const w = Math.max(d.width || 0.1, 0.005);
      const h = Math.max(d.height || 0.1, 0.005);
      const dp = Math.max(d.depth || 0.1, 0.005);
      const geo = new THREE.BoxGeometry(w, h, dp);

      const isHL = highlightSet.has(part.id);
      const mesh = new THREE.Mesh(geo, isHL ? matHighlight : matDim);
      const o = part.origin || { x: 0, y: 0, z: 0 };
      mesh.position.set(o.x || 0, o.y || 0, o.z || 0);
      if (part.rotation) {
        mesh.rotation.set(part.rotation.x || 0, part.rotation.y || 0, part.rotation.z || 0, 'YXZ');
      }
      objectGroup.add(mesh);

      const edges = new THREE.EdgesGeometry(geo);
      const lines = new THREE.LineSegments(edges, isHL ? matEdgeHighlight : matEdge);
      lines.position.copy(mesh.position);
      lines.rotation.copy(mesh.rotation);
      objectGroup.add(lines);
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
