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
};
