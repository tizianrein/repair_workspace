/** Read-only presentation of repair geometry authored in Grasshopper. */

import {
  indexRepairProposals,
  proposalSummary,
  stepProposalEntries,
} from '../core/repair-proposals.js';

export function createRepairProposalView({ sectionEl, countEl, listEl, onOpenStep }) {
  function render(workspace) {
    const index = indexRepairProposals(workspace);
    const count = index.proposals.length;
    sectionEl.hidden = count === 0;
    countEl.textContent = String(count);
    listEl.replaceChildren();

    index.proposals.forEach(proposal => {
      const id = String(proposal.id || '');
      const summary = proposalSummary(proposal, index.linksByProposalId.get(id));
      listEl.appendChild(proposalCard(summary, { onOpenStep }));
    });
  }

  return { render };
}

/** Add the explicit refs saved on one action step to its detail window. */
export function appendStepRepairProposals(parentEl, workspace, step) {
  const entries = stepProposalEntries(workspace, step);
  if (!entries.length) return;

  const section = element('section', 'detail-section repair-step-proposals');
  section.appendChild(element(
    'div',
    'detail-section-label',
    `Repair geometry (${entries.length} ${entries.length === 1 ? 'reference' : 'references'})`,
  ));

  entries.forEach(entry => {
    if (!entry.proposal) {
      const missing = element('div', 'repair-proposal-card missing');
      missing.appendChild(element('div', 'repair-proposal-title', entry.id));
      missing.appendChild(element('div', 'repair-proposal-warning', 'Referenced proposal is missing from this Workspace.'));
      section.appendChild(missing);
      return;
    }
    section.appendChild(proposalCard(proposalSummary(entry.proposal), { compact: true }));
  });
  parentEl.appendChild(section);
}

function proposalCard(summary, { compact = false, onOpenStep = null } = {}) {
  const card = element('article', `repair-proposal-card decision-${classToken(summary.decision)}`);

  const head = element('div', 'repair-proposal-head');
  const heading = element('div');
  heading.appendChild(element('div', 'repair-proposal-title', summary.title));
  heading.appendChild(element('div', 'repair-proposal-id', summary.id));
  head.appendChild(heading);
  head.appendChild(element('span', 'repair-proposal-decision', decisionLabel(summary.decision)));
  card.appendChild(head);

  if (summary.partRefs.length) {
    card.appendChild(labelledLine('Parts', summary.partRefs.join(', ')));
  }
  if (summary.actionRefs.length) {
    card.appendChild(labelledLine('Actions', summary.actionRefs.join(', ')));
  }
  if (summary.geometryArtifact) {
    card.appendChild(artifactLine(summary.geometryArtifact));
  }

  const measures = statusDescription(summary.factCounts, summary.factTotal, 'fact');
  const checks = statusDescription(summary.complianceCounts, summary.complianceTotal, 'binding check');
  const status = element('div', 'repair-proposal-status');
  status.appendChild(element('span', '', measures));
  status.appendChild(element('span', '', checks));
  card.appendChild(status);

  if (summary.decisionRationale) {
    card.appendChild(labelledLine('Decision note', summary.decisionRationale));
  }
  if (summary.revisionNote) {
    card.appendChild(labelledLine('Revision', summary.revisionNote));
  }

  if (!compact && summary.links.length) {
    const links = element('div', 'repair-proposal-links');
    summary.links.forEach(link => {
      const button = element('button', 'repair-proposal-step-link', `${link.planLabel} · ${link.stepTitle}`);
      button.type = 'button';
      button.onclick = () => onOpenStep?.(link);
      links.appendChild(button);
    });
    card.appendChild(links);
  }

  if (summary.recordedAt) {
    const date = readableDate(summary.recordedAt);
    if (date) card.appendChild(element('div', 'repair-proposal-date', `Recorded ${date}`));
  }
  return card;
}

function labelledLine(label, value) {
  const row = element('div', 'repair-proposal-line');
  row.appendChild(element('span', 'repair-proposal-line-label', `${label}:`));
  row.appendChild(document.createTextNode(` ${value}`));
  return row;
}

function artifactLine(artifact) {
  const details = [];
  if (artifact.path) details.push(artifact.path);
  if (artifact.format) details.push(artifact.format.toUpperCase());
  if (artifact.entityCount !== null) {
    details.push(`${artifact.entityCount} ${artifact.entityCount === 1 ? 'entity' : 'entities'}`);
  }
  if (artifact.shortHash) details.push(`SHA-256 ${artifact.shortHash}`);
  const row = labelledLine('Geometry file', details.join(' · '));
  row.classList.add('repair-proposal-artifact');
  if (artifact.sha256) row.title = `Full SHA-256: ${artifact.sha256}`;
  return row;
}

function statusDescription(counts, total, singular) {
  if (!total) return `No ${singular}s recorded`;
  const base = `${total} ${total === 1 ? singular : singular + 's'}`;
  const details = [];
  if (counts.measured) details.push(`${counts.measured} measured`);
  if (counts.satisfied) details.push(`${counts.satisfied} satisfied`);
  if (counts.not_satisfied) details.push(`${counts.not_satisfied} not satisfied`);
  const unresolved = (counts.unknown || 0) + (counts.failed_to_compute || 0);
  if (unresolved) details.push(`${unresolved} unresolved`);
  if (counts.not_applicable) details.push(`${counts.not_applicable} n/a`);
  return details.length ? `${base} · ${details.join(' · ')}` : base;
}

function decisionLabel(decision) {
  return decision === 'undecided'
    ? 'Awaiting decision'
    : `Human: ${decision.replace(/_/g, ' ')}`;
}

function readableDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function classToken(value) {
  return String(value || 'undecided').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function element(tag, className = '', text = undefined) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
