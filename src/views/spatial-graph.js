/**
 * Spatial graph view.
 *
 * Renders parts as round-rectangle nodes connected by their connections list.
 * Hypotheses are red ellipses connected by dashed edges to their part. The
 * cose layout works well for this density of connections.
 *
 * Tap a part or hypothesis → onDetail callback opens the modal.
 */

import cytoscape from 'cytoscape';

export function createSpatialGraph(container, { onDetail }) {
  let cy = null;

  function render(workspace) {
    const parts = workspace.instance?.parts || [];
    const hypotheses = workspace.hypotheses || [];
    if (!parts.length) {
      container.innerHTML = `<div class="pane-empty">No assembly loaded.</div>`;
      cy = null;
      return;
    }
    container.innerHTML = '';

    const partIds = new Set(parts.map(p => p.id));
    const nodes = [];
    const edges = [];

    parts.forEach(p => {
      nodes.push({ data: { id: `part:${p.id}`, label: `${p.id}\n(${p.status})`, status: p.status || 'intact', kind: 'part' } });
    });
    hypotheses.forEach(h => {
      nodes.push({ data: { id: `hyp:${h.id}`, label: (h.type || 'hypothesis').toLowerCase(), kind: 'hyp', status: h.status } });
    });

    const seen = new Set();
    parts.forEach(part => (part.connections || []).forEach(conn => {
      if (!partIds.has(conn)) return;
      const k = [part.id, conn].sort().join('|');
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ data: { id: `e_${k}`, source: `part:${part.id}`, target: `part:${conn}`, kind: 'connection' } });
    }));
    hypotheses.forEach(h => {
      if (!h.partRef || !partIds.has(h.partRef)) return;
      edges.push({ data: { id: `eh_${h.id}`, source: `hyp:${h.id}`, target: `part:${h.partRef}`, kind: 'hyp' } });
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
            'label': 'data(label)', 'color': '#1a1a1a',
            'font-family': 'JetBrains Mono, monospace',
            'font-size': 10,
            'text-wrap': 'wrap',
            'text-valign': 'center', 'text-halign': 'center',
            'width': 'label', 'height': 'label',
            'padding': 8
          }
        },
        { selector: 'node[status = "defective"]', style: { 'background-color': '#f4d2d4' } },
        { selector: 'node[status = "missing"]', style: { 'background-color': '#fff3c4' } },
        { selector: 'node[status = "new"]', style: { 'background-color': '#f0d8ff' } },
        { selector: 'node[status = "repaired"]', style: { 'background-color': '#d8f0e0' } },
        {
          selector: 'node[kind = "hyp"]',
          style: {
            'shape': 'ellipse',
            'background-color': '#c1272d',
            'border-color': '#7a1418',
            'border-width': 1.2,
            'label': 'data(label)', 'color': '#ffffff',
            'font-family': 'JetBrains Mono, monospace',
            'font-size': 9,
            'text-wrap': 'wrap', 'text-max-width': 52,
            'text-valign': 'center', 'text-halign': 'center',
            'width': 60, 'height': 60
          }
        },
        { selector: 'node[kind = "hyp"][status = "refuted"]', style: { 'background-color': '#8a8a83', 'opacity': 0.6 } },
        { selector: 'node[kind = "hyp"][status = "confirmed"]', style: { 'border-color': '#fff', 'border-width': 2.5 } },
        {
          selector: 'edge[kind = "connection"]',
          style: { 'curve-style': 'bezier', 'line-color': '#5a5a55', 'width': 1 }
        },
        {
          selector: 'edge[kind = "hyp"]',
          style: { 'curve-style': 'bezier', 'line-color': '#c1272d', 'line-style': 'dashed', 'width': 1 }
        }
      ],
      layout: { name: 'cose', nodeRepulsion: 6000, idealEdgeLength: 80, animate: false, padding: 30 },
      minZoom: 0.3, maxZoom: 3
    });

    cy.on('tap', 'node', evt => {
      const id = evt.target.id();
      if (id.startsWith('part:')) onDetail?.({ type: 'part', id: id.slice(5) });
      else if (id.startsWith('hyp:')) onDetail?.({ type: 'hypothesis', id: id.slice(4) });
    });
  }

  return {
    render,
    fit() { if (cy) cy.fit(undefined, 30); },
    resize() { if (cy) cy.resize(); }
  };
}
