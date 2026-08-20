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

/**
 * Is this origin permitted?
 *
 * Exact matches, plus entries containing `*` as a single-label wildcard. The
 * wildcard exists for one specific problem: Vercel gives every preview
 * deployment a unique hostname, so a preview build can never be listed in
 * advance, and the failure is a CORS rejection that looks — from inside the
 * app — like the collaboration backend being down. Every participant silently
 * drops to offline mode.
 *
 * `*` expands to one hostname label and cannot cross a dot. That matters:
 * `https://*-tizian-reins-projects.vercel.app` then admits this team's preview
 * deployments and nothing else, where a `.*` would also admit
 * `https://anything.evil.com-tizian-reins-projects.vercel.app`.
 */
export function isOriginAllowed(origin, configured) {
  if (configured.includes('*')) return true;
  if (configured.includes(origin)) return true;
  return configured.some(entry => {
    if (!entry.includes('*')) return false;
    const pattern = entry
      .split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[A-Za-z0-9-]*');
    return new RegExp(`^${pattern}$`).test(origin);
  });
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
  if (isOriginAllowed(origin, configured)) {
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

  // CREATE-IF-NOT-EXISTS, not upsert.
  //
  // A workshop puts ~10 participants on one shared artefact, and every one of
  // them reaches this route on load — the client calls ensureProject() when
  // opening an example or a JSON file. As a blind upsert, the tenth arrival
  // overwrote the shared template with their own freshly-loaded copy, silently
  // discarding any artefact edits made since the project was created. Example
  // projects were worst hit: their ids are derivable ("example:<slug>"), so
  // every participant loading the same example clobbered the same row.
  //
  // The artefact is project-level state with many readers, so replacing it is
  // a deliberate act, not a side effect of opening the page. Callers that
  // really mean to replace it pass ?replace=true.
  const url = new URL(request.url);
  const replace = url.searchParams.get('replace') === 'true';
  const existing = await getProject(env, projectId);

  const now = new Date().toISOString();

  if (existing && !replace) {
    // Idempotent no-op: hand back what is already stored so concurrent
    // joiners all converge on the same artefact instead of racing to define
    // it. Only the mutable label is refreshed.
    if (title && title !== existing.title) {
      await env.DB.prepare(
        'UPDATE rw_projects SET title = ?, updated_at = ? WHERE id = ?',
      ).bind(title, now, projectId).run();
    }
    const project = await getProject(env, projectId);
    return json(request, env, { project: serializeProject(project), created: false }, 200);
  }

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
  return json(request, env, { project: serializeProject(project), created: !existing }, 200);
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
      condition_data = excluded.condition_data,
      updated_at = excluded.updated_at,
      deleted_at = NULL
    -- Ownership is NOT reassigned on conflict.
    --
    -- The primary key is (project_id, id) without author_key, so an id
    -- collision between two participants lands on one row. This clause used
    -- to copy excluded.author_key/author_name over, which meant the second
    -- saver silently took ownership of the first participant's condition and
    -- resurrected it out of soft-delete. With ~10 people surveying one
    -- artefact simultaneously that is a live hazard, not a theoretical one.
    --
    -- Randomised ids (src/core/schema.js uid()) make collisions vanishingly
    -- unlikely; this WHERE clause makes them harmless if one ever happens.
    -- Phase 1 replaces this table with rw_layers keyed by author.
    WHERE rw_conditions.author_key = excluded.author_key
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

// ============================================================================
// PARTICIPANT LAYERS
//
// A layer is one participant's whole workspace within a project: their parts
// model, conditions, strategies, evidence records, conversations and execution
// log. The body lives in R2 (D1 rows cap out around 1.8 MB, which a few chat
// threads exceed); D1 keeps the metadata needed to list participants and detect
// write conflicts without fetching anything.
// ============================================================================

const MAX_LAYER_BYTES = 24 * 1024 * 1024;

function layerKey(projectId, authorKey) {
  return `projects/${projectId}/layers/${authorKey}.json`;
}

function serializeLayerMeta(row) {
  if (!row) return null;
  return {
    authorKey: row.author_key,
    authorName: row.author_name,
    rev: Number(row.rev || 0),
    counts: {
      parts: Number(row.part_ct || 0),
      conditions: Number(row.condition_ct || 0),
      plans: Number(row.plan_ct || 0),
      renderings: Number(row.rendering_ct || 0),
    },
    byteSize: Number(row.byte_size || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Who is in this project, and how much have they done.
 *
 * This is what the name prompt shows before someone types. With ten people on
 * one artefact, two participants picking the same name silently share and
 * overwrite one layer; seeing "Anna M. — 12 conditions, 2 strategies" already
 * listed is what stops the second Anna from walking into it.
 */
async function handleGetLayerRoster(request, env, projectId) {
  const result = await env.DB.prepare(
    `SELECT author_key, author_name, rev, part_ct, condition_ct, plan_ct, rendering_ct,
            byte_size, created_at, updated_at
       FROM rw_layers WHERE project_id = ? ORDER BY updated_at DESC`,
  ).bind(projectId).all();

  const layers = (result.results || []).map(serializeLayerMeta);
  const known = new Set(layers.map(l => l.authorKey));

  // Participants who only ever wrote conditions under the old schema still
  // belong in the roster, or they would look like free names to claim.
  const legacy = await env.DB.prepare(
    `SELECT author_key, author_name, COUNT(*) AS n, MAX(updated_at) AS updated_at
       FROM rw_conditions
      WHERE project_id = ? AND deleted_at IS NULL
      GROUP BY author_key, author_name`,
  ).bind(projectId).all();

  for (const row of legacy.results || []) {
    if (known.has(row.author_key)) continue;
    layers.push({
      authorKey: row.author_key,
      authorName: row.author_name,
      rev: 0,
      counts: { parts: 0, conditions: Number(row.n || 0), plans: 0, renderings: 0 },
      byteSize: 0,
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
      legacy: true,
    });
  }

  return json(request, env, { layers });
}

async function handleGetLayer(request, env, projectId, authorKey) {
  const row = await env.DB.prepare(
    'SELECT * FROM rw_layers WHERE project_id = ? AND author_key = ?',
  ).bind(projectId, authorKey).first();

  if (row) {
    if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
    const object = await env.FILES.get(row.layer_key);
    if (!object) {
      // Metadata without a body: the row is real but the object is gone.
      // Report an empty layer at the recorded rev rather than a 404, so the
      // client rejoins cleanly instead of treating it as a new participant.
      return json(request, env, { layer: null, meta: serializeLayerMeta(row) });
    }
    const layer = JSON.parse(await object.text());
    return json(request, env, { layer, meta: serializeLayerMeta(row) });
  }

  // No layer yet. Fall back to this author's conditions under the old schema so
  // work recorded before layers existed is not stranded; their first save
  // writes a real layer and this path stops being taken.
  const legacy = await env.DB.prepare(
    `SELECT condition_data FROM rw_conditions
      WHERE project_id = ? AND author_key = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC`,
  ).bind(projectId, authorKey).all();

  const conditions = [];
  for (const r of legacy.results || []) {
    try { conditions.push(JSON.parse(r.condition_data)); } catch {}
  }
  if (!conditions.length) return json(request, env, { layer: null, meta: null });

  return json(request, env, {
    layer: { conditions, migratedFromConditions: true },
    meta: null,
  });
}

/**
 * Replace a participant's layer.
 *
 * Snapshot replacement, guarded by a revision. The client sends the rev it last
 * read; a mismatch means someone else (another tab, another device) wrote in
 * between, and we refuse with 409 rather than silently discarding their work —
 * the failure mode the old condition sync had.
 */
async function handlePutLayer(request, env, projectId, authorKey) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  const project = await getProject(env, projectId);
  if (!project) throw new HttpError(404, 'Project not found');

  const body = await readJson(request);
  const authorName = normalizeAuthorName(body.authorName);
  if (!authorName) throw new HttpError(400, 'authorName is required');
  if (normalizeAuthorKey(authorName) !== authorKey) {
    throw new HttpError(400, 'authorName does not match the author in the path');
  }
  const layer = body.layer;
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
    throw new HttpError(400, 'layer must be an object');
  }

  const serialized = JSON.stringify(layer);
  const byteSize = new TextEncoder().encode(serialized).byteLength;
  if (byteSize > MAX_LAYER_BYTES) throw new HttpError(413, 'Layer is too large');

  const existing = await env.DB.prepare(
    'SELECT rev FROM rw_layers WHERE project_id = ? AND author_key = ?',
  ).bind(projectId, authorKey).first();

  const currentRev = Number(existing?.rev || 0);
  const baseRev = Number.isFinite(Number(body.baseRev)) ? Number(body.baseRev) : null;
  // baseRev omitted means "I know I am overwriting" — used on first write and
  // when the client has deliberately resolved a conflict.
  if (baseRev !== null && currentRev !== baseRev) {
    throw new HttpError(409, `Layer changed elsewhere (server rev ${currentRev}, you have ${baseRev})`);
  }

  const nextRev = currentRev + 1;
  const key = layerKey(projectId, authorKey);
  const now = new Date().toISOString();

  await env.FILES.put(key, serialized, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { authorName, rev: String(nextRev) },
  });

  const counts = {
    parts: Array.isArray(layer.instance?.parts) ? layer.instance.parts.length : 0,
    conditions: Array.isArray(layer.conditions) ? layer.conditions.length : 0,
    plans: Array.isArray(layer.plans) ? layer.plans.length : 0,
    renderings: Array.isArray(layer.evidence)
      ? layer.evidence.filter(e => e?.kind === 'rendering').length : 0,
  };

  await env.DB.prepare(
    `INSERT INTO rw_layers (
       project_id, author_key, author_name, layer_key, rev,
       part_ct, condition_ct, plan_ct, rendering_ct, byte_size, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, author_key) DO UPDATE SET
       author_name = excluded.author_name,
       layer_key = excluded.layer_key,
       rev = excluded.rev,
       part_ct = excluded.part_ct,
       condition_ct = excluded.condition_ct,
       plan_ct = excluded.plan_ct,
       rendering_ct = excluded.rendering_ct,
       byte_size = excluded.byte_size,
       updated_at = excluded.updated_at`,
  ).bind(
    projectId, authorKey, authorName, key, nextRev,
    counts.parts, counts.conditions, counts.plans, counts.renderings, byteSize, now, now,
  ).run();

  return json(request, env, { ok: true, rev: nextRev, counts, updatedAt: now });
}

// ============================================================================
// CORPUS
//
// Source material the AI reads. Two scopes: 'project' documents are shared by
// everyone (so divergence comes from what people do with the material, not
// from having different material), and 'strategy' documents belong to one plan
// and are visible only to it (so strategies genuinely diverge rather than
// converging on a common evidence base).
// ============================================================================

const MAX_CORPUS_BYTES = 25_000_000;
const MAX_CORPUS_TEXT_BYTES = 4_000_000;
const DOC_KINDS = ['structure', 'goal', 'technique', 'reference'];

function corpusKey(projectId, docId) { return `projects/${projectId}/corpus/${docId}`; }
function corpusTextKey(projectId, docId) { return `projects/${projectId}/corpus/${docId}.txt`; }

function serializeCorpusDoc(row) {
  if (!row) return null;
  // key_facts holds either a bare array (the original shape) or
  // { facts, figures } once figure descriptions were added. Both shapes are
  // read, so documents ingested before figures existed keep working and no
  // migration is needed.
  let keyFacts = null;
  let figures = null;
  let indications = null;
  try {
    const parsed = row.key_facts ? JSON.parse(row.key_facts) : null;
    if (Array.isArray(parsed)) {
      keyFacts = parsed;
    } else if (parsed && typeof parsed === 'object') {
      keyFacts = Array.isArray(parsed.facts) ? parsed.facts : null;
      figures = Array.isArray(parsed.figures) ? parsed.figures : null;
      indications = Array.isArray(parsed.indications) ? parsed.indications : null;
    }
  } catch {}
  return {
    id: row.id,
    scope: row.scope,
    planId: row.plan_id || null,
    authorKey: row.author_key || null,
    authorName: row.author_name || null,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size || 0),
    docKind: row.doc_kind,
    summary: row.summary || null,
    keyFacts,
    figures,
    indications,
    status: row.status,
    error: row.error || null,
    hasText: !!row.text_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List what is readable from one vantage point.
 *
 * With ?planId= (and ?author=) this returns project documents PLUS that plan's
 * own — which is exactly the set a chat in that strategy may see. Without them
 * it returns project documents only. There is deliberately no way to ask for
 * another strategy's documents.
 */
async function handleListCorpus(request, env, projectId, url) {
  const planId = url.searchParams.get('planId');
  const authorKey = normalizeAuthorKey(url.searchParams.get('author'));

  let result;
  if (planId && authorKey) {
    result = await env.DB.prepare(
      `SELECT * FROM rw_corpus_docs
        WHERE project_id = ?
          AND (scope = 'project' OR (scope = 'strategy' AND author_key = ? AND plan_id = ?))
        ORDER BY scope DESC, created_at DESC`,
    ).bind(projectId, authorKey, planId).all();
  } else {
    result = await env.DB.prepare(
      `SELECT * FROM rw_corpus_docs
        WHERE project_id = ? AND scope = 'project'
        ORDER BY created_at DESC`,
    ).bind(projectId).all();
  }
  return json(request, env, { documents: (result.results || []).map(serializeCorpusDoc) });
}

/**
 * Upload a document. Raw body; metadata rides in the query string and headers
 * so the blob does not have to be base64-wrapped in JSON.
 */
async function handlePutCorpusDoc(request, env, projectId, docId, url) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  const project = await getProject(env, projectId);
  if (!project) throw new HttpError(404, 'Project not found');

  const scope = url.searchParams.get('scope') === 'strategy' ? 'strategy' : 'project';
  const planId = url.searchParams.get('planId') || null;
  const authorKey = normalizeAuthorKey(url.searchParams.get('author')) || null;
  const authorName = normalizeAuthorName(decodeURIComponent(request.headers.get('X-Author-Name') || '')) || null;
  const filename = decodeURIComponent(request.headers.get('X-File-Name') || docId).slice(0, 200);
  const rawKind = url.searchParams.get('kind') || 'reference';
  const docKind = DOC_KINDS.includes(rawKind) ? rawKind : 'reference';
  const mimeType = request.headers.get('Content-Type') || 'application/octet-stream';

  // A strategy document without a plan would be invisible to every scope,
  // including its own — refuse rather than silently orphan it.
  if (scope === 'strategy' && (!planId || !authorKey)) {
    throw new HttpError(400, 'A strategy document requires planId and author');
  }

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_CORPUS_BYTES) throw new HttpError(413, 'Document is too large');
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CORPUS_BYTES) throw new HttpError(413, 'Document is too large');
  if (!body.byteLength) throw new HttpError(400, 'Document is empty');

  const key = corpusKey(projectId, docId);
  await env.FILES.put(key, body, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { filename, authorName: authorName || '', scope },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO rw_corpus_docs (
       project_id, id, scope, author_key, author_name, plan_id,
       filename, mime_type, byte_size, doc_kind, r2_key, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)
     ON CONFLICT(project_id, id) DO UPDATE SET
       scope = excluded.scope,
       author_key = excluded.author_key,
       author_name = excluded.author_name,
       plan_id = excluded.plan_id,
       filename = excluded.filename,
       mime_type = excluded.mime_type,
       byte_size = excluded.byte_size,
       doc_kind = excluded.doc_kind,
       r2_key = excluded.r2_key,
       status = 'uploaded',
       error = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    projectId, docId, scope, authorKey, authorName, planId,
    filename, mimeType, body.byteLength, docKind, key, now, now,
  ).run();

  const row = await env.DB.prepare(
    'SELECT * FROM rw_corpus_docs WHERE project_id = ? AND id = ?',
  ).bind(projectId, docId).first();
  return json(request, env, { document: serializeCorpusDoc(row) });
}

async function handleGetCorpusDoc(request, env, projectId, docId) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  const row = await env.DB.prepare(
    'SELECT * FROM rw_corpus_docs WHERE project_id = ? AND id = ?',
  ).bind(projectId, docId).first();
  if (!row) throw new HttpError(404, 'Document not found');
  const object = await env.FILES.get(row.r2_key);
  if (!object) throw new HttpError(404, 'Document body not found');
  return new Response(object.body, {
    status: 200,
    headers: {
      ...(corsHeaders(request, env) || {}),
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
      'X-File-Name': encodeURIComponent(row.filename || docId),
    },
  });
}

/** Extracted plaintext plus the ingest summary — what the model actually reads. */
async function handleGetCorpusText(request, env, projectId, docId) {
  const row = await env.DB.prepare(
    'SELECT * FROM rw_corpus_docs WHERE project_id = ? AND id = ?',
  ).bind(projectId, docId).first();
  if (!row) throw new HttpError(404, 'Document not found');
  let text = null;
  if (row.text_key && env.FILES) {
    const object = await env.FILES.get(row.text_key);
    if (object) text = await object.text();
  }
  return json(request, env, { document: serializeCorpusDoc(row), text });
}

/** Store the ingest result: extracted text, summary and key facts. */
async function handlePutCorpusText(request, env, projectId, docId) {
  if (!env.FILES) throw new HttpError(503, 'R2 binding FILES is unavailable');
  const row = await env.DB.prepare(
    'SELECT * FROM rw_corpus_docs WHERE project_id = ? AND id = ?',
  ).bind(projectId, docId).first();
  if (!row) throw new HttpError(404, 'Document not found');

  const body = await readJson(request);
  const status = String(body.status || 'ready');
  const now = new Date().toISOString();

  if (status === 'failed') {
    await env.DB.prepare(
      'UPDATE rw_corpus_docs SET status = ?, error = ?, updated_at = ? WHERE project_id = ? AND id = ?',
    ).bind('failed', String(body.error || 'Ingest failed').slice(0, 500), now, projectId, docId).run();
  } else {
    const text = String(body.text || '');
    if (new TextEncoder().encode(text).byteLength > MAX_CORPUS_TEXT_BYTES) {
      throw new HttpError(413, 'Extracted text is too large');
    }
    const textKey = corpusTextKey(projectId, docId);
    await env.FILES.put(textKey, text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });

    // Replace this document's chunks wholesale. Re-ingesting must not leave
    // vectors from the previous pass behind — stale chunks would keep matching
    // and quietly return text the document no longer contains.
    //
    // Failures here are swallowed deliberately. The chunks are an INDEX; the
    // document, its extracted text and its summary are already stored above.
    // If the table is missing because a migration has not been applied, or a
    // batch fails for any other reason, losing semantic search on one document
    // is a far better outcome than failing the whole request and leaving the
    // upload marked unreadable. Keyword search still works from the client's
    // index either way.
    try {
    if (Array.isArray(body.chunks) && body.chunks.length) {
      await env.DB.prepare(
        'DELETE FROM rw_corpus_chunks WHERE project_id = ? AND doc_id = ?',
      ).bind(projectId, docId).run();

      const statements = body.chunks.slice(0, 400).map((c, ix) =>
        env.DB.prepare(
          `INSERT INTO rw_corpus_chunks (
             project_id, doc_id, chunk_ix, scope, author_key, plan_id,
             kind, label, content, vector, dims, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          projectId, docId, ix, row.scope, row.author_key, row.plan_id,
          String(c.kind || 'text'),
          c.label ? String(c.label).slice(0, 200) : null,
          String(c.content || '').slice(0, 4000),
          String(c.vector || ''),
          Number(c.dims || 0),
          now,
        ));
      // D1 batches cap out; 50 at a time keeps well inside the statement limit.
      for (let i = 0; i < statements.length; i += 50) {
        await env.DB.batch(statements.slice(i, i + 50));
      }
    }
    } catch (err) {
      console.warn('[corpus] chunk indexing failed, document stored without vectors:', err.message);
    }
    await env.DB.prepare(
      `UPDATE rw_corpus_docs
          SET text_key = ?, summary = ?, key_facts = ?, status = 'ready', error = NULL, updated_at = ?
        WHERE project_id = ? AND id = ?`,
    ).bind(
      textKey,
      String(body.summary || '').slice(0, 2000),
      (body.keyFacts || body.figures || body.indications)
        ? JSON.stringify({
            facts: body.keyFacts || [],
            figures: body.figures || [],
            indications: body.indications || [],
          }).slice(0, 20000)
        : null,
      now, projectId, docId,
    ).run();
  }

  const updated = await env.DB.prepare(
    'SELECT * FROM rw_corpus_docs WHERE project_id = ? AND id = ?',
  ).bind(projectId, docId).first();
  return json(request, env, { document: serializeCorpusDoc(updated) });
}

// ---------------------------------------------------------------------------
// Semantic search
//
// The caller embeds the query (the Gemini key lives on the API side, not here)
// and posts the vector. We load the candidate chunks for this scope and rank by
// cosine similarity.
//
// No ANN index: scope already narrows things hard — a strategy sees project
// documents plus its own, which at workshop scale is a few hundred chunks. A
// brute-force pass over that is sub-millisecond, and needs no extra service to
// operate, back up or keep in sync. Vectorize slots in behind this same route
// if a corpus ever reaches tens of thousands of chunks.
// ---------------------------------------------------------------------------

export function decodeVector(b64) {
  const binary = atob(b64);
  const out = new Int8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    out[i] = byte > 127 ? byte - 256 : byte;
  }
  return out;
}

/**
 * Bring an incoming query vector into the same units as the stored ones.
 *
 * The API side quantises before posting. This does not trust that. `Int8Array
 * .from()` on a raw float vector truncates every component to zero, which does
 * not throw, does not warn, and produces a uniform score of zero for every
 * chunk — so the ranking sort does nothing and search returns rows in whatever
 * order D1 supplied. Silent, plausible-looking nonsense.
 *
 * The Worker and the Vercel functions deploy independently, so one can be a
 * version behind the other at any time. Detecting the float form here and
 * normalising it costs one pass over 768 numbers and makes that skew harmless
 * in both directions.
 */
export function toQueryVector(query) {
  let maxAbs = 0;
  let fractional = false;
  for (const x of query) {
    const a = Math.abs(x);
    if (a > maxAbs) maxAbs = a;
    if (!Number.isInteger(x)) fractional = true;
  }
  // Already int8-shaped: integers spanning more than the unit interval.
  if (!fractional && maxAbs > 1) return Int8Array.from(query);

  let norm = 0;
  for (const x of query) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const out = new Int8Array(query.length);
  for (let i = 0; i < query.length; i++) {
    out[i] = Math.max(-127, Math.min(127, Math.round((query[i] / norm) * 127)));
  }
  return out;
}

/**
 * Both vectors are stored normalised, so cosine similarity is a plain dot
 * product — no square roots in the inner loop.
 */
export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

async function handleSearchCorpus(request, env, projectId) {
  const body = await readJson(request);
  const query = Array.isArray(body.vector) ? body.vector : null;
  if (!query || !query.length) throw new HttpError(400, 'vector is required');

  const planId = body.planId || null;
  const authorKey = normalizeAuthorKey(body.authorKey) || null;
  const topK = Math.min(Math.max(Number(body.topK) || 8, 1), 25);

  // Same scoping rule as every other corpus read: project documents plus this
  // one strategy's. There is no parameter that widens it.
  // An unavailable index is not an error worth surfacing to the participant:
  // the caller falls back to keyword search, which still works. Returning an
  // empty result keeps the chat usable when the migration has not been applied.
  let rows;
  try {
  if (planId && authorKey) {
    rows = await env.DB.prepare(
      `SELECT c.doc_id, c.chunk_ix, c.kind, c.label, c.content, c.vector,
              d.filename, d.doc_kind, d.scope
         FROM rw_corpus_chunks c
         JOIN rw_corpus_docs d ON d.project_id = c.project_id AND d.id = c.doc_id
        WHERE c.project_id = ?
          AND (c.scope = 'project' OR (c.scope = 'strategy' AND c.author_key = ? AND c.plan_id = ?))`,
    ).bind(projectId, authorKey, planId).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT c.doc_id, c.chunk_ix, c.kind, c.label, c.content, c.vector,
              d.filename, d.doc_kind, d.scope
         FROM rw_corpus_chunks c
         JOIN rw_corpus_docs d ON d.project_id = c.project_id AND d.id = c.doc_id
        WHERE c.project_id = ? AND c.scope = 'project'`,
    ).bind(projectId).all();
  }
  } catch (err) {
    console.warn('[corpus] semantic search unavailable:', err.message);
    return json(request, env, { chunks: [], searched: 0, unavailable: true });
  }

  const q = toQueryVector(query);
  const scored = [];
  for (const row of (rows.results || [])) {
    let vector;
    try { vector = decodeVector(row.vector); } catch { continue; }
    let score = dot(q, vector) / (127 * 127);
    // A figure caption or an indication is a curated, deliberately short
    // signal. Without a nudge, long prose chunks with diffuse similarity
    // outrank them — which is backwards, since those two are exactly the
    // handles someone reaches for.
    if (row.kind === 'figure') score *= 1.15;
    if (row.kind === 'indication') score *= 1.2;
    scored.push({
      docId: row.doc_id,
      filename: row.filename,
      docKind: row.doc_kind,
      scope: row.scope,
      chunkKind: row.kind,
      label: row.label,
      content: row.content,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return json(request, env, {
    chunks: scored.slice(0, topK),
    searched: scored.length,
  });
}

// ---------------------------------------------------------------------------
// Spend limiting
//
// The AI endpoints on Vercel call this before doing anything expensive. It is
// not authentication — it establishes nothing about who is calling — it just
// bounds what an anonymous caller can cost on a pay-as-you-go key.
//
// Two buckets are checked per request: one for the caller, and one global
// ceiling across all callers. The per-caller limit stops one script; the
// global limit is what actually bounds the bill, because a leaked URL does not
// arrive from a single address.
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX_WINDOW = 86_400;   // a day, the longest window accepted
const RATE_LIMIT_MAX_COST = 100;

async function bumpBucket(env, bucket, windowSeconds, limit, cost, nowSec) {
  const windowStart = Math.floor(nowSec / windowSeconds) * windowSeconds;
  const now = new Date(nowSec * 1000).toISOString();

  // One statement: insert the window or add to it, and return what the count
  // became. Two clients arriving together therefore serialise on the row
  // rather than both reading the same stale value.
  const row = await env.DB.prepare(
    `INSERT INTO rw_rate_limits (bucket, window_start, count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(bucket, window_start) DO UPDATE SET
       count = count + excluded.count,
       updated_at = excluded.updated_at
     RETURNING count`,
  ).bind(bucket, windowStart, cost, now).first();

  const count = Number(row?.count || 0);
  return {
    ok: count <= limit,
    count,
    limit,
    // When the window rolls over and it is worth trying again.
    retryAfter: Math.max(1, windowStart + windowSeconds - Math.floor(nowSec)),
  };
}

async function handleRateLimit(request, env) {
  const body = await readJson(request);

  const name = String(body.name || '').slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) throw new HttpError(400, 'name is required');

  const caller = String(body.caller || 'unknown').slice(0, 100);
  const limit = Math.max(1, Math.min(Number(body.limit) || 60, 100_000));
  // Bounded on its own terms, NOT floored at `limit`. A global ceiling tighter
  // than the per-caller one is a legitimate way to say "whatever any one caller
  // may do, the deployment as a whole stops here", and quietly raising it to
  // meet `limit` would disable exactly the limit that bounds the bill.
  const globalLimit = Math.max(1, Math.min(Number(body.globalLimit) || limit * 20, 1_000_000));
  const windowSeconds = Math.max(1, Math.min(Number(body.windowSeconds) || 300, RATE_LIMIT_MAX_WINDOW));
  const cost = Math.max(1, Math.min(Number(body.cost) || 1, RATE_LIMIT_MAX_COST));
  const nowSec = Math.floor(Date.now() / 1000);

  // The global ceiling is checked first: if the whole deployment is over
  // budget, whose request it is does not matter.
  const global = await bumpBucket(env, `${name}:@global`, windowSeconds, globalLimit, cost, nowSec);
  if (!global.ok) {
    return json(request, env, {
      ok: false, scope: 'global', count: global.count, limit: global.limit, retryAfter: global.retryAfter,
    }, 200);
  }

  const per = await bumpBucket(env, `${name}:${caller}`, windowSeconds, limit, cost, nowSec);

  // Opportunistic sweep of windows nobody can read any more. Cheap, and it
  // keeps the table from growing without bound over a term of workshops.
  if (Math.floor(nowSec / 60) % 30 === 0) {
    try {
      await env.DB.prepare('DELETE FROM rw_rate_limits WHERE window_start < ?')
        .bind(nowSec - RATE_LIMIT_MAX_WINDOW * 2).run();
    } catch {}
  }

  return json(request, env, {
    ok: per.ok, scope: per.ok ? null : 'caller',
    count: per.count, limit: per.limit, retryAfter: per.retryAfter,
  }, 200);
}

async function handleDeleteCorpusDoc(request, env, projectId, docId) {
  const row = await env.DB.prepare(
    'SELECT * FROM rw_corpus_docs WHERE project_id = ? AND id = ?',
  ).bind(projectId, docId).first();
  if (!row) throw new HttpError(404, 'Document not found');
  if (env.FILES) {
    try { await env.FILES.delete(row.r2_key); } catch {}
    if (row.text_key) { try { await env.FILES.delete(row.text_key); } catch {} }
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rw_corpus_chunks WHERE project_id = ? AND doc_id = ?').bind(projectId, docId),
    env.DB.prepare('DELETE FROM rw_corpus_docs WHERE project_id = ? AND id = ?').bind(projectId, docId),
  ]);
  return json(request, env, { ok: true, deleted: docId });
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
  // Not under /projects: the spend limit is a property of the deployment, not
  // of any one project.
  if (segments.length === 1 && segments[0] === 'limit' && request.method === 'POST') {
    return handleRateLimit(request, env);
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
  if (segments.length === 3 && segments[2] === 'layers' && request.method === 'GET') {
    return handleGetLayerRoster(request, env, projectId);
  }
  if (segments.length === 3 && segments[2] === 'corpus') {
    if (request.method === 'GET') return handleListCorpus(request, env, projectId, url);
  }
  if (segments.length === 4 && segments[2] === 'corpus' && segments[3] === 'search') {
    if (request.method === 'POST') return handleSearchCorpus(request, env, projectId);
  }
  if (segments.length === 4 && segments[2] === 'corpus') {
    const docId = segments[3];
    if (!isValidEvidenceId(docId)) throw new HttpError(400, 'Invalid document id');
    if (request.method === 'PUT') return handlePutCorpusDoc(request, env, projectId, docId, url);
    if (request.method === 'GET') return handleGetCorpusDoc(request, env, projectId, docId);
    if (request.method === 'DELETE') return handleDeleteCorpusDoc(request, env, projectId, docId);
  }
  if (segments.length === 5 && segments[2] === 'corpus' && segments[4] === 'text') {
    const docId = segments[3];
    if (!isValidEvidenceId(docId)) throw new HttpError(400, 'Invalid document id');
    if (request.method === 'GET') return handleGetCorpusText(request, env, projectId, docId);
    if (request.method === 'PUT') return handlePutCorpusText(request, env, projectId, docId);
  }
  if (segments.length === 4 && segments[2] === 'layers') {
    const authorKey = normalizeAuthorKey(segments[3]);
    if (!authorKey) throw new HttpError(400, 'Invalid author');
    if (request.method === 'GET') return handleGetLayer(request, env, projectId, authorKey);
    if (request.method === 'PUT') return handlePutLayer(request, env, projectId, authorKey);
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
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
