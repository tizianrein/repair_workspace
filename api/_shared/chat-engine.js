/**
 * Chat engine — the meat of the conversational endpoint.
 *
 * Both the synchronous chat endpoint (/api/chat) and a future streaming
 * variant share this logic. Pulled out so we don't duplicate the tool
 * dispatcher and workspace-lean logic when we add streaming later.
 *
 * The engine:
 *   1. Loads the system prompt
 *   2. Converts client thread history to Gemini's format
 *   3. Runs the multi-turn tool-calling loop via callGeminiWithTools
 *   4. Returns { reply, commands, toolCalls, plannedSummary }
 *
 * The `mapToolToCommand` function translates the AI's tool vocabulary
 * (add_condition, create_plan, etc) into the workspace's command
 * vocabulary (add-condition, add-plan, etc). Server is stateless:
 * commands are collected and returned to the client which owns the
 * workspace state.
 */

import { callGeminiWithTools } from './gemini.js';
import { loadPrompt } from './prompts.js';
import { CHAT_TOOLS } from './chat-tools.js';

let serverCounter = 0;
function newId(prefix) {
  serverCounter++;
  return `${prefix}_${Date.now().toString(36)}${serverCounter.toString(36).padStart(3, '0')}`;
}

// ----------------------------------------------------------------------------
// Step-reference resolution
//
// Workshop bug: Gemini frequently calls add_edge with step "ids" that don't
// match the real ids in the plan — typically because (a) it invents a
// snake_case slug like "repair_feet_ends" from a step it created in the
// same turn (and where the server assigned an ephemeral id like step_mp9...),
// or (b) it passes the step's display title ("Grundierung auftragen") instead
// of an id. The batch then fails at apply-time on the client, the user sees
// the step never showed up, and there's no way for the model to recover.
//
// Fix: track every step the model creates within this chat turn, keyed by
// every alias the model might plausibly reference it by (server id, original
// requested slug if any, title, normalized title). When we see an add_edge,
// resolve source/target against the live workspace AND this pending-steps
// registry. If neither matches, return an error to the model — Gemini will
// see it in the functionResponse and gets a chance to fix itself.
// ----------------------------------------------------------------------------

function normalizeSlug(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    // Pre-expand German digraphs that NFKD does NOT decompose (ä/ö/ü do
    // decompose, but ß stays as ß and would otherwise be stripped). Doing
    // this before NFKD covers the common workshop case where a step title
    // is "Reparatur der Fußenden" and the model references it by
    // "reparatur_der_fussenden".
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildStepAliasMap(currentPlan, pendingSteps) {
  const aliases = new Map();
  const add = (alias, realId) => {
    if (!alias || !realId) return;
    const a = String(alias).trim();
    if (!a) return;
    if (!aliases.has(a)) aliases.set(a, realId);
    const slug = normalizeSlug(a);
    if (slug && !aliases.has(slug)) aliases.set(slug, realId);
  };
  for (const s of (currentPlan?.steps || [])) {
    add(s.id, s.id);
    add(s.title, s.id);
  }
  for (const p of pendingSteps) {
    add(p.realId, p.realId);
    if (p.requestedSlug) add(p.requestedSlug, p.realId);
    if (p.title) add(p.title, p.realId);
  }
  return aliases;
}

function resolveStepRef(ref, aliases) {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (aliases.has(raw)) return aliases.get(raw);
  const slug = normalizeSlug(raw);
  if (slug && aliases.has(slug)) return aliases.get(slug);
  return null;
}

// ----------------------------------------------------------------------------
// Chat post-processing — leak defense and markdown cleanup
//
// Two filters run on every model reply before we ship it to the client:
//
//   1. stripToolCodeLeak — kills Gemini's textual tool-call leak. Gemini
//      sometimes emits its function calls as a *text* part instead of as
//      a proper `functionCall` part — "tool_code\nprint(default_api.add_
//      condition(...))" — and the user sees pseudo-Python claiming things
//      were done that weren't. The detector fires on the literal token
//      `tool_code` OR on chains of `default_api.xxx(...)` calls. When it
//      fires, runChat retries the turn with a correction (see runChat
//      below). If even the retry leaks, we replace the visible reply with
//      a short honest "something went wrong" line.
//
//   2. stripChatMarkdown — strips the markdown the client *doesn't*
//      render (headers, fenced code blocks). The client renderer in
//      chat-sheet.js handles **bold**, *italic*, `inline code`, lists,
//      and paragraph breaks, so we leave those alone.
// ----------------------------------------------------------------------------

// Detect Gemini's textual tool-call leak. Triggers on either the explicit
// "tool_code" marker or on chains of `print(default_api.xxx(` which is the
// fingerprint of the leak format regardless of marker.
function looksLikeToolCodeLeak(text) {
  if (!text) return false;
  if (/\btool_code\b/.test(text)) return true;
  // Two or more print(default_api.xxx( calls in a row is the leak signature.
  const matches = text.match(/\bdefault_api\.[a-z_]+\s*\(/gi);
  return !!matches && matches.length >= 2;
}

// Remove the leaked tool-code blob. If the leak is most of the message,
// replace the whole thing with a short honest line so the user isn't
// reading pseudo-code. If it's only part of the message (rare), excise
// just the leak region.
function stripToolCodeLeak(text) {
  if (!looksLikeToolCodeLeak(text)) return text;
  // Strip the obvious tool_code / print(default_api...) chains.
  let cleaned = text
    .replace(/```tool_code[\s\S]*?```/g, '')
    .replace(/\btool_code\b[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\bprint\s*\(\s*default_api\.[\s\S]*?\)\s*\)/g, '')
    .replace(/\bdefault_api\.[a-z_]+\([\s\S]*?\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // If almost nothing meaningful is left (under ~40 chars of prose),
  // replace with a stand-in. The tools that should have run didn't, so
  // tell the user honestly rather than pretending success.
  if (cleaned.length < 40) {
    return 'Something went wrong on my side — the changes I meant to make didn\'t register. Could you ask again?';
  }
  return cleaned;
}

// ----------------------------------------------------------------------------
// Chat-markdown stripping
//
// The chat UI renders a small subset of markdown in assistant bubbles:
// **bold**, *italic*, `inline code`, paragraph breaks, ordered/unordered
// lists. Those we LET THROUGH untouched. We only strip the things the
// client doesn't render — headers and fenced code blocks — so the user
// doesn't see stray `#` or backtick fences in the bubble.
// ----------------------------------------------------------------------------

function stripChatMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // Headers: strip the leading `# ` markers, leave the heading text as a
    // normal line. Multiple hashes (`##`, `###`) all collapse to nothing.
    .replace(/^#{1,6}[ \t]+/gm, '')
    // Fenced code blocks: extract content, drop the fences.
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
    // Trailing whitespace on lines.
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Rank corpus documents against a query.
 *
 * Deliberately a keyword scorer rather than embeddings. At workshop scale — a
 * few dozen documents per project — term overlap across filenames, summaries
 * and extracted facts finds the right document, costs nothing per query, and
 * adds no infrastructure. If a corpus ever grows past a few hundred documents
 * this is the seam to swap for vector search, behind the same tool signature.
 */
function searchCorpus(docs, query, docKinds) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 2);
  const kinds = Array.isArray(docKinds) && docKinds.length ? new Set(docKinds) : null;

  return docs
    .filter(d => !kinds || kinds.has(d.kind))
    .map(d => {
      const facts = d.keyFacts || [];
      const figures = d.figures || [];
      const indications = d.indications || [];
      const figureText = figures.map(f => `${f.label || ''} ${f.description || ''}`);
      const haystack = [d.filename, d.summary, ...facts, ...figureText, ...indications]
        .filter(Boolean).join(' \n ').toLowerCase();
      let score = 0;
      const matched = [];
      const matchedFigures = [];
      for (const t of terms) {
        if (!haystack.includes(t)) continue;
        score += 1;
        // A hit in the filename, an extracted fact or a figure caption
        // outweighs one buried in prose — those are the curated signals,
        // written at ingest.
        if (String(d.filename || '').toLowerCase().includes(t)) score += 1;
        if (facts.some(f => f.toLowerCase().includes(t))) score += 1;
        // Indications score highest of the text signals. They are written in
        // the problem's vocabulary, so a hit there means the document speaks to
        // the situation being described — which is a stronger signal than a
        // word happening to appear in its prose.
        if (indications.some(i => i.toLowerCase().includes(t))) score += 3;
        // Figures score highest. In technical literature the drawings usually
        // carry the answer, and a query like "scarf joint" is far more likely
        // to be satisfied by a diagram than by the prose around it.
        const figHits = figures.filter(f =>
          `${f.label || ''} ${f.description || ''}`.toLowerCase().includes(t));
        if (figHits.length) {
          score += 2;
          for (const f of figHits) if (!matchedFigures.includes(f)) matchedFigures.push(f);
        }
        matched.push(t);
      }
      return { doc: d, score, matched, matchedFigures };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ doc, matched, matchedFigures }) => ({
      id: doc.id,
      filename: doc.filename,
      kind: doc.kind,
      scope: doc.scope,
      summary: doc.summary,
      keyFacts: (doc.keyFacts || [])
        .filter(f => matched.some(t => f.toLowerCase().includes(t)))
        .slice(0, 5),
      useWhen: (doc.indications || [])
        .filter(i => matched.some(t => i.toLowerCase().includes(t)))
        .slice(0, 4),
      // Which drawings matched, and an explicit nudge to go and look at them.
      // A description of a scarf joint is not a scarf joint; when the geometry
      // is the answer, the model needs the page, not a paraphrase of it.
      matchedFigures: matchedFigures.slice(0, 6),
      viewHint: matchedFigures.length
        ? `This match is in figures. Call read_corpus_document({docId: "${doc.id}", view: true}) to examine the actual drawings.`
        : undefined,
      matchedTerms: matched,
    }));
}

/**
 * Merge the two retrieval routes into one document list.
 *
 * Reciprocal rank fusion: a document's score is the sum of 1/(k + rank) across
 * the rankings it appears in. It needs no score calibration between the two
 * methods — cosine similarity and keyword counts are not on comparable scales,
 * and any attempt to normalise them into one number is guesswork. Rank position
 * is comparable, which is the whole appeal. A document found by BOTH routes
 * rises above one found by either, which is the behaviour we want: agreement
 * between an exact-term match and a semantic match is a strong signal.
 */
function dedupeByDoc(lexical, semantic) {
  const K = 60;   // the standard RRF constant; damps the top-rank advantage
  const scores = new Map();
  const meta = new Map();

  lexical.forEach((hit, i) => {
    scores.set(hit.id, (scores.get(hit.id) || 0) + 1 / (K + i + 1));
    meta.set(hit.id, hit);
  });

  semantic.forEach((chunk, i) => {
    const id = chunk.docId;
    scores.set(id, (scores.get(id) || 0) + 1 / (K + i + 1));
    if (!meta.has(id)) {
      meta.set(id, {
        id,
        filename: chunk.filename,
        kind: chunk.docKind,
        scope: chunk.scope,
        summary: null,
        keyFacts: [],
        useWhen: [],
        matchedFigures: [],
        foundBy: 'meaning',
      });
    }
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id]) => meta.get(id))
    .filter(Boolean);
}

/**
 * The always-on corpus index: what the model sees in every turn.
 *
 * The trade-off is awareness against tokens. Carrying full summaries and figure
 * descriptions for fifty documents would be thousands of tokens per turn;
 * carrying nothing means the model cannot know a joinery manual exists and so
 * never thinks to look for one. This is the middle: enough to recognise that a
 * document is worth opening, and nothing more.
 *
 * `indications` is the part that does the real work. A practitioner asks "the
 * sill end is rotten over 400mm, what do I do?" — which shares not one word
 * with "stop-splayed scarf joint". Ingest therefore records what problems each
 * document SOLVES, in the vocabulary of the problem rather than the solution,
 * and that is what closes the gap.
 */
function corpusDocsForSnapshot(corpus) {
  const docs = Array.isArray(corpus?.documents) ? corpus.documents : [];
  return docs.slice(0, 60).map(d => ({
    id: d.id,
    file: d.filename,
    kind: d.kind,
    scope: d.scope,
    about: String(d.summary || '').slice(0, 180),
    useWhen: (d.indications || []).slice(0, 3),
    // Labels only. The descriptions are what search_corpus returns.
    figures: (d.figures || []).map(f => f.label).filter(Boolean).slice(0, 8),
  }));
}

export async function runChat({ thread, userMessage, workspace, files, corpus }) {
  const systemPrompt = loadPrompt('chat');

  // Convert prior chat history into Gemini's role/parts format
  const history = [];
  for (const m of (thread?.messages || [])) {
    if (!m.content) continue;
    if (m.role === 'user') {
      history.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      history.push({ role: 'model', parts: [{ text: m.content }] });
    }
  }

  const snapshot = leanWorkspace(workspace, thread);

  // The corpus index goes INTO the snapshot, not just behind a tool.
  //
  // Without this the model has no way to know any documents exist: it only
  // finds them by calling search_corpus, and it has no reason to call
  // search_corpus for something it has never heard of. The whole point of
  // paying for a summary at ingest is that awareness is cheap — so put the
  // awareness where the model actually looks.
  //
  // Kept deliberately thin: one line of summary, the problems each document
  // speaks to, and figure LABELS without their descriptions. Roughly 50-70
  // tokens per document. The full summaries, figure descriptions and text stay
  // behind search_corpus and read_corpus_document.
  if (corpusDocsForSnapshot(corpus).length) {
    snapshot.corpus = {
      note: 'Source documents available to this strategy. Consult them with search_corpus before planning or asserting anything they might cover.',
      documents: corpusDocsForSnapshot(corpus),
    };
  }
  const collectedCommands = [];
  const toolCallTrace = [];
  // Steps created during *this* chat turn. Lets add_edge resolve refs that
  // point at a sibling step the model just created (where the model knows
  // the step by a slug or title, but the server assigned a fresh id).
  const pendingSteps = [];
  // Plan created during *this* chat turn. The client only re-points
  // currentPlanId after the whole batch is applied, so without this a
  // sequence like create_plan + add_step would route the add_step to the
  // *old* current plan (or fail with "no active plan").
  // proposedOptions is filled in by the propose_options tool — the model
  // calls it when it wants to attach tappable answer chips to its reply.
  // Last call wins if the model calls it more than once in a turn.
  const turnContext = { pendingPlanId: null, proposedOptions: null, renderRequest: null };

  // The corpus index arrives with the request. The client already knows which
  // documents this strategy may read — project-wide plus its own, never another
  // strategy's — and the index is small: a summary per document, roughly 40
  // tokens. Searching it here costs nothing. Only read_corpus_document needs
  // full text, and that is one fetch for one document instead of carrying the
  // whole corpus in every turn.
  const corpusDocs = Array.isArray(corpus?.documents) ? corpus.documents : [];

  async function executeCorpusTool(name, args) {
    if (name === 'search_corpus') {
      if (!corpusDocs.length) {
        return { ok: false, message: 'No documents have been added to this project yet.', documents: [] };
      }
      const query = args?.query || '';
      const lexical = searchCorpus(corpusDocs, query, args?.docKinds);

      // HYBRID retrieval. Semantic search alone misses exact tokens — a part
      // id, "140x160mm", a standard's number — because an embedding smooths
      // precisely the details that make those worth searching for. Lexical
      // search alone misses everything phrased differently, which is most of
      // what a practitioner actually types. Neither is sufficient; together
      // they cover each other's blind spot.
      let semantic = [];
      if (corpus?.search) {
        try {
          semantic = await corpus.search(query);
        } catch (err) {
          console.warn('[corpus] semantic search unavailable:', err.message);
        }
      }

      if (!lexical.length && !semantic.length) {
        // Better to show what exists than to report a bare miss — the model can
        // then pick a document by name rather than concluding there is nothing.
        return {
          ok: true,
          documents: [],
          passages: [],
          message: 'Nothing matched. Available documents: '
            + corpusDocs.map(d => `${d.filename} [${d.id}] (${d.kind})`).join('; '),
        };
      }

      return {
        ok: true,
        // Passages come first: they are the actual answer, and returning three
        // precise excerpts costs far fewer tokens than the document they came
        // from while being more useful than a summary of it.
        passages: semantic.slice(0, 6).map(c => ({
          docId: c.docId,
          filename: c.filename,
          from: c.chunkKind === 'figure' ? `figure ${c.label || ''}`.trim() : c.chunkKind,
          text: String(c.content || '').slice(0, 1200),
          relevance: Math.round((c.score || 0) * 100) / 100,
        })),
        documents: dedupeByDoc(lexical, semantic),
      };
    }

    if (name === 'save_to_corpus') {
      // Material pasted into a chat is otherwise lost the moment the thread
      // scrolls: it is not searchable, it is not in the next conversation, and
      // nobody else in the project ever sees it. Filing it turns a paste into
      // part of the evidence base, indexed and retrievable like anything else.
      if (!corpus?.save) {
        return { ok: false, message: 'The corpus is not reachable right now, so I could not file that.' };
      }
      const title = String(args?.title || '').trim();
      const content = String(args?.content || '').trim();
      if (!title || content.length < 40) {
        return {
          ok: false,
          message: 'Give it a title and enough content to be worth storing. Short remarks belong in the conversation, not the corpus.',
        };
      }
      try {
        const saved = await corpus.save({
          title,
          content,
          docKind: ['structure', 'goal', 'technique', 'reference'].includes(args?.docKind)
            ? args.docKind : 'reference',
          scope: args?.scope === 'strategy' ? 'strategy' : 'project',
        });
        return {
          ok: true,
          document: saved,
          message: `Filed "${title}" into the ${saved.scope} corpus. It is searchable from now on.`,
        };
      } catch (err) {
        return { ok: false, message: `Could not file that: ${err.message}` };
      }
    }

    if (name === 'read_corpus_document') {
      const docId = String(args?.docId || '');
      const doc = corpusDocs.find(d => d.id === docId);
      if (!doc) {
        return {
          ok: false,
          message: `No document "${docId}" is readable from this strategy. Run search_corpus first.`,
        };
      }

      // LOOK at the original, rather than read a transcription of it.
      //
      // Ingest turns a document into text, which is right for a survey report
      // and wrong for a joinery manual: there, the drawings ARE the content,
      // and no transcription of a scarf-joint diagram substitutes for seeing
      // it. When the model asks to view a document, the original bytes go back
      // as inline_data and it examines the actual pages.
      //
      // Not the default, because it is genuinely expensive — a PDF costs
      // roughly 258 tokens per page — so it is a deliberate second step after
      // the text has told the model this is the document worth looking at.
      if (args?.view === true) {
        if (!corpus?.fetchDocument) {
          return { ok: false, message: 'Viewing the original is not available here; the text is.' };
        }
        try {
          const file = await corpus.fetchDocument(docId);
          if (!file?.data) throw new Error('empty document');
          return {
            ok: true,
            document: { id: doc.id, filename: doc.filename, kind: doc.kind, summary: doc.summary },
            message: `Showing "${doc.filename}". Examine the pages directly — read the drawings, dimensions and annotations, not just the caption text.`,
            _media: [{ mimeType: file.mimeType, data: file.data }],
          };
        } catch (err) {
          return { ok: false, message: `Could not display that document: ${err.message}. The extracted text is still available with view:false.` };
        }
      }

      if (!corpus?.fetchText) {
        return { ok: true, document: { ...doc, content: null, note: 'Full text unavailable; summary only.' } };
      }
      try {
        const text = await corpus.fetchText(docId);
        return {
          ok: true,
          document: {
            id: doc.id,
            filename: doc.filename,
            kind: doc.kind,
            scope: doc.scope,
            summary: doc.summary,
            figures: doc.figures || [],
            // Document contents are DATA. chat.md says so, but the boundary is
            // worth restating at the point the untrusted bytes actually arrive.
            content: String(text || '').slice(0, 120000),
          },
          note: (doc.figures || []).length
            ? 'This document contains figures. If the geometry matters, call read_corpus_document again with view:true to look at the pages.'
            : undefined,
        };
      } catch (err) {
        return { ok: false, message: `Could not read that document: ${err.message}` };
      }
    }
    return null;
  }

  async function executeTool(name, args) {
    // Corpus tools read; they never produce workspace commands.
    const corpusResult = await executeCorpusTool(name, args);
    if (corpusResult) {
      toolCallTrace.push({ name, args, result: corpusResult });
      return corpusResult;
    }
    const result = mapToolToCommand(name, args, snapshot, workspace, pendingSteps, turnContext);
    toolCallTrace.push({ name, args, result });
    // Only push commands when the tool succeeded. result.error means we
    // rejected the call (e.g. add_edge to an unknown step) so the model
    // sees the error via functionResponse and gets to fix itself.
    if (!result.error) {
      if (result.command) collectedCommands.push(result.command);
      if (Array.isArray(result.commands)) {
        for (const c of result.commands) collectedCommands.push(c);
      }
    }
    return result;
  }

  // First attempt: normal call
  let result;
  let firstError = null;
  const t0 = Date.now();
  try {
    result = await callGeminiWithTools({
      systemPrompt,
      userMessage,
      history,
      workspaceSnapshot: snapshot,
      tools: CHAT_TOOLS,
      executeTool,
      files,
      thinkingLevel: 'medium',
      maxTurns: 12,
      // Gemini 3.7 Flash supports up to 65k output tokens. We use a
      // generous budget so big plans (20+ steps with full descriptions)
      // can fit. The bottleneck for big plans is rarely tokens — it's
      // Gemini's tool-call argument decoder choking on deeply nested
      // structures. We mitigate by allowing more turns so the model can
      // call create_plan with a skeleton, then refine with update_step
      // calls across subsequent turns.
      maxOutputTokens: 32768
    });
    console.log('[chat-engine] first attempt OK in', Date.now() - t0, 'ms. text.len=', result?.text?.length || 0, 'tools=', toolCallTrace.length);
  } catch (err) {
    firstError = err;
    console.warn('[chat-engine] first attempt FAILED after', Date.now() - t0, 'ms:', err.message);
    console.warn('[chat-engine] context at failure: history.length=', history.length,
      'parts=', snapshot.instance?.parts?.length || 0,
      'conditions=', snapshot.conditions?.length || 0,
      'planSteps=', snapshot.currentPlan?.steps?.length || 0,
      'collectedCommands=', collectedCommands.length,
      'toolCallTrace=', toolCallTrace.length);
  }

  // Retry-on-tool-code-leak: Gemini sometimes emits its intended function
  // calls as *text* — "tool_code\nprint(default_api.add_condition(...))"
  // — instead of as proper functionCall parts. From the model's POV the
  // turn succeeded; from ours, zero tools ran and the user is about to
  // read pseudo-Python claiming things were done that weren't. Detect
  // this and re-prompt with an explicit correction. The retry instruction
  // tells the model to use real function calls AND warns it not to lie
  // about what it did. We discard the first attempt's leaked text and
  // also wipe any half-applied commands so the retry starts clean.
  if (!firstError && result?.text && looksLikeToolCodeLeak(result.text)) {
    console.warn('[chat-engine] tool_code LEAK detected in first reply (len=' + result.text.length + '). Retrying with correction.');
    // Clean slate: the leak path almost always means zero real tools ran,
    // but if the model emitted a *mix* of real calls and leaked text we
    // throw away the real calls too — the retry will redo the whole turn
    // properly. Better than a half-applied state the user can't reason about.
    collectedCommands.length = 0;
    toolCallTrace.length = 0;
    pendingSteps.length = 0;
    turnContext.pendingPlanId = null;

    const leakCorrection =
      '\n\n## TOOL-CALL CORRECTION\n\n' +
      'Your previous attempt at this user turn emitted tool calls as *text* (e.g. ' +
      '"tool_code print(default_api.add_condition(...))") instead of as real function ' +
      'calls. None of those tools actually ran. The workspace was not modified.\n\n' +
      'Retry this turn now. Use real function calls — the same tools listed in your ' +
      'tool schema (add_condition, set_intent, create_plan, etc.). Do NOT write ' +
      'tool calls as Python-looking text. Do NOT claim you did things you did not do. ' +
      'If you cannot perform the requested actions for some reason, say so plainly ' +
      'in one or two sentences and ask a clarifying question. Otherwise: make the ' +
      'function calls and write a short normal reply describing what you just did.';

    const tLeak = Date.now();
    try {
      result = await callGeminiWithTools({
        systemPrompt: systemPrompt + leakCorrection,
        userMessage,
        history,
        workspaceSnapshot: snapshot,
        tools: CHAT_TOOLS,
        executeTool,
        files,
        thinkingLevel: 'medium',
        maxTurns: 12,
        maxOutputTokens: 32768
      });
      console.log('[chat-engine] leak retry done in', Date.now() - tLeak, 'ms. text.len=', result?.text?.length || 0, 'tools=', toolCallTrace.length, 'leakAgain=', looksLikeToolCodeLeak(result?.text || ''));
    } catch (retryErr) {
      // The retry itself errored. Fall through — the strip-and-apologize
      // path at the end will catch it. Don't throw: we want to give the
      // user *something* useful rather than a 500.
      console.warn('[chat-engine] leak retry threw:', retryErr.message);
      firstError = retryErr;
    }
  }

  // Retry-with-collaboration: if the first attempt failed with a model-side
  // problem (MALFORMED_FUNCTION_CALL, empty output, MAX_TOKENS), try again
  // with an explicit instruction to break the work down and ask the user
  // for help. This turns a hard failure into a productive conversation.
  const failed = firstError || (!result?.text?.trim() && toolCallTrace.length === 0);
  if (failed) {
    const errorContext = firstError?.message || 'no response';
    const fallbackInstruction =
      `The previous attempt failed: ${errorContext}. ` +
      `This means your task was too large to do in one go. ` +
      `Do NOT try again to do everything at once. ` +
      `Instead: reply with a short message that (a) acknowledges the request is ambitious, ` +
      `(b) proposes 2-3 ways to break it into smaller chunks, ` +
      `(c) asks the user which chunk to do first. ` +
      `Do NOT call any tools in this response — just write the chunking proposal as plain text.`;

    try {
      result = await callGeminiWithTools({
        systemPrompt: systemPrompt + '\n\n## RETRY MODE\n\n' + fallbackInstruction,
        userMessage,
        history,
        workspaceSnapshot: snapshot,
        // No tools on the retry — we want a conversational fallback only.
        tools: [],
        executeTool: async () => ({ ok: true }),
        thinkingLevel: 'low',
        maxTurns: 1,
        maxOutputTokens: 2048
      });
    } catch (retryErr) {
      // If even the simple retry fails, surface the original error so the
      // user knows what went wrong.
      throw firstError || retryErr;
    }
  }

  return {
    // Keep stripToolCodeLeak to defang Gemini's textual tool-call leaks,
    // but DON'T strip markdown — the client renders markdown now (see
    // renderAssistantMarkdown in chat-sheet.js), so stripping it server-side
    // would turn nicely formatted lists into walls of text.
    reply: stripToolCodeLeak(result.text || ''),
    commands: collectedCommands,
    toolCalls: toolCallTrace,
    plannedSummary: buildSummary(collectedCommands),
    // Tappable answer chips, populated by the propose_options tool. Null
    // when the model didn't call it (most turns).
    followUpOptions: turnContext.proposedOptions || null,
    // A request to (re)generate the imagined result. The image model is NOT
    // called here: generation takes tens of seconds and the bytes belong in
    // the browser IndexedDB, so the client runs it and posts the result back
    // into this thread. Any plan changes the instruction implied are in
    // commands above and apply FIRST, so the image regenerates from the
    // updated plan rather than the one that prompted the complaint.
    renderRequest: turnContext.renderRequest || null
  };
}

/**
 * Lean workspace snapshot — the slice the chat AI actually needs.
 * Drops large/noisy fields like full part geometry, edge metadata,
 * past conversation threads. The AI gets enough to reason about
 * the artefact, its conditions, intent, constraints, and the
 * current strategy.
 */
/**
 * Compute scaffolding gaps in the workspace — empty fields the user might
 * want to fill in before going deeper. The result lives at the top of the
 * lean snapshot so the model can see it every turn without having to
 * derive it from the data each time.
 *
 * IMPORTANT: this is *information*, not a to-do list. The prompt instructs
 * the model to mention at most one gap per turn, only when it's relevant,
 * and not to nag. Gaps that disappear (because the user filled them in)
 * naturally stop showing up on subsequent turns.
 *
 * Each flag is a short, dotted key + a one-line "what it means" message.
 * Keeping these terse so the model can scan them quickly.
 */
function computeGaps(ws) {
  const gaps = [];
  const intent = ws.intent || {};
  const constraints = ws.constraints || {};
  const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);

  // Intent gaps
  if (!intent.summary || !intent.summary.trim()) {
    gaps.push({
      key: 'intent.summary_missing',
      hint: 'no intent summary written — the project has no stated goal yet'
    });
  }
  // Axes default to 0.5 in the schema. If all of them are still at 0.5,
  // the user hasn't expressed any priorities yet.
  //
  // Unweighed axes (value null — a proposal nobody has taken up) are skipped
  // rather than counted as 0.5. Counting them would let a proposal the
  // participant ignored make the intent look more considered than it is.
  const axes = (Array.isArray(intent.axes) ? intent.axes : [])
    .filter(a => typeof a?.value === 'number' && Number.isFinite(a.value));
  if (axes.length && axes.every(a => Math.abs(a.value - 0.5) < 0.01)) {
    gaps.push({
      key: 'intent.axes_all_default',
      hint: 'all intent axes are at the 0.5 default — no priorities expressed (sustainability vs cost, authenticity vs intervention, etc.)'
    });
  }
  const unweighed = (Array.isArray(intent.axes) ? intent.axes : [])
    .filter(a => a && (a.value === null || a.value === undefined));
  if (unweighed.length) {
    gaps.push({
      key: 'intent.axes_unweighed',
      hint: `${unweighed.length} proposed criteri${unweighed.length === 1 ? 'on has' : 'a have'} not been weighted yet `
          + `(${unweighed.map(a => a.label).join(', ')}) — they carry no importance and do not influence anything until the participant sets one`
    });
  }

  // Constraints: empty if every known field is null/undefined/empty.
  const constraintFields = [
    'tools_available', 'materials_available', 'time_budget_minutes',
    'budget_limit', 'skill_level', 'safety_level',
    'allowed_operations', 'avoid_operations', 'additional_constraints'
  ];
  const hasAnyConstraint = constraintFields.some(f => {
    const v = constraints[f];
    return v !== null && v !== undefined && v !== '' && v !== 0;
  });
  if (!hasAnyConstraint) {
    gaps.push({
      key: 'constraints.empty',
      hint: 'no practical constraints set (tools available, time budget, skill level, etc.)'
    });
  }

  // Artefact gaps
  if ((ws.conditions || []).length === 0) {
    gaps.push({
      key: 'conditions.none',
      hint: 'no conditions registered on the artefact yet — nothing to plan around'
    });
  }

  // Plan gaps
  if (!plan) {
    gaps.push({
      key: 'plan.none',
      hint: 'no current plan exists — only relevant once intent + conditions are clear enough to plan around'
    });
  } else {
    const steps = plan.steps || [];
    if (steps.length > 0) {
      const skeletal = steps.filter(s => !s.description || s.description.trim().length < 20);
      if (skeletal.length === steps.length) {
        gaps.push({
          key: 'plan.skeletal',
          hint: `current plan is a skeleton — all ${steps.length} steps have no real description yet (tools, materials, timing absent)`
        });
      } else if (skeletal.length >= steps.length * 0.6) {
        gaps.push({
          key: 'plan.mostly_skeletal',
          hint: `most steps in the current plan still lack detail (${skeletal.length} of ${steps.length} have descriptions under 20 chars)`
        });
      }
    }
  }

  return gaps;
}

/**
 * Lean workspace snapshot — the slice the chat AI actually needs.
 * Drops large/noisy fields like full part geometry, edge metadata,
 * past conversation threads. The AI gets enough to reason about
 * the artefact, its conditions, intent, constraints, and the
 * current strategy.
 */
function leanWorkspace(ws, thread = null) {
  const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
  // Tell the model which scope of conversation it's in. The chat UI has
  // multiple threads (global + per-part + per-strategy + ...) and the
  // model needs to know which lens to use — a per-strategy thread should
  // stay focused on that strategy, while a global thread can range across.
  const chatScope = thread ? {
    scope: thread.scope || 'global',
    ref: thread.ref || null,
    // When the user is scoped to a specific plan, name it explicitly so
    // the model doesn't have to cross-reference ids.
    planLabel: (thread.scope === 'plan' && thread.ref)
      ? ((ws.plans || []).find(p => p.id === thread.ref)?.label || null)
      : null
  } : { scope: 'global', ref: null, planLabel: null };
  return {
    // Tell the model up front where the conversation is scoped.
    chatScope,
    // Gaps come first so the model encounters them while scanning the
    // snapshot. See computeGaps() for the contract — these are
    // informational, not a checklist.
    gaps: computeGaps(ws),
    instance: {
      id: ws.instance?.id,
      name: ws.instance?.name,
      parts: (ws.instance?.parts || []).map(p => ({
        id: p.id, label: p.label, material: p.material, status: p.status
      }))
    },
    conditions: (ws.conditions || []).map(h => ({
      id: h.id, type: h.type, description: h.description,
      partRef: h.partRef, status: h.status, confidence: h.confidence
    })),
    // Weighed axes only. A proposal the participant has not taken up must not
    // appear in the model's own snapshot — it would read the criterion back as
    // established and reason from something nobody accepted, and it would
    // re-propose what is already pending. See workspace-read.weighedAxes.
    intent: ws.intent
      ? { ...ws.intent, axes: (ws.intent.axes || []).filter(a => typeof a?.value === 'number' && Number.isFinite(a.value)) }
      : ws.intent,
    constraints: ws.constraints,
    currentPlanId: ws.currentPlanId,
    currentPlan: plan ? {
      id: plan.id, label: plan.label, status: plan.status,
      steps: (plan.steps || []).map(s => ({
        id: s.id, title: s.title, description: s.description,
        affectedPartRefs: s.affectedPartRefs,
        addressesConditionRefs: s.addressesConditionRefs
      })),
      edges: (plan.edges || []).map(e => ({ source: e.source, target: e.target })),
      mutexGroups: plan.mutexGroups
    } : null,
    plans: (ws.plans || []).map(p => ({
      id: p.id, label: p.label, status: p.status, stepCount: (p.steps || []).length
    }))
  };
}

/**
 * Translate one tool call from the AI's vocabulary into a workspace
 * command. Returns { ok|error, command?, ...details }.
 *
 * `pendingSteps` is a shared mutable array carrying step-id information
 * for steps created earlier in the same chat turn — so add_edge can
 * resolve refs that point at a step the model just created via add_step.
 *
 * `turnContext.pendingPlanId` carries the id of a plan created earlier
 * in this turn via create_plan. Subsequent step-mutation tools in the
 * same turn must target that plan, not the stale workspace currentPlanId.
 */
export function mapToolToCommand(name, args, snapshot, fullWorkspace, pendingSteps = [], turnContext = {}) {
  const activePlanId = turnContext.pendingPlanId || fullWorkspace.currentPlanId || null;
  const currentPlan = activePlanId
    ? (fullWorkspace.plans || []).find(p => p.id === activePlanId) || null
    : null;
  const aliases = buildStepAliasMap(currentPlan, pendingSteps);

  // True when `obj` is null/undefined or has no own enumerable string keys.
  // Used to reject no-op patches across update_* / set_* tools — silently
  // accepting them caused the "I updated the intent" bug where the model
  // called set_intent with an empty argument object, the dispatcher said
  // ok, the client applied a no-op command, and the user saw a confident
  // receipt for work that didn't happen.
  const isEmptyPatch = (obj) =>
    obj == null || typeof obj !== 'object' || Object.keys(obj).length === 0;

  /**
   * Refuse a call that names something which does not exist.
   *
   * The client's reducers return the workspace unchanged when an id does not
   * resolve — quietly, by design, so a stale command cannot corrupt state. The
   * cost is that the tool still reported success, the receipt still counted a
   * change, and the model told the user it had done something it had not. A
   * false "done" is worse than an error: an error the model can see and correct
   * within the same turn, which is what add_edge already does.
   *
   * Returning the known ids matters as much as the refusal. It turns a dead end
   * into a self-correction — the model retries with a real id instead of
   * apologising or, worse, inventing an explanation for the discrepancy.
   */
  const requireExisting = (tool, noun, id, collection, describe = item => item.id) => {
    const list = Array.isArray(collection) ? collection : [];
    if (id && list.some(item => item?.id === id)) return null;
    const known = list.map(describe).join(', ');
    return {
      error: `${tool}: no ${noun} with id "${id ?? ''}". `
           + `Known ${noun}s: ${known || '(none)'}. `
           + 'Use one of these exactly, or tell the user it does not exist.',
    };
  };

  switch (name) {
    case 'add_condition': {
      const id = newId('cond');
      // Default coordinates: anchor to the part's origin.
      //
      // In this workspace, a part's `origin` is the position of its mesh
      // in world space (see views/viewer-3d.js: mesh.position.set(o.x,
      // o.y, o.z)). The box geometry extends symmetrically around that
      // origin, so the origin is effectively the part's anchor point —
      // not a corner. The viewer also skips rendering condition spheres
      // that have no coordinates at all, so we need *some* coordinate.
      //
      // For an unlocated condition (e.g. "weathering across the whole
      // leg") the right default is the part origin itself. That keeps
      // the marker visually attached to its part instead of floating
      // away by half a bounding box, which is what a naive
      // origin + dim/2 calculation produced. propose.js uses the same
      // convention in rescueCoordinates(): when a condition has no
      // meaningful location, snap it to the part origin.
      //
      // If the model has a real spatial cue from the user ("crack on
      // the upper-left of the seat"), it can pass an explicit
      // `coordinates` argument and we honour it.
      let coordinates = null;
      const part = (fullWorkspace.instance?.parts || []).find(p => p.id === args.partRef);
      // A partRef that matches nothing leaves coordinates null, and the viewer
      // skips condition spheres with no coordinates (see the note above). The
      // condition would appear in the list and nowhere in the 3D view — which
      // is where someone surveying a structure actually looks.
      if (args.partRef && !part) {
        const known = (fullWorkspace.instance?.parts || []).map(p => `${p.id} ("${p.name}")`).join(', ');
        return {
          error: `add_condition: no part with id "${args.partRef}". Known parts: ${known || '(none)'}. `
               + 'Use one of these exactly — a condition on an unknown part cannot be placed in the 3D view.',
        };
      }
      if (args.coordinates && typeof args.coordinates === 'object') {
        coordinates = {
          x: Number(args.coordinates.x) || 0,
          y: Number(args.coordinates.y) || 0,
          z: Number(args.coordinates.z) || 0
        };
      } else if (part?.origin) {
        coordinates = {
          x: part.origin.x || 0,
          y: part.origin.y || 0,
          z: part.origin.z || 0
        };
      }
      return {
        ok: true, conditionId: id,
        message: `Added ${args.type} on ${args.partRef}`,
        command: {
          type: 'add-condition',
          payload: {
            condition: {
              id, type: args.type, description: args.description,
              partRef: args.partRef,
              coordinates,
              status: args.status || 'suspected',
              confidence: args.confidence ?? 0.7
            }
          }
        }
      };
    }
    case 'remove_condition': {
      const gone = requireExisting(
        'remove_condition', 'condition', args.conditionId, fullWorkspace.conditions,
        c => `${c.id} ("${c.type}${c.partRef ? ' on ' + c.partRef : ''}")`,
      );
      if (gone) return gone;
      return {
        ok: true, message: `Removed ${args.conditionId}`,
        command: { type: 'remove-condition', payload: { conditionId: args.conditionId } }
      };
    }
    case 'update_condition': {
      if (!args.conditionId) {
        return { error: 'update_condition: conditionId is required.' };
      }
      const missing = requireExisting(
        'update_condition', 'condition', args.conditionId, fullWorkspace.conditions,
        c => `${c.id} ("${c.type}${c.partRef ? ' on ' + c.partRef : ''}")`,
      );
      if (missing) return missing;
      if (isEmptyPatch(args.patch)) {
        return {
          error: `update_condition called on ${args.conditionId} with an empty patch — ` +
                 'nothing to update. Pass `patch` with at least one of: type, description, status, confidence.'
        };
      }
      const changedFields = Object.keys(args.patch).join(', ');
      return {
        ok: true,
        message: `Updated ${args.conditionId} (${changedFields})`,
        command: { type: 'update-condition', payload: { conditionId: args.conditionId, patch: args.patch } }
      };
    }
    case 'set_intent': {
      const intent = {};
      if (args.summary !== undefined) intent.summary = args.summary;
      if (Array.isArray(args.axes) && args.axes.length > 0) {
        const existing = (snapshot.intent?.axes || []).slice();
        // An axis id that matches nothing used to be dropped here in silence,
        // and the receipt below still counted it as changed — so the model
        // reported "Reversibility added", the radar did not move, and the user
        // was told something untrue. Refuse instead, the way add_edge does,
        // and say what the model CAN do: it may re-weight the axes that exist,
        // and only the participant may create a new one.
        const unknown = args.axes.filter(upd => !existing.some(a => a.id === upd.id));
        if (unknown.length) {
          const known = existing.map(a => `${a.id} ("${a.label}")`).join(', ');
          return {
            error: `set_intent: no axis with id ${unknown.map(u => `"${u.id}"`).join(', ')}. `
                 + `Known axes: ${known || '(none)'}. `
                 + 'set_intent only changes the value of an axis that already exists. '
                 + 'To introduce a NEW criterion, call propose_intent_axis — it puts the axis '
                 + 'on the radar unweighted for the participant to weigh. Do not imply you '
                 + 'have set its importance; you cannot.',
          };
        }
        for (const upd of args.axes) {
          const idx = existing.findIndex(a => a.id === upd.id);
          if (idx >= 0) existing[idx] = { ...existing[idx], value: upd.value };
        }
        intent.axes = existing;
      }
      if (isEmptyPatch(intent)) {
        return {
          error: 'set_intent called with no summary and no axes — nothing to update. ' +
                 'Pass `summary` (string) and/or `axes` (array of {id, value}). ' +
                 'For a directional shift like "preservation for a museum", pass BOTH ' +
                 'the new summary AND the axis values it implies.'
        };
      }
      // Build a human-friendly summary that names what actually changed,
      // so the receipt the user sees ("1 intent change") is honest and
      // the model has a precise echo to paraphrase in its prose.
      const changedParts = [];
      if (intent.summary !== undefined) changedParts.push('summary');
      if (Array.isArray(intent.axes)) changedParts.push(`${args.axes.length} axis value${args.axes.length === 1 ? '' : 's'}`);
      return {
        ok: true,
        message: `Intent updated (${changedParts.join(' and ')})`,
        // Pin to the active plan id. In a turn where the model just
        // called create_plan, activePlanId is the freshly-created plan
        // — without this, set-intent would patch the (still-current on
        // the client) OLD plan, leaving the new plan with default intent.
        command: { type: 'set-intent', payload: { intent, planId: activePlanId || null } }
      };
    }
    case 'revise_rendering': {
      const instruction = String(args.instruction || '').trim();
      if (!instruction) {
        return { error: 'revise_rendering: instruction is required — say what the depicted result should be.' };
      }
      if (!activePlanId) {
        return { error: 'revise_rendering: there is no active strategy to imagine a result for.' };
      }
      // One render per turn. Without this the model can queue several against
      // the same starting image, each ignoring the others' changes, and the
      // participant pays for every one.
      if (turnContext.renderRequest) {
        return {
          error: 'revise_rendering: a revision is already queued for this turn. '
               + 'Combine everything that should change into one instruction.',
        };
      }
      turnContext.renderRequest = { instruction: instruction.slice(0, 1200), planId: activePlanId };
      return {
        ok: true,
        message: `Queued a revision: "${instruction.slice(0, 80)}"`
             + (args.changesPlan ? ' (after this turn\'s plan changes)' : ''),
        // No command. The client runs the generation because the image bytes
        // live in its IndexedDB and the call takes longer than this endpoint's
        // budget — see renderRequest on the turn result.
      };
    }
    case 'propose_intent_axis': {
      const label = String(args.label || '').trim();
      if (!label) return { error: 'propose_intent_axis: label is required.' };
      if (!String(args.rationale || '').trim()) {
        return {
          error: 'propose_intent_axis: rationale is required — say what in the material or the '
               + 'conversation prompted this criterion. A criterion with no stated reason is '
               + 'not something the participant can judge.',
        };
      }
      // Refuse a near-duplicate. Two axes meaning the same thing split the
      // participant's attention and make the radar unreadable, and the model
      // cannot see which axes it has already proposed in earlier turns —
      // history is replayed as text, without tool calls.
      const existingAxes = snapshot.intent?.axes || [];
      const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
      const clash = existingAxes.find(a => norm(a.label) === norm(label));
      if (clash) {
        return {
          error: `propose_intent_axis: "${clash.label}" is already an axis on this strategy `
               + `(${clash.id}). Re-weight it with set_intent, or propose a criterion it cannot express.`,
        };
      }
      return {
        ok: true,
        message: `Proposed "${label}" — unweighted, for the participant to weigh`,
        command: {
          type: 'add-intent-axis',
          payload: {
            planId: activePlanId || null,
            axis: {
              label: label.slice(0, 60),
              description: String(args.description || '').slice(0, 300),
              // Unweighted. There is no tool that sets a weight; the only way
              // a criterion gains force is a human dragging its handle.
              value: null,
              origin: 'assistant',
              sourceRefs: Array.isArray(args.sourceRefs)
                ? args.sourceRefs.filter(r => typeof r === 'string').slice(0, 8)
                : [],
            },
          },
        },
      };
    }
    case 'set_constraints': {
      // Filter to keys that have real values — `args` may contain
      // undefined entries from Gemini even when nothing was meant.
      const constraints = {};
      for (const [k, v] of Object.entries(args || {})) {
        if (v !== undefined && v !== null && v !== '') constraints[k] = v;
      }
      if (isEmptyPatch(constraints)) {
        return {
          error: 'set_constraints called with no fields — nothing to update. ' +
                 'Pass at least one field (tools_available, materials_available, ' +
                 'time_budget_minutes, budget_limit, skill_level, safety_level, ' +
                 'allowed_operations, avoid_operations, additional_constraints).'
        };
      }
      const fieldNames = Object.keys(constraints).join(', ');
      return {
        ok: true,
        message: `Constraints updated: ${fieldNames}`,
        // Pin to active plan id — same rationale as set-intent above.
        command: { type: 'set-constraints', payload: { constraints, planId: activePlanId || null } }
      };
    }
    case 'create_plan': {
      const planId = newId('plan');
      // First pass: stamp every step with a real id, register it in
      // pendingSteps so subsequent tool calls (and edge resolution below)
      // can find it by the slug/title the model originally used.
      const steps = (args.steps || []).map(s => {
        const realId = s.id && /^step_/.test(s.id) ? s.id : newId('step');
        pendingSteps.push({
          realId,
          requestedSlug: s.id || null,
          title: s.title || null
        });
        return {
          id: realId,
          title: s.title, description: s.description,
          affectedPartRefs: s.affectedPartRefs || [],
          addressesConditionRefs: s.addressesConditionRefs || [],
          toolsRequired: s.toolsRequired || [],
          materialsRequired: s.materialsRequired || [],
          estimatedMinutes: s.estimatedMinutes || null
        };
      });
      // Resolve edges against the now-registered steps. Skip silently any
      // edge whose endpoints don't resolve — a partial plan is better than
      // no plan when participants are watching.
      const localAliases = buildStepAliasMap(currentPlan, pendingSteps);
      const edges = [];
      const droppedEdges = [];
      for (const e of (args.edges || [])) {
        const src = resolveStepRef(e.source, localAliases);
        const tgt = resolveStepRef(e.target, localAliases);
        if (src && tgt) {
          edges.push({ id: newId('edge'), source: src, target: tgt });
        } else {
          droppedEdges.push({ source: e.source, target: e.target });
        }
      }
      const mutexGroups = (args.mutexGroups || []).map(g => ({
        id: newId('mutex'), label: g.label || '',
        stepIds: (g.stepIds || []).map(id => resolveStepRef(id, localAliases)).filter(Boolean)
      })).filter(g => g.stepIds.length >= 2);
      if (droppedEdges.length) {
        console.warn('[chat-engine] create_plan: dropped', droppedEdges.length, 'unresolvable edge(s):', droppedEdges);
      }
      // Mark this plan as in-turn active so later tool calls route to it.
      turnContext.pendingPlanId = planId;
      return {
        ok: true, planId, stepIds: steps.map(s => s.id),
        message: `Created plan "${args.label}" with ${steps.length} steps`
          + (droppedEdges.length ? ` (${droppedEdges.length} edge(s) skipped)` : ''),
        command: {
          type: 'add-plan',
          payload: { plan: { id: planId, label: args.label, status: 'draft', steps, edges, mutexGroups } }
        }
      };
    }
    case 'add_step': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan. Call create_plan first.' };
      const stepId = newId('step');
      // Register BEFORE resolving after/before so the new step itself is
      // findable by later tool calls in this turn.
      pendingSteps.push({
        realId: stepId,
        requestedSlug: args.slug || null,
        title: args.title || null
      });
      const commands = [{
        type: 'upsert-step',
        payload: {
          planId: currentPlanId,
          step: {
            id: stepId, title: args.title, description: args.description,
            affectedPartRefs: args.affectedPartRefs || [],
            addressesConditionRefs: args.addressesConditionRefs || [],
            toolsRequired: args.toolsRequired || [],
            materialsRequired: args.materialsRequired || [],
            estimatedMinutes: args.estimatedMinutes || null
          }
        }
      }];
      // Auto-wire. afterStepId/beforeStepId may be a real id, slug, or
      // title; resolve via the alias map. If unresolvable, skip the edge
      // and warn rather than failing the whole batch.
      const localAliases = buildStepAliasMap(currentPlan, pendingSteps);
      const warnings = [];
      if (args.afterStepId) {
        const src = resolveStepRef(args.afterStepId, localAliases);
        if (src) {
          commands.push({
            type: 'add-edge',
            payload: { planId: currentPlanId, source: src, target: stepId }
          });
        } else {
          warnings.push(`afterStepId "${args.afterStepId}" did not match — edge skipped`);
        }
      }
      if (args.beforeStepId) {
        const tgt = resolveStepRef(args.beforeStepId, localAliases);
        if (tgt) {
          commands.push({
            type: 'add-edge',
            payload: { planId: currentPlanId, source: stepId, target: tgt }
          });
        } else {
          warnings.push(`beforeStepId "${args.beforeStepId}" did not match — edge skipped`);
        }
      }
      return {
        ok: true, stepId,
        message: `Added step "${args.title}"` + (warnings.length ? ` (${warnings.join('; ')})` : ''),
        commands
      };
    }
    case 'update_step': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      const resolvedId = resolveStepRef(args.stepId, aliases);
      if (!resolvedId) {
        const known = (currentPlan?.steps || []).map(s => s.id).join(', ');
        return { error: `update_step: step "${args.stepId}" not found. Known: ${known || '(none)'}` };
      }
      if (isEmptyPatch(args.patch)) {
        return {
          error: `update_step on ${resolvedId} called with an empty patch — nothing to update. ` +
                 'Pass `patch` with at least one of: title, description, affectedPartRefs, ' +
                 'addressesConditionRefs, toolsRequired, materialsRequired, estimatedMinutes.'
        };
      }
      const changedFields = Object.keys(args.patch).join(', ');
      return {
        ok: true,
        message: `Updated ${resolvedId} (${changedFields})`,
        command: { type: 'upsert-step', payload: { planId: currentPlanId, step: { id: resolvedId, ...args.patch } } }
      };
    }
    case 'remove_step': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      const resolvedId = resolveStepRef(args.stepId, aliases);
      if (!resolvedId) {
        const known = (currentPlan?.steps || []).map(s => s.id).join(', ');
        return { error: `remove_step: step "${args.stepId}" not found. Known: ${known || '(none)'}` };
      }
      return {
        ok: true, message: `Removed ${resolvedId}`,
        command: { type: 'remove-step', payload: { planId: currentPlanId, stepId: resolvedId } }
      };
    }
    case 'add_edge': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      const src = resolveStepRef(args.source, aliases);
      const tgt = resolveStepRef(args.target, aliases);
      if (!src || !tgt) {
        // Return a tool-level error so Gemini sees it via functionResponse
        // and can correct itself in the same turn — instead of the batch
        // dying at apply time and the user seeing nothing happen.
        const known = (currentPlan?.steps || [])
          .map(s => `${s.id} ("${s.title}")`)
          .concat(pendingSteps.map(p => `${p.realId} ("${p.title || p.requestedSlug || ''}") [this turn]`))
          .join(', ');
        const what = !src && !tgt ? `source "${args.source}" and target "${args.target}"`
                   : !src ? `source "${args.source}"`
                   : `target "${args.target}"`;
        return {
          error: `add_edge: ${what} did not match any step in the current plan. ` +
                 `Known steps: ${known || '(none)'}.`
        };
      }
      return {
        ok: true, message: `Linked ${src} → ${tgt}`,
        command: { type: 'add-edge', payload: { planId: currentPlanId, source: src, target: tgt } }
      };
    }
    case 'remove_edge': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      // This one could never have worked. The tool requires an edgeId, but the
      // snapshot sends edges as {source, target} with the id stripped (see
      // leanWorkspace), so there is no id for the model to pass. Every call
      // reached the reducer, matched nothing, changed nothing, and was still
      // reported as "1 removed connection". Refuse honestly instead of
      // pretending; the edges are listed so the model can describe which one it
      // meant rather than silently failing to remove it.
      const edges = (currentPlan?.edges || []);
      const known = edges.map(e => `${e.source} → ${e.target}`).join(', ');
      const match = edges.some(e => e.id === args.edgeId);
      if (!match) {
        return {
          error: `remove_edge: "${args.edgeId}" is not an edge id in this plan. `
               + `Edges here are ${known || '(none)'}. `
               + 'You cannot remove an edge — edge ids are not part of the information you are given. '
               + 'Say so plainly, and describe which connection you would remove.',
        };
      }
      return { ok: true, message: `Removed edge ${args.edgeId}`, command: { type: 'remove-edge', payload: { planId: currentPlanId, edgeId: args.edgeId } } };
    }
    case 'set_active_plan': {
      // A planId that resolves to nothing is worse than a no-op: the reducer
      // sets currentPlanId to it regardless, no plan is then current, and
      // getCurrentIntent falls back to a fresh default — so the radar snaps
      // back to the six seed axes and the participant's strategy looks erased.
      const noPlan = requireExisting(
        'set_active_plan', 'plan', args.planId, fullWorkspace.plans,
        p => `${p.id} ("${p.label}")`,
      );
      if (noPlan) return noPlan;
      // Keep the in-turn context consistent so later tool calls target
      // the same plan the model just switched to.
      turnContext.pendingPlanId = args.planId || null;
      return { ok: true, message: `Switched to plan ${args.planId}`, command: { type: 'set-current-plan', payload: { planId: args.planId } } };
    }
    case 'update_plan': {
      if (!args.planId) {
        return { error: 'update_plan: planId is required.' };
      }
      const noPlan = requireExisting(
        'update_plan', 'plan', args.planId, fullWorkspace.plans,
        p => `${p.id} ("${p.label}")`,
      );
      if (noPlan) return noPlan;
      if (isEmptyPatch(args.patch)) {
        return {
          error: `update_plan on ${args.planId} called with an empty patch — nothing to update. ` +
                 'Pass `patch` with at least one of: label, summary.'
        };
      }
      const changedFields = Object.keys(args.patch).join(', ');
      return {
        ok: true,
        message: `Updated plan ${args.planId} (${changedFields})`,
        command: { type: 'update-plan', payload: { planId: args.planId, patch: args.patch } }
      };
    }
    case 'remove_plan': {
      const noPlan = requireExisting(
        'remove_plan', 'plan', args.planId, fullWorkspace.plans,
        p => `${p.id} ("${p.label}")`,
      );
      if (noPlan) return noPlan;
      // If the model removes the plan it was about to mutate, clear the
      // turn-local pointer so later tool calls don't write into the void.
      if (turnContext.pendingPlanId === args.planId) turnContext.pendingPlanId = null;
      return { ok: true, message: `Removed plan ${args.planId}`, command: { type: 'remove-plan', payload: { planId: args.planId } } };
    }
    case 'propose_options': {
      // This tool doesn't produce a workspace command — it captures
      // tappable answer chips into the turn context, to be attached to
      // the final reply. We still validate so the model can self-correct
      // via the error path.
      const opts = Array.isArray(args.options) ? args.options : null;
      if (!opts) {
        return { error: 'propose_options: `options` must be an array of 2-4 short string labels.' };
      }
      if (opts.length < 2) {
        return { error: 'propose_options: need at least 2 options. If the question only has one obvious answer, ask plainly instead.' };
      }
      if (opts.length > 4) {
        return { error: 'propose_options: at most 4 options. If you have more than 4 alternatives, ask an open question instead.' };
      }
      const labels = opts.map(o => String(o).trim()).filter(Boolean);
      if (labels.length !== opts.length) {
        return { error: 'propose_options: every option must be a non-empty string.' };
      }
      // Last call wins if the model calls more than once. Each label
      // becomes both the chip text and the message sent when tapped.
      turnContext.proposedOptions = labels.map(label => ({ label, value: label }));
      return {
        ok: true,
        message: `Options attached: ${labels.join(' | ')}`
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildSummary(commands) {
  if (!commands.length) return '';
  const counts = {};
  for (const c of commands) counts[c.type] = (counts[c.type] || 0) + 1;
  const friendly = {
    'add-condition': 'condition',
    'remove-condition': 'removed condition',
    'update-condition': 'updated condition',
    'add-plan': 'plan',
    'remove-plan': 'removed plan',
    'upsert-step': 'step',
    'remove-step': 'removed step',
    'add-edge': 'connection',
    'remove-edge': 'removed connection',
    'set-intent': 'intent change',
    'set-constraints': 'constraints change',
    'set-current-plan': 'switched plan'
  };
  const parts = [];
  for (const [type, n] of Object.entries(counts)) {
    const label = friendly[type] || type;
    parts.push(n === 1 ? `1 ${label}` : `${n} ${label}s`);
  }
  return parts.join(', ');
}
