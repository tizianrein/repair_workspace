/**
 * Action graph view.
 *
 * Renders the current plan as a Cytoscape graph. Nodes are steps; edges are
 * prerequisites. Mutex groups are drawn as compound parent nodes containing
 * their alternative steps — Cytoscape handles the visual grouping for free.
 *
 * Interactions in pass 2a:
 *   - tap node → select as current step (highlight + notify caller)
 *   - tap background → deselect
 *   - dbltap node → opens detail modal via onDetail callback
 *
 * Edit-mode (drag to connect, etc.) lands in pass 2b alongside the AI loop.
 */

import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
cytoscape.use(dagre);

export function createActionGraph(container, { onSelect, onDetail }) {
  let cy = null;
  let currentStepId = null;

  function render(workspace) {
    const plan = (workspace.plans || []).find(p => p.id === workspace.currentPlanId);
    if (!plan || !plan.steps?.length) {
      container.innerHTML = `<div class="pane-empty">
        No plan yet.<br><br>
        Generate one using the chat sheet (💬 button).<br>
        Or load the example chair to see what a plan looks like.
      </div>`;
      cy = null;
      return;
    }
    container.innerHTML = '';

    const mutexByStep = new Map();
    (plan.mutexGroups || []).forEach(g => {
      g.stepIds.forEach(sid => mutexByStep.set(sid, g.id));
    });

    const nodes = [];
    (plan.mutexGroups || []).forEach(g => {
      nodes.push({
        data: {
          id: `mutex:${g.id}`,
          label: g.label,
          isMutex: true,
          selected: g.selectedStepId ? true : false
        },
        classes: 'mutex-parent'
      });
    });
    plan.steps.forEach(step => {
      const parent = mutexByStep.get(step.id);
      const mutex = parent ? plan.mutexGroups.find(g => g.id === parent) : null;
      const isMutexSelected = mutex?.selectedStepId === step.id;
      const enrichingIds = window.__getEnrichingStepIds?.() || new Set();
      nodes.push({
        data: {
          id: step.id,
          label: step.title || step.id,
          parent: parent ? `mutex:${parent}` : undefined,
          status: step.status,
          confidence: step.confidence ?? 0.7,
          optional: !!step.optional,
          inMutex: !!parent,
          mutexSelected: isMutexSelected,
          active: step.id === currentStepId,
          enriching: enrichingIds.has(step.id)
        }
      });
    });

    const edges = (plan.edges || []).map(e => ({ data: { id: e.id, source: e.source, target: e.target } }));

    cy = cytoscape({
      container,
      elements: [...nodes, ...edges],
      style: [
        {
          selector: 'node[!isMutex]',
          style: {
            'background-color': '#ffffff',
            'border-color': '#1a1a1a',
            'border-width': 1.2,
            'shape': 'ellipse',
            'width': 88, 'height': 88,
            'label': 'data(label)', 'color': '#1a1a1a',
            'font-family': 'Inter Tight, system-ui, sans-serif',
            'font-size': 11,
            'text-wrap': 'wrap', 'text-max-width': 76,
            'text-valign': 'center', 'text-halign': 'center'
          }
        },
        { selector: 'node[?optional]', style: { 'border-style': 'dashed' } },
        { selector: 'node[status = "completed"]', style: { 'background-color': '#e8f3e0', 'border-color': '#27500a' } },
        { selector: 'node[status = "skipped"]', style: { 'opacity': 0.45 } },
        { selector: 'node[?active]', style: {
            'background-color': '#cfe0ee',
            'border-color': '#1f4e79',
            'border-width': 3
          }
        },
        { selector: 'node[?inMutex][!mutexSelected]', style: { 'opacity': 0.6 } },
        { selector: 'node[?mutexSelected]', style: { 'border-color': '#c1272d', 'border-width': 2.5 } },
        // "Being enriched in Phase B" — dotted blue border, subtle, doesn't
        // overpower other status colors. Cytoscape doesn't animate, so the
        // pulse happens via a class we toggle (see periodicPulse below).
        { selector: 'node[?enriching]', style: {
            'border-style': 'dotted',
            'border-color': '#1f4e79',
            'border-width': 2
          }
        },
        { selector: 'node.enrich-pulse', style: {
            'border-color': '#3a7bb8'
          }
        },
        {
          selector: '.mutex-parent',
          style: {
            'background-color': '#fffaf5',
            'background-opacity': 0.7,
            'border-color': '#c1272d',
            'border-width': 1,
            'border-style': 'dashed',
            'label': 'data(label)',
            'font-family': 'JetBrains Mono, monospace',
            'font-size': 10,
            'color': '#7a1418',
            'text-valign': 'top', 'text-halign': 'center',
            'text-margin-y': -6,
            'padding': 18,
            'shape': 'round-rectangle',
            'corner-radius': 8
          }
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'line-color': '#5a5a55',
            'target-arrow-color': '#5a5a55',
            'width': 1.4, 'arrow-scale': 0.9
          }
        }
      ],
      layout: { name: 'dagre', rankDir: 'LR', nodeSep: 50, rankSep: 80, padding: 30 },
      wheelSensitivity: 0.2,
      minZoom: 0.3, maxZoom: 3
    });

    cy.on('tap', 'node', evt => {
      if (evt.target.data('isMutex')) return;
      const id = evt.target.id();
      currentStepId = id;
      cy.nodes('[!isMutex]').forEach(n => n.data('active', n.id() === id));
      onSelect?.(id);
    });
    cy.on('tap', evt => {
      if (evt.target === cy) {
        currentStepId = null;
        cy.nodes('[!isMutex]').forEach(n => n.data('active', false));
        onSelect?.(null);
      }
    });
    cy.on('dbltap', 'node[!isMutex]', evt => onDetail?.(evt.target.id()));
    startPulse();
  }

  // Periodic pulse on enriching nodes — toggles a class every 700ms.
  // Cleared automatically when no nodes are enriching.
  let pulseTimer = null;
  function startPulse() {
    if (pulseTimer) return;
    pulseTimer = setInterval(() => {
      if (!cy) return;
      const enriching = cy.nodes('[?enriching]');
      if (!enriching.length) {
        clearInterval(pulseTimer);
        pulseTimer = null;
        return;
      }
      enriching.forEach(n => n.toggleClass('enrich-pulse'));
    }, 700);
  }

  return {
    render,
    setCurrentStep(stepId) {
      currentStepId = stepId;
      if (cy) cy.nodes('[!isMutex]').forEach(n => n.data('active', n.id() === stepId));
    },
    fit() { if (cy) cy.fit(undefined, 30); },
    resize() { if (cy) cy.resize(); }
  };
}
