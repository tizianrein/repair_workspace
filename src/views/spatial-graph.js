/**
 * Spatial graph view.
 *
 * Hierarchical layout (dagre) with parts assigned to columns based on their
 * spatial role in the assembly. The result reads like the paper's example:
 * left side on the left, right side on the right, central anchor in the
 * middle. Conditions sit immediately next to their part as red ellipses
 * connected with dashed edges.
 *
 * Columns are derived from X coordinate quantiles, so the layout adapts to
 * any object: a chair gets 3 columns (legs / aprons / seat), a door might
 * get 5 (hinges / frame / panes / handle / trim).
 *
 * Tap a part or condition → onDetail callback opens the modal.
 */

import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
cytoscape.use(dagre);

const NUM_COLUMNS = 8;

export function createSpatialGraph(container, { onDetail, onBackgroundTap }) {
  let cy = null;

  function render(workspace) {
    const parts = workspace.instance?.parts || [];
    const conditions = workspace.conditions || [];
    if (!parts.length) {
      container.innerHTML = `<div class="pane-empty">No assembly loaded.</div>`;
      cy = null;
      return;
    }

    // Preserve user's view across rebuilds — see action-graph.js for the
    // rationale. Automatic re-fit on every workspace update makes the
    // graph unusable mid-session; we restore zoom/pan after the new
    // layout settles.
    let previousView = null;
    if (cy) {
      previousView = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    }

    container.innerHTML = '';

    // Sort parts by X position (left to right in physical space).
    // Assign each part to a column rank based on its quantile.
    const sortedByX = [...parts].sort((a, b) =>
      (a.origin?.x ?? 0) - (b.origin?.x ?? 0)
    );
    const rankByPart = new Map();
    sortedByX.forEach((p, i) => {
      const col = Math.floor((i / sortedByX.length) * NUM_COLUMNS);
      rankByPart.set(p.id, Math.min(col, NUM_COLUMNS - 1));
    });

    const partIds = new Set(parts.map(p => p.id));
    const nodes = [];
    const edges = [];

    // Condition grouping by parent part (for fanning)
    const hypsByPart = new Map();
    conditions.forEach(h => {
      if (!hypsByPart.has(h.partRef)) hypsByPart.set(h.partRef, []);
      hypsByPart.get(h.partRef).push(h);
    });

    parts.forEach(p => {
      nodes.push({
        data: {
          id: `part:${p.id}`,
          label: `${p.id}\n(${p.status})`,
          status: p.status || 'intact',
          kind: 'part',
          rank: rankByPart.get(p.id) ?? 0
        }
      });
    });

    conditions.forEach(h => {
      const parentRank = rankByPart.get(h.partRef) ?? 0;
      nodes.push({
        data: {
          id: `cond:${h.id}`,
          label: (h.type || 'condition').toLowerCase(),
          kind: 'cond',
          status: h.status,
          // Place condition one rank to the left of its parent (or right
          // if parent is leftmost), so it sits adjacent in the dagre layout
          rank: parentRank === 0 ? 1 : parentRank - 1
        }
      });
    });

    const seen = new Set();
    parts.forEach(part => (part.connections || []).forEach(conn => {
      if (!partIds.has(conn)) return;
      const k = [part.id, conn].sort().join('|');
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({
        data: {
          id: `e_${k}`,
          source: `part:${part.id}`,
          target: `part:${conn}`,
          kind: 'connection'
        }
      });
    }));
    conditions.forEach(h => {
      if (!h.partRef || !partIds.has(h.partRef)) return;
      edges.push({
        data: {
          id: `eh_${h.id}`,
          source: `cond:${h.id}`,
          target: `part:${h.partRef}`,
          kind: 'cond'
        }
      });
    });

    cy = cytoscape({
      container,
      elements: [...nodes, ...edges],
      style: [
        {
          selector: 'node[kind = "part"]',
          style: {
            'shape': 'round-rectangle',
            'background-color': '#ffffff',
            'border-color': '#1a1a1a',
            'border-width': 1.0,
            'label': 'data(label)',
            'color': '#1a1a1a',
            'font-family': 'JetBrains Mono, monospace',
            'font-size': 10,
            'text-wrap': 'wrap',
            'text-valign': 'center',
            'text-halign': 'center',
            'width': 'label',
            'height': 'label',
            'padding': 10
          }
        },
        { selector: 'node[status = "defective"]', style: { 'background-color': '#f4d2d4' } },
        { selector: 'node[status = "missing"]',   style: { 'background-color': '#fff3c4' } },
        { selector: 'node[status = "new"]',       style: { 'background-color': '#f0d8ff' } },
        { selector: 'node[status = "repaired"]',  style: { 'background-color': '#d8f0e0' } },
        {
          selector: 'node[kind = "cond"]',
          style: {
            'shape': 'ellipse',
            'background-color': '#c1272d',
            'border-color': '#7a1418',
            'border-width': 1.2,
            'label': 'data(label)',
            'color': '#ffffff',
            'font-family': 'JetBrains Mono, monospace',
            'font-size': 9,
            'text-wrap': 'wrap',
            'text-max-width': 56,
            'text-valign': 'center',
            'text-halign': 'center',
            'width': 56,
            'height': 56
          }
        },
        { selector: 'node[kind = "cond"][status = "refuted"]',  style: { 'background-color': '#8a8a83', 'opacity': 0.6 } },
        { selector: 'node[kind = "cond"][status = "confirmed"]', style: { 'border-color': '#fff', 'border-width': 2.5 } },
        {
          selector: 'edge[kind = "connection"]',
          style: {
            'curve-style': 'straight',
            'line-color': '#1a1a1a',
            'width': 1
          }
        },
        {
          selector: 'edge[kind = "cond"]',
          style: {
            'curve-style': 'straight',
            'line-color': '#c1272d',
            'line-style': 'dashed',
            'width': 1.2
          }
        }
      ],
    layout: {
      name: 'dagre',
      rankDir: 'LR',
      rankSep: 130,
      nodeSep: 60,
      edgeSep: 25,
      ranker: 'network-simplex',
      rankFn: node => node.data('rank'),
      animate: false,
      padding: 40,
      fit: true
    },
      minZoom: 0.3,
      maxZoom: 3,
      // Cytoscape default is 1.0; matches the action graph and feels
      // natural on trackpad/mouse. Earlier 0.2 / 0.5 felt sluggish.
      wheelSensitivity: 1.0
    });

    cy.on('tap', 'node', evt => {
      const id = evt.target.id();
      if (id.startsWith('part:'))      onDetail?.({ type: 'part',       id: id.slice(5) });
      else if (id.startsWith('cond:')) onDetail?.({ type: 'condition', id: id.slice(5) });
    });

    // Tapping empty graph background → clear selection (caller decides what
    // that means — typically reset chat scope to global).
    cy.on('tap', evt => {
      if (evt.target === cy) onBackgroundTap?.();
    });

    // Restore the user's zoom/pan if they had one — see capture at top of
    // render() for the rationale. dagre layout above is synchronous (no
    // `animate`), so cy.pan()/cy.zoom() currently reflect the default fit.
    if (previousView) {
      cy.viewport({ zoom: previousView.zoom, pan: previousView.pan });
    }
  }

  return {
    render,
    fit() { if (cy) cy.fit(undefined, 30); },
    resize() { if (cy) cy.resize(); }
  };
}