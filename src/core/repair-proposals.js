/**
 * Read the optional repair-geometry records written by the Grasshopper tool.
 *
 * These fields extend the Workspace without changing its core schema:
 *   workspace.repairGeometryProposals[]
 *   step.repairGeometryProposalRefs[]
 *
 * Keep this module DOM-free so malformed workshop files can be inspected and
 * the indexing behaviour can be tested without a browser.
 */

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function uniqueText(values) {
  return [...new Set(list(values).map(value => text(value)).filter(Boolean))];
}

export function repairProposals(workspace) {
  return list(workspace?.repairGeometryProposals).filter(item => item && typeof item === 'object');
}

/** Index proposals and the plan steps that explicitly reference them. */
export function indexRepairProposals(workspace) {
  const proposals = repairProposals(workspace);
  const byId = new Map();
  const linksByProposalId = new Map();

  proposals.forEach((proposal, position) => {
    const id = text(proposal.id, `proposal_${position + 1}`);
    if (!byId.has(id)) byId.set(id, proposal);
  });

  list(workspace?.plans).forEach(plan => {
    list(plan?.steps).forEach(step => {
      uniqueText(step?.repairGeometryProposalRefs).forEach(proposalId => {
        const links = linksByProposalId.get(proposalId) || [];
        links.push({
          planId: text(plan?.id),
          planLabel: text(plan?.label, text(plan?.id, 'Untitled strategy')),
          stepId: text(step?.id),
          stepTitle: text(step?.title, text(step?.id, 'Untitled step')),
        });
        linksByProposalId.set(proposalId, links);
      });
    });
  });

  return { proposals, byId, linksByProposalId };
}

/** Resolve a step's stored refs in their saved order, including missing IDs. */
export function stepProposalEntries(workspace, step) {
  const index = indexRepairProposals(workspace);
  return uniqueText(step?.repairGeometryProposalRefs).map(id => ({
    id,
    proposal: index.byId.get(id) || null,
  }));
}

function countedStatuses(records, key = 'status') {
  const counts = {};
  list(records).forEach(record => {
    const status = text(record?.[key], 'unlabelled');
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

function geometryArtifactSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const path = text(value.path);
  const format = text(value.format);
  const sha256 = text(value.sha256);
  const numericCount = Number(value.entityCount);
  const entityCount = Number.isInteger(numericCount) && numericCount >= 0
    ? numericCount
    : null;
  if (!path && !format && !sha256 && entityCount === null) return null;

  return {
    path,
    format,
    entityCount,
    sha256,
    shortHash: sha256.length > 12 ? `${sha256.slice(0, 12)}…` : sha256,
  };
}

/** A defensive, compact view model for one open proposal record. */
export function proposalSummary(proposal, links = []) {
  const manifest = proposal?.candidate?.manifest || {};
  const decisionRecord = proposal?.decision;
  const decision = text(
    typeof decisionRecord === 'object' ? decisionRecord?.decision : decisionRecord,
    'undecided',
  ).toLowerCase();
  const facts = list(proposal?.facts?.facts).length
    ? list(proposal.facts.facts)
    : list(proposal?.candidate?.facts);
  const compliance = list(proposal?.requirements?.compliance);
  const evaluations = compliance.map(item => item?.evaluation || {});

  return {
    id: text(proposal?.id, 'unnamed proposal'),
    title: text(manifest?.title, text(proposal?.candidateId, 'Repair geometry')),
    candidateId: text(proposal?.candidateId, text(manifest?.id)),
    versionId: text(proposal?.version?.id),
    decision,
    decisionRationale: text(decisionRecord?.rationale),
    recordedAt: text(proposal?.recordedAt),
    partRefs: uniqueText(proposal?.partRefs || manifest?.partRefs),
    actionRefs: uniqueText(proposal?.actionRefs || manifest?.actionRefs),
    factCounts: countedStatuses(facts),
    complianceCounts: countedStatuses(evaluations),
    factTotal: facts.length,
    complianceTotal: compliance.length,
    revisionNote: text(proposal?.version?.note || manifest?.revisionNote),
    geometryArtifact: geometryArtifactSummary(proposal?.geometryArtifact),
    links: list(links),
  };
}
