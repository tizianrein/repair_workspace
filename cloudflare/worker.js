const API_PREFIX = '/api/collaboration';
const MAX_PROJECT_BYTES = 1_800_000;
const MAX_CONDITIONS = 1_000;
const MAX_EVIDENCE_BYTES = 6_000_000;

export function normalizeAuthorKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

export function normalizeAuthorName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function isValidProjectId(value) {
  return /^[a-zA-Z0-9:_-]{1,120}$/.test(String(value ?? ''));
}

export function isValidEvidenceId(value) {
  return /^[a-zA-Z0-9:_-]{1,160}$/.test(String(value ?? ''));
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const configured = String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (!origin || configured.includes('*')) {
    return { 'Access-Control-Allow-Origin': origin || '*' };
  }
  if (configured.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return null;
}

function json(request, env, payload, status = 200, extraHeaders = {}) {
  const cors = corsHeaders(request, env) || {};
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors,
      ...extraHeaders,
    },
  });
}

function empty(request, env, status = 204, extraHeaders = {}) {
  return new Response(null, {
    status,
    headers: { ...(corsHeaders(request, env) || {}), ...extraHeaders },
  });
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_PROJECT_BYTES) throw new HttpError(413, 'Request body is too large');
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseConditionRows(rows) {
  return (rows || []).flatMap(row => {
    try {
      const condition = JSON.parse(row.condition_data);
      return [{
        ...condition,
        authorName: row.author_name,
        authorKey: row.author_key,
      }];
    } catch {
      return [];
    }
  });
}

async function getProject(env, projectId) {
  return env.DB.prepare(`
    SELECT id, title, base_workspace, model_key, model_version,
           source_type, source_ref, created_at, updated_at
    FROM rw_projects
    WHERE id = ?
  `).bind(projectId).first();
}

async function handlePutProject(request, env, projectId) {
  const body = await readJson(request);
  const title = String(body.title || body.baseWorkspace?.instance?.name || 'Untitled project').trim().slice(0, 160);
  const sourceType = String(body.sourceType || 'custom').trim().slice(0, 32);
  const sourceRef = body.sourceRef ? String(body.sourceRef).trim().slice(0, 160) : null;
  const modelVersion = String(body.modelVersion || '1').trim().slice(0, 80);
  const workspace = body.baseWorkspace;

  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new HttpError(400, 'baseWorkspace is required');
  }

  // Participant observations live in rw_conditions. Keeping the project
  // template condition-free prevents one person's layer becoming the next
  // participant's starting data.
  const baseWorkspace = JSON.stringify({ ...workspace, conditions: [] });
  if (new TextEncoder().encode(baseWorkspace).byteLength > MAX_PROJECT_BYTES) {
    throw new HttpError(413, 'The project workspace exceeds the D1 row limit');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO rw_projects (
      id, title, base_workspace, model_version, source_type, source_ref,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      base_workspace = excluded.base_workspace,
      model_version = excluded.model_version,
      source_type = excluded.source_type,
      source_ref = excluded.source_ref,
      updated_at = excluded.updated_at
  `).bind(
    projectId, title, baseWorkspace, modelVersion, sourceType, sourceRef, now, now,
  ).run();

  const project = await getProject(env, projectId);
  return json(request, env, { project: serializeProject(project) }, 200);
}

function serializeProject(row) {
  if (!row) return null;
  let baseWorkspace = null;
  try { baseWorkspace = JSON.parse(row.base_workspace); } catch {}
  return {
    id: row.id,
    title: row.title,
    baseWorkspace,
    modelKey: row.model_key || null,
    modelVersion: row.model_version,
    sourceType: row.source_type,
    sourceRef: row.source_ref || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleGetConditions(request, env, projectId, url) {
  const requestedAuthor = normalizeAuthorKey(url.searchParams.get('author'));
  let result;
  if (requestedAuthor) {
    result = await env.DB.prepare(`
      SELECT author_name, author_key, condition_data
      FROM rw_conditions
      WHERE project_id = ? AND author_key = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).bind(projectId, requestedAuthor).all();
  } else {
    result = await env.DB.prepare(`
      SELECT author_name, author_key, condition_data
      FROM rw_conditions
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).bind(projectId).all();
  }
  return json(request, env, { conditions: parseConditionRows(result.results) });
}

async function handlePutConditions(request, env, projectId, url) {
  const body = await readJson(request);
  const authorName = normalizeAuthorName(body.authorName);
  const nameKey = normalizeAuthorKey(authorName);
  const requestedKey = normalizeAuthorKey(url.searchParams.get('author'));
  const authorKey = requestedKey || nameKey;
  if (!authorName || !authorKey) throw new HttpError(400, 'authorName is required');
  if (requestedKey && requestedKey !== nameKey) {
    throw new HttpError(400, 'author query must match authorName');
  }
  if (!Array.isArray(body.conditions)) throw new HttpError(400, 'conditions must be an array');
  if (body.conditions.length > MAX_CONDITIONS) {
    throw new HttpError(413, `A participant can store at most ${MAX_CONDITIONS} conditions per project`);
  }

  const now = new Date().toISOString();
  const conditions = body.conditions.map(condition => {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
      throw new HttpError(400, 'Every condition must be an object');
    }
    const id = String(condition.id || '');
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) {
      throw new HttpError(400, `Invalid condition id: ${id || '(missing)'}`);
    }
    const createdAt = typeof condition.createdAt === 'string' ? condition.createdAt : now;
    const status = ['suspected', 'confirmed', 'refuted'].includes(condition.status)
      ? condition.status
      : 'suspected';
    const confidenceValue = Number(condition.confidence);
    return {
      ...condition,
      id,
      type: String(condition.type || 'observation').trim().slice(0, 160),
      description: String(condition.description || '').slice(0, 8_000),
      partRef: condition.partRef ? String(condition.partRef).slice(0, 160) : null,
      coordinates: condition.coordinates && typeof condition.coordinates === 'object'
        ? condition.coordinates
        : null,
      status,
      confidence: Number.isFinite(confidenceValue)
        ? Math.min(1, Math.max(0, confidenceValue))
        : 0.5,
      evidenceRefs: Array.isArray(condition.evidenceRefs)
        ? condition.evidenceRefs.map(value => String(value).slice(0, 160)).slice(0, 100)
        : [],
      evidenceRecords: Array.isArray(condition.evidenceRecords)
        ? condition.evidenceRecords
          .filter(evidence => evidence && typeof evidence === 'object' && !Array.isArray(evidence))
          .slice(0, 100)
          .map(evidence => ({
            id: isValidEvidenceId(evidence.id) ? String(evidence.id) : null,
            kind: String(evidence.kind || 'photo').slice(0, 32),
            attachedTo: evidence.attachedTo && typeof evidence.attachedTo === 'object'
              ? {
                type: String(evidence.attachedTo.type || '').slice(0, 32),
                id: String(evidence.attachedTo.id || '').slice(0, 160),
              }
              : null,
            capturedAt: typeof evidence.capturedAt === 'string' ? evidence.capturedAt : null,
            capturedBy: evidence.capturedBy ? String(evidence.capturedBy).slice(0, 80) : null,
            url: evidence.url ? String(evidence.url).slice(0, 320) : null,
            text: evidence.text ? String(evidence.text).slice(0, 8_000) : null,
            measurement: evidence.measurement && typeof evidence.measurement === 'object'
              ? evidence.measurement
              : null,
            confirmsConditionRef: evidence.confirmsConditionRef
              ? String(evidence.confirmsConditionRef).slice(0, 160)
              : null,
            refutesConditionRef: evidence.refutesConditionRef
              ? String(evidence.refutesConditionRef).slice(0, 160)
              : null,
            fileName: evidence.fileName ? String(evidence.fileName).slice(0, 240) : null,
            byteSize: Math.max(0, Number(evidence.byteSize || 0)),
            mimeType: evidence.mimeType ? String(evidence.mimeType).slice(0, 120) : null,
          }))
          .filter(evidence => evidence.id)
        : [],
      authorName,
      authorKey,
      createdAt,
      updatedAt: now,
    };
  });

  const serialized = JSON.stringify(conditions);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PROJECT_BYTES) {
    throw new HttpError(413, 'The condition layer is too large');
  }

  const markDeleted = env.DB.prepare(`
    UPDATE rw_conditions
    SET deleted_at = ?, updated_at = ?
    WHERE project_id = ? AND author_key = ? AND deleted_at IS NULL
  `).bind(now, now, projectId, authorKey);

  // json_each keeps the snapshot replacement at two D1 statements even for
  // large workshops, avoiding the per-request query limit.
  const upsertSnapshot = env.DB.prepare(`
    INSERT INTO rw_conditions (
      project_id, id, author_key, author_name, condition_data,
      created_at, updated_at, deleted_at
    )
    SELECT
      ?,
      json_extract(value, '$.id'),
      ?,
      ?,
      value,
      COALESCE(json_extract(value, '$.createdAt'), ?),
      ?,
      NULL
    FROM json_each(?)
    WHERE json_type(value) = 'object'
      AND json_extract(value, '$.id') IS NOT NULL
    ON CONFLICT(project_id, id) DO UPDATE SET
      author_key = excluded.author_key,
      author_name = excluded.author_name,
      condition_data = excluded.condition_data,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).bind(projectId, authorKey, authorName, now, now, serialized);

  await env.DB.batch([markDeleted, upsertSnapshot]);
  return json(request, env, { ok: true, saved: conditions.length, updatedAt: now });
}

async function handleGetAuthors(request, env, projectId) {
  const result = await env.DB.prepare(`
    SELECT author_key, author_name, COUNT(*) AS condition_count,
           MAX(updated_at) AS updated_at
    FROM rw_conditions
    WHERE project_id = ? AND deleted_at IS NULL
    GROUP BY author_key, author_name
    ORDER BY author_name COLLATE NOCASE
  `).bind(projectId).all();
  const authors = (result.results || []).map(row => ({
    key: row.author_key,
    name: row.author_name,
    conditionCount: Number(row.condition_count || 0),
    updatedAt: row.updated_at,
  }));
  return json(request, env, { authors });
}

async function handlePutModel(request, env, projectId) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  if (!(await getProject(env, projectId))) throw new HttpError(404, 'Project not found');
  const contentType = request.headers.get('Content-Type') || 'model/gltf-binary';
  const body = await request.arrayBuffer();
  if (!body.byteLength) throw new HttpError(400, 'Model file is empty');
  const extension = contentType.includes('json') ? 'gltf' : 'glb';
  const modelKey = `projects/${projectId}/model/model.${extension}`;
  await env.FILES.put(modelKey, body, { httpMetadata: { contentType } });
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE rw_projects SET model_key = ?, updated_at = ? WHERE id = ?
  `).bind(modelKey, now, projectId).run();
  return json(request, env, { ok: true, modelKey });
}

async function handleGetModel(request, env, projectId) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  const project = await getProject(env, projectId);
  if (!project) throw new HttpError(404, 'Project not found');
  if (!project.model_key) throw new HttpError(404, 'Project has no uploaded model');
  const object = await env.FILES.get(project.model_key);
  if (!object) throw new HttpError(404, 'Model file not found');
  const headers = new Headers(corsHeaders(request, env) || {});
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=3600');
  return new Response(object.body, { headers });
}

function evidenceObjectKey(projectId, evidenceId) {
  return `projects/${projectId}/evidence/${evidenceId}`;
}

async function handlePutEvidence(request, env, projectId, evidenceId) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  if (!(await getProject(env, projectId))) throw new HttpError(404, 'Project not found');
  if (!isValidEvidenceId(evidenceId)) throw new HttpError(400, 'Invalid evidence id');
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_EVIDENCE_BYTES) throw new HttpError(413, 'Photo is too large');
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new HttpError(415, 'Evidence file must be an image');
  }
  const body = await request.arrayBuffer();
  if (!body.byteLength) throw new HttpError(400, 'Photo file is empty');
  if (body.byteLength > MAX_EVIDENCE_BYTES) throw new HttpError(413, 'Photo is too large');

  let fileName = evidenceId;
  let authorName = '';
  try { fileName = decodeURIComponent(request.headers.get('X-File-Name') || '') || evidenceId; } catch {}
  try { authorName = decodeURIComponent(request.headers.get('X-Author-Name') || ''); } catch {}
  await env.FILES.put(evidenceObjectKey(projectId, evidenceId), body, {
    httpMetadata: { contentType },
    customMetadata: {
      fileName: fileName.slice(0, 240),
      authorName: normalizeAuthorName(authorName),
    },
  });
  return json(request, env, { ok: true, evidenceId, byteSize: body.byteLength });
}

async function handleGetEvidence(request, env, projectId, evidenceId) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  if (!(await getProject(env, projectId))) throw new HttpError(404, 'Project not found');
  if (!isValidEvidenceId(evidenceId)) throw new HttpError(400, 'Invalid evidence id');
  const object = await env.FILES.get(evidenceObjectKey(projectId, evidenceId));
  if (!object) throw new HttpError(404, 'Photo not found');
  const headers = new Headers(corsHeaders(request, env) || {});
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('X-File-Name', encodeURIComponent(object.customMetadata?.fileName || evidenceId));
  headers.set('Access-Control-Expose-Headers', 'X-File-Name');
  return new Response(object.body, { headers });
}

async function route(request, env) {
  if (!env.DB) throw new HttpError(503, 'D1 binding DB is unavailable');
  const url = new URL(request.url);
  if (!url.pathname.startsWith(API_PREFIX)) throw new HttpError(404, 'Not found');

  const segments = url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length === 1 && segments[0] === 'health' && request.method === 'GET') {
    const db = await env.DB.prepare('SELECT 1 AS ok').first();
    return json(request, env, { ok: db?.ok === 1 });
  }
  if (segments[0] !== 'projects' || !segments[1]) throw new HttpError(404, 'Not found');

  const projectId = segments[1];
  if (!isValidProjectId(projectId)) throw new HttpError(400, 'Invalid project id');

  if (segments.length === 2) {
    if (request.method === 'GET') {
      const project = await getProject(env, projectId);
      if (!project) throw new HttpError(404, 'Project not found');
      return json(request, env, { project: serializeProject(project) });
    }
    if (request.method === 'PUT') return handlePutProject(request, env, projectId);
  }
  if (segments.length === 3 && segments[2] === 'conditions') {
    if (request.method === 'GET') return handleGetConditions(request, env, projectId, url);
    if (request.method === 'PUT') return handlePutConditions(request, env, projectId, url);
  }
  if (segments.length === 3 && segments[2] === 'authors' && request.method === 'GET') {
    return handleGetAuthors(request, env, projectId);
  }
  if (segments.length === 3 && segments[2] === 'model') {
    if (request.method === 'PUT') return handlePutModel(request, env, projectId);
    if (request.method === 'GET') return handleGetModel(request, env, projectId);
  }
  if (segments.length === 4 && segments[2] === 'evidence') {
    const evidenceId = segments[3];
    if (request.method === 'PUT') return handlePutEvidence(request, env, projectId, evidenceId);
    if (request.method === 'GET') return handleGetEvidence(request, env, projectId, evidenceId);
  }
  throw new HttpError(405, 'Method not allowed');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return json(request, { ...env, ALLOWED_ORIGINS: '*' }, { error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') {
      return empty(request, env, 204, {
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, X-Author-Name',
      });
    }
    try {
      return await route(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error('[collaboration]', error);
      return json(request, env, { error: error.message || 'Internal error' }, status);
    }
  },
};
