/**
 * The two graph views.
 *
 * Spatial: the members and how they meet, laid out from the artefact's own
 * coordinates rather than by a force simulation, so the graph reads as the
 * structure it describes.
 *
 * Action: the steps of one strategy and the order they depend on, ranked with
 * dagre because a plan is a directed graph, not a mesh.
 */

const STATUS_FILL = {
  intact: '#d0d0d0', suspected: '#e8a33d', defective: '#ff4d4d',
  missing: '#ffde59', repaired: '#97c459', new: '#c000ff', discarded: '#8b8578',
};

const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

let dagreRegistered = false;
function ensureDagre() {
  if (dagreRegistered || !window.cytoscape) return;
  const ext = window.cytoscapeDagre || window.cytoscapeDagre?.default;
  if (ext) { try { window.cytoscape.use(ext); dagreRegistered = true; } catch {} }
}

function baseStyle() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(fill)',
        'border-width': 1,
        'border-color': '#1a1a1a',
        'label': 'data(label)',
        'font-family': MONO,
        'font-size': 8,
        'color': '#1a1a1a',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 96,
        'shape': 'round-rectangle',
        'width': 'data(w)',
        'height': 'data(h)',
      },
    },
    {
      selector: 'node.dim',
      style: { 'opacity': 0.35 },
    },
    {
      selector: 'node:selected',
      style: { 'border-width': 2.5, 'border-color': '#1f4e79' },
    },
    {
      selector: 'edge',
      style: {
        'width': 1,
        'line-color': '#d6d4cc',
        'curve-style': 'bezier',
        'target-arrow-color': '#8a8a83',
      },
    },
  ];
}

/** Members and their connections, placed by their real position in the frame. */
export function spatialGraph(container, parts, { onPick } = {}) {
  if (!window.cytoscape) return null;

  const seen = new Set();
  const elements = [];

  for (const p of parts) {
    const o = p.origin || { x: 0, y: 0, z: 0 };
    // Isometric projection of the artefact's own coordinates.
    // Spread far enough that boxes do not pile up; cytoscape fits to view after.
    const x = (o.x - o.z) * 460;
    const y = (-(o.y) * 460) + (o.x + o.z) * 110;
    elements.push({
      group: 'nodes',
      data: {
        id: p.id,
        label: p.id.replace(/_/g, ' '),
        fill: STATUS_FILL[p.status] || STATUS_FILL.intact,
        w: 104, h: 26,
        status: p.status,
      },
      position: { x, y },
    });
  }

  const ids = new Set(parts.map(p => p.id));
  for (const p of parts) {
    for (const other of p.connections || []) {
      if (!ids.has(other)) continue;
      const key = [p.id, other].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push({ group: 'edges', data: { id: `e_${key}`, source: p.id, target: other } });
    }
  }

  const cy = window.cytoscape({
    container,
    elements,
    style: baseStyle(),
    layout: { name: 'preset', fit: true, padding: 30 },
    wheelSensitivity: 0.25,
    maxZoom: 3,
    minZoom: 0.2,
  });
  cy.on('tap', 'node', evt => onPick?.(evt.target.id()));
  return cy;
}

/** The steps of one strategy, ranked by their dependencies. */
export function actionGraph(container, strategy, { onPick } = {}) {
  if (!window.cytoscape) return null;
  ensureDagre();

  if (!strategy) return null;
  const steps = strategy.steps || [];
  const colour = strategy.color || '#1f4e79';
  const elements = steps.map((s, i) => ({
    group: 'nodes',
    data: {
      id: s.id,
      label: `${String(i + 1).padStart(2, '0')}  ${s.title}`,
      fill: colour,
      w: 150, h: 46,
    },
  }));

  const stepIds = new Set(steps.map(s => s.id));
  const edges = (strategy.edges || []).filter(e => stepIds.has(e.source) && stepIds.has(e.target));
  for (const e of edges) {
    elements.push({ group: 'edges', data: { id: e.id || `${e.source}->${e.target}`, source: e.source, target: e.target } });
  }
  // A plan with no recorded dependencies still has an order; show it as a chain
  // rather than as a scatter of unconnected boxes.
  if (!edges.length) {
    for (let i = 1; i < steps.length; i++) {
      elements.push({ group: 'edges', data: { id: `seq_${i}`, source: steps[i - 1].id, target: steps[i].id, seq: 1 } });
    }
  }

  const style = baseStyle().concat([
    {
      selector: 'node',
      style: {
        'color': '#ffffff',
        'font-size': 9,
        'text-max-width': 136,
        'border-color': '#1a1a1a',
      },
    },
    {
      selector: 'edge',
      style: {
        'width': 1.4,
        'line-color': '#8a8a83',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#8a8a83',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
      },
    },
    { selector: 'edge[seq]', style: { 'line-style': 'dashed' } },
    {
      selector: 'node[intent]',
      style: { 'border-style': 'dashed', 'border-width': 1.4, 'font-size': 10, 'text-max-width': 190 },
    },
  ]);

  // A strategy that was left at intent is still a strategy: show the intent as
  // the single thing that was planned rather than an empty pane.
  if (!steps.length) {
    const only = window.cytoscape({
      container,
      elements: [{ group: 'nodes', data: { id: 'intent', label: strategy.label, fill: colour, w: 220, h: 62, intent: 1 } }],
      style,
      layout: { name: 'grid', fit: false },
      wheelSensitivity: 0.25,
      maxZoom: 2,
      minZoom: 0.4,
    });
    only.zoom(1);
    only.center();
    only.on('tap', 'node', () => onPick?.('intent'));
    return only;
  }

  const cy = window.cytoscape({
    container,
    elements,
    style,
    layout: dagreRegistered
      ? { name: 'dagre', rankDir: 'TB', nodeSep: 22, rankSep: 42, fit: true, padding: 24 }
      : { name: 'breadthfirst', directed: true, spacingFactor: 1.1, fit: true, padding: 24 },
    wheelSensitivity: 0.25,
    maxZoom: 3,
    minZoom: 0.2,
  });
  cy.on('tap', 'node', evt => onPick?.(evt.target.id()));
  return cy;
}
