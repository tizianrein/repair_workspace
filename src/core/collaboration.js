/**
 * Cloudflare collaboration client.
 *
 * The browser still owns the normal Repair Workspace state and undo history.
 * This module only exchanges project templates and participant condition
 * layers with the Cloudflare Worker.
 */

const configuredOrigin = String(import.meta.env?.VITE_COLLAB_API_URL || '').replace(/\/$/, '');
const API_ROOT = configuredOrigin.endsWith('/api/collaboration')
  ? configuredOrigin
  : `${configuredOrigin}/api/collaboration`;

function apiUrl(path) {
  return `${API_ROOT}${path}`;
}

async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      ...(options.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    throw new Error(payload?.error || `Collaboration request failed (${response.status})`);
  }
  return payload;
}

function isConditionEvidence(evidence, condition, referencedEvidenceIds = new Set()) {
  return (
    (evidence?.attachedTo?.type === 'condition' && evidence.attachedTo.id === condition.id)
    || referencedEvidenceIds.has(evidence?.id)
    || evidence?.confirmsConditionRef === condition.id
    || evidence?.refutesConditionRef === condition.id
  );
}

function sharedEvidenceRecord(evidence) {
  return {
    id: evidence.id,
    kind: evidence.kind,
    attachedTo: evidence.attachedTo || null,
    capturedAt: evidence.capturedAt || null,
    capturedBy: evidence.capturedBy || null,
    url: evidence.url || null,
    text: evidence.text || null,
    measurement: evidence.measurement || null,
    confirmsConditionRef: evidence.confirmsConditionRef || null,
    refutesConditionRef: evidence.refutesConditionRef || null,
    fileName: evidence.fileName || null,
    byteSize: Number(evidence.byteSize || 0),
    mimeType: evidence.mimeType || null,
  };
}

export function normalizeAuthorName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function normalizeAuthorKey(value) {
  return normalizeAuthorName(value).toLocaleLowerCase('en-US');
}

export function createProjectId() {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return `proj_${random}`;
}

export function exampleProjectId(slug) {
  return `example:${String(slug).replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
}

export function projectShareUrl(projectId) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('project', projectId);
  return url.toString();
}

export function projectTemplate(workspace, projectId) {
  const baseEvidence = (workspace.evidence || []).filter(evidence =>
    evidence.attachedTo?.type !== 'condition'
    && !evidence.confirmsConditionRef
    && !evidence.refutesConditionRef
  );
  return {
    ...JSON.parse(JSON.stringify(workspace)),
    collaboration: { projectId, modelVersion: '1' },
    conditions: [],
    evidence: baseEvidence,
  };
}

export function conditionLayerSnapshot(workspace, authorName) {
  const normalizedName = normalizeAuthorName(authorName);
  const authorKey = normalizeAuthorKey(normalizedName);
  const evidence = workspace.evidence || [];
  return (workspace.conditions || []).map(condition => {
    const referencedEvidenceIds = new Set(condition.evidenceRefs || []);
    const evidenceRecords = evidence
      .filter(item => isConditionEvidence(item, condition, referencedEvidenceIds))
      .map(sharedEvidenceRecord);
    return {
      ...condition,
      authorName: normalizedName,
      authorKey,
      evidenceRecords,
    };
  });
}

export function mergeConditionLayer(workspace, incomingConditions) {
  const incoming = incomingConditions || [];
  const incomingIds = new Set(incoming.map(condition => condition.id));
  const oldConditionEvidenceIds = new Set(
    (workspace.conditions || []).flatMap(condition => condition.evidenceRefs || []),
  );
  const baseEvidence = (workspace.evidence || []).filter(evidence =>
    evidence.attachedTo?.type !== 'condition'
    && !oldConditionEvidenceIds.has(evidence.id)
    && !evidence.confirmsConditionRef
    && !evidence.refutesConditionRef,
  );
  const retainedLocalEvidence = (workspace.evidence || []).filter(evidence =>
    evidence.attachedTo?.type === 'condition'
    && incomingIds.has(evidence.attachedTo.id),
  );
  const remoteEvidence = incoming.flatMap(condition =>
    Array.isArray(condition.evidenceRecords) ? condition.evidenceRecords : [],
  );
  const evidenceById = new Map();
  [...retainedLocalEvidence, ...remoteEvidence].forEach(evidence => {
    if (evidence?.id) evidenceById.set(evidence.id, evidence);
  });
  const conditions = incoming.map(condition => {
    const { evidenceRecords: _evidenceRecords, ...cleanCondition } = condition;
    return cleanCondition;
  });
  return {
    conditions,
    evidence: [...baseEvidence, ...evidenceById.values()],
  };
}

export const CollaborationApi = {
  async ensureProject({ projectId, title, baseWorkspace, sourceType = 'custom', sourceRef = null }) {
    const payload = await request(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        title,
        baseWorkspace,
        sourceType,
        sourceRef,
        modelVersion: baseWorkspace?.collaboration?.modelVersion || '1',
      }),
    });
    return payload.project;
  },

  async getProject(projectId) {
    const payload = await request(`/projects/${encodeURIComponent(projectId)}`);
    return payload.project;
  },

  async getConditions(projectId, authorName = null) {
    const query = authorName ? `?author=${encodeURIComponent(normalizeAuthorKey(authorName))}` : '';
    const payload = await request(`/projects/${encodeURIComponent(projectId)}/conditions${query}`);
    return payload.conditions || [];
  },

  async saveConditions(projectId, authorName, conditions) {
    const authorKey = normalizeAuthorKey(authorName);
    return request(`/projects/${encodeURIComponent(projectId)}/conditions?author=${encodeURIComponent(authorKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ authorName: normalizeAuthorName(authorName), conditions }),
    });
  },

  async getAuthors(projectId) {
    const payload = await request(`/projects/${encodeURIComponent(projectId)}/authors`);
    return payload.authors || [];
  },

  async uploadEvidence(projectId, evidence, blob, authorName) {
    return request(
      `/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(evidence.id)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': blob.type || evidence.mimeType || 'image/jpeg',
          'X-File-Name': encodeURIComponent(evidence.fileName || evidence.id),
          'X-Author-Name': encodeURIComponent(normalizeAuthorName(authorName)),
        },
        body: blob,
      },
    );
  },

  async getEvidence(projectId, evidenceId) {
    const response = await fetch(apiUrl(
      `/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(evidenceId)}`,
    ));
    if (response.status === 404) return null;
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch {}
      throw new Error(payload?.error || `Photo download failed (${response.status})`);
    }
    const encodedName = response.headers.get('X-File-Name') || '';
    let name = evidenceId;
    try { name = decodeURIComponent(encodedName) || evidenceId; } catch {}
    return { blob: await response.blob(), name };
  },
};
