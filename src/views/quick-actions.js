/**
 * Quick-action chips.
 *
 * Lives below the chat input. Different chips appear based on what's selected
 * and what's loaded. Each chip bundles the current chat input (if any) plus a
 * pre-set propose scope and dispatches the propose call.
 *
 * The chips are explicit affordances for the workshop's three phases:
 *   - Phase 1 (Knowledge): Extract assembly · Add hypothesis · Update hypotheses
 *   - Phase 2 (Design):    Generate plan · Replan · Suggest alternatives
 *   - Phase 3 (Guidance):  Replan from here · Mark complete · Discuss step
 */

export function createQuickActions(container, { getScope, getWorkspace, getCurrentMessage, onPropose, onMarkComplete }) {
  function render() {
    const ws = getWorkspace();
    const { scope, ref } = getScope();
    const hasAssembly = (ws.instance?.parts || []).length > 0;
    const hasHypotheses = (ws.hypotheses || []).length > 0;
    const hasPlan = ws.plans?.some(p => p.id === ws.currentPlanId && p.steps?.length);

    const chips = [];

    if (scope === 'step' && ref) {
      chips.push({ label: '✓ Mark complete', cls: 'accent', onClick: () => onMarkComplete?.(ref) });
      chips.push({ label: '♻️ Replan from here', cls: '', scope: 'interventions', extra: `Starting from step ${ref}` });
      chips.push({ label: '💡 Suggest alternative', cls: '', scope: 'interventions', extra: `Suggest an alternative for step ${ref}` });
    } else if (scope === 'hypothesis' && ref) {
      chips.push({ label: '✓ Confirm', cls: 'accent', scope: 'hypotheses', extra: `Confirm hypothesis ${ref}` });
      chips.push({ label: '✗ Refute', cls: '', scope: 'hypotheses', extra: `Refute hypothesis ${ref}` });
      chips.push({ label: '📝 Update plan', cls: '', scope: 'interventions', extra: `Update the plan to account for this hypothesis` });
    } else if (scope === 'part' && ref) {
      chips.push({ label: '+ Add hypothesis', cls: 'primary', scope: 'hypotheses', extra: `Add a hypothesis on part ${ref}` });
      chips.push({ label: '🔧 Plan for this part', cls: '', scope: 'interventions', extra: `Generate or update plan focusing on ${ref}` });
    } else {
      if (!hasAssembly) {
        chips.push({ label: '🧱 Extract assembly', cls: 'primary', scope: 'assembly' });
      } else {
        chips.push({ label: '📍 Catalog hypotheses', cls: hasHypotheses ? '' : 'primary', scope: 'hypotheses' });
        if (hasHypotheses && !hasPlan) {
          chips.push({ label: '📝 Generate plan', cls: 'primary', scope: 'interventions' });
        } else if (hasPlan) {
          chips.push({ label: '♻️ Replan', cls: '', scope: 'interventions' });
          chips.push({ label: '📝 New plan variant', cls: '', scope: 'interventions', extra: 'Generate an alternative plan with different priorities' });
        }
        chips.push({ label: '🔍 Update assembly', cls: '', scope: 'assembly' });
      }
    }

    container.innerHTML = '';
    chips.forEach(chip => {
      const btn = document.createElement('button');
      btn.className = `qa-btn ${chip.cls || ''}`;
      btn.textContent = chip.label;
      btn.onclick = chip.onClick || (() => {
        const msg = getCurrentMessage() || chip.extra || chip.label;
        onPropose?.({ scope: chip.scope, userMessage: msg });
      });
      container.appendChild(btn);
    });
  }

  return { render };
}
