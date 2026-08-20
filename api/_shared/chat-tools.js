/**
 * Tool definitions for the conversational chat endpoint.
 *
 * These are the workspace-mutating "verbs" the AI can call directly while
 * conversing with the user. Each tool maps to a single workspace command
 * defined in src/core/commands.js — but only the ones the AI should be
 * able to perform in a chat. Commands like `undo`/`redo` or schema-level
 * mutations are deliberately not exposed.
 *
 * Schema convention: parameters are described as terse as possible while
 * still being unambiguous. The model is good at inferring sensible
 * defaults when the user's text doesn't specify a field.
 */

export const CHAT_TOOLS = [
  {
    name: 'add_condition',
    description: 'Register a new observed condition (damage/defect/feature) on a specific artefact part. Use one call per affected part — never collapse multiple parts into one call. By default the marker is anchored to the part itself (its origin point), which is correct for non-localised conditions like weathering, discolouration, or general wear that affect the whole part. Only pass explicit `coordinates` when the user has indicated a specific spot on the part (e.g. "crack on the upper edge of the seat"). When in doubt, omit coordinates.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Short label for the condition type (e.g. "Crack", "Weathering", "Loose joint")' },
        description: { type: 'string', description: 'Concise description of what was observed' },
        partRef: { type: 'string', description: 'ID of the affected part' },
        status: { type: 'string', enum: ['suspected', 'confirmed', 'refuted'], description: 'Confidence status. Default "suspected" unless the user has clear visual confirmation.' },
        confidence: { type: 'number', description: 'Confidence 0..1. Default 0.7.' },
        coordinates: {
          type: 'object',
          description: 'OPTIONAL. World-space (x,y,z) location of the condition marker. Omit this for whole-part conditions (weathering, discolouration, surface wear) so the marker anchors to the part. Only set it when the user has identified a specific spot on the part.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' }
          }
        }
      },
      required: ['type', 'description', 'partRef']
    }
  },
  {
    name: 'remove_condition',
    description: 'Remove a condition by its id.',
    parameters: {
      type: 'object',
      properties: { conditionId: { type: 'string' } },
      required: ['conditionId']
    }
  },
  {
    name: 'update_condition',
    description: 'Update fields of an existing condition. Only the fields in patch are changed.',
    parameters: {
      type: 'object',
      properties: {
        conditionId: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['suspected', 'confirmed', 'refuted'] },
            confidence: { type: 'number' }
          }
        }
      },
      required: ['conditionId', 'patch']
    }
  },
  {
    name: 'search_corpus',
    description: "Search the project's source documents. Use this BEFORE making claims about the structure, its history, the repair goal, or a technique — the corpus is the evidence base, and grounded answers beat plausible ones. Returns matching documents with their summaries and the passages that matched. You see project-wide documents plus the ones attached to the current strategy; other strategies' documents are deliberately not visible.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for. Plain language; matched against document text, summaries and extracted facts.' },
        docKinds: {
          type: 'array',
          description: "Optionally narrow by role: 'structure' (describes the object), 'goal' (states the repair intent), 'technique' (method or precedent), 'reference'.",
          items: { type: 'string' },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_corpus_document',
    description: "Read one corpus document, by id. Use after search_corpus has told you which document matters, or when the user names one. Quote what the document actually says rather than guessing. Set view:true to LOOK at the original pages instead of the extracted text — necessary when the content is drawings rather than prose (joint geometry, sections, dimensioned details, a photographed page). Read the text first; escalate to view:true when the geometry is what matters.",
    parameters: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'The document id from search_corpus or the corpus index.' },
        view: {
          type: 'boolean',
          description: 'Return the original document as an image/PDF for you to examine visually, instead of its extracted text. Use when drawings, dimensions or spatial detail matter. Costs more, so read the text first.',
        },
      },
      required: ['docId'],
    },
  },
  {
    name: 'save_to_corpus',
    description: "File something into the project's source documents so it is retrievable later. Use when the user PASTES reference material into the chat — a specification, a standard, a supplier's data, a quotation from a source, measurements from a report, a technique description. It is then indexed and searchable in every future conversation, by you and by the user. Do NOT file conversation: questions, decisions, your own suggestions, or anything already in the workspace as a condition or a step. File the source material, not the discussion of it. Always tell the user you have filed it.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short descriptive filename, e.g. "DIN 68800-2 excerpt — timber preservation".' },
        content: { type: 'string', description: 'The material itself, verbatim. Do not summarise or rewrite it — this becomes the stored source.' },
        docKind: {
          type: 'string',
          description: "'structure' (describes the object), 'goal' (states the repair intent), 'technique' (a method or precedent), 'reference' (anything else).",
        },
        scope: {
          type: 'string',
          description: "'project' if it concerns the artefact and everyone should have it; 'strategy' if it only bears on the current strategy's approach. When unsure, prefer 'project' for facts about the object and 'strategy' for material about one particular method.",
        },
        why: { type: 'string', description: 'One sentence: why this is worth keeping. Shown to the user.' },
      },
      required: ['title', 'content', 'docKind'],
    },
  },
  {
    name: 'set_intent',
    description: 'Update the repair intent (summary text and/or axis values). Use this when the conversation reveals new priorities the user has — e.g. they mention sustainability matters more than they originally said. Pass only the fields that change.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Plain-text summary of the repair philosophy/goal' },
        axes: {
          type: 'array',
          description: 'Optional updated axes. Provide id + value for each axis to update.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'number', description: '0..1 — how strongly this axis is prioritized' }
            },
            required: ['id', 'value']
          }
        }
      }
    }
  },
  {
    name: 'propose_intent_axis',
    description:
      'Propose a NEW evaluation criterion for this strategy — a dimension the participant '
      + 'has not yet named, which the material or the conversation suggests matters. It is '
      + 'added to the radar UNWEIGHTED: it carries no importance until the participant drags '
      + 'its handle, and until they do it influences nothing you generate. '
      + 'You cannot set its weight, and there is no tool that can — only they decide how much '
      + 'a criterion matters. Say plainly that you have put it on the radar for them to weigh. '
      + 'Use this sparingly, when a document or their own words reveal a criterion the current '
      + 'axes cannot express — not to restate one that already exists in different words.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short criterion name, 1-3 words, as it will read on the radar' },
        description: { type: 'string', description: 'One sentence: what weighing this axis high would commit the repair to' },
        rationale: { type: 'string', description: 'Why you are proposing it now — what in the material or the conversation prompted it' },
        sourceRefs: {
          type: 'array',
          description: 'Corpus document ids that motivated it, if any. Omit if it came from the conversation rather than a document.',
          items: { type: 'string' }
        }
      },
      required: ['label', 'rationale']
    }
  },
  {
    name: 'set_constraints',
    description: 'Update the practical constraints (tools available, materials, time budget, skill level, etc.).',
    parameters: {
      type: 'object',
      properties: {
        tools_available: { type: 'string' },
        materials_available: { type: 'string' },
        time_budget_minutes: { type: 'number' },
        budget_limit: { type: 'string' },
        skill_level: { type: 'string' },
        safety_level: { type: 'string' },
        allowed_operations: { type: 'string' },
        avoid_operations: { type: 'string' },
        additional_constraints: { type: 'string' }
      }
    }
  },
  {
    name: 'create_plan',
    description: 'Create a new repair plan ("strategy") with a list of steps. The plan becomes the current plan. This is the workhorse for generating strategies. Always include concrete steps — never an empty plan.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name for the strategy (e.g. "Conservative restoration", "Adaptive reuse as side-table")' },
        steps: {
          type: 'array',
          description: 'List of repair steps in execution order. Each step is a coherent atomic action.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique snake_case id (e.g. "clean_surfaces", "sand_finish")' },
              title: { type: 'string', description: 'Short action title, max 5 words' },
              description: { type: 'string', description: 'Detailed handwerklich/procedural description of the action — specific enough that someone could execute it. Include wait times for curing/drying.' },
              affectedPartRefs: { type: 'array', items: { type: 'string' }, description: 'IDs of parts this step touches' },
              addressesConditionRefs: { type: 'array', items: { type: 'string' }, description: 'IDs of conditions this step addresses' },
              toolsRequired: { type: 'array', items: { type: 'string' } },
              materialsRequired: { type: 'array', items: { type: 'string' } },
              estimatedMinutes: { type: 'number' }
            },
            required: ['id', 'title', 'description']
          }
        },
        edges: {
          type: 'array',
          description: 'Prerequisite ordering. Each edge: source must complete before target.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Step id that comes first' },
              target: { type: 'string', description: 'Step id that depends on source' }
            },
            required: ['source', 'target']
          }
        },
        mutexGroups: {
          type: 'array',
          description: 'Groups of mutually-exclusive alternative steps (user picks one).',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              stepIds: { type: 'array', items: { type: 'string' } }
            },
            required: ['stepIds']
          }
        }
      },
      required: ['label', 'steps']
    }
  },
  {
    name: 'add_step',
    description: 'Add a single step to the current plan. CRITICAL: when adding to a plan that already has steps, you MUST specify either afterStepId or beforeStepId (or both) so the new step is wired into the execution chain. Orphan steps with no edges are not useful and confuse the user. Look at the current plan\'s existing edges and steps before deciding placement. If you need to add MULTIPLE related steps in one turn and want to wire edges between them, prefer to chain via afterStepId on each subsequent add_step call rather than calling add_edge separately — the server assigns each new step a fresh id you cannot predict.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        affectedPartRefs: { type: 'array', items: { type: 'string' } },
        addressesConditionRefs: { type: 'array', items: { type: 'string' } },
        toolsRequired: { type: 'array', items: { type: 'string' } },
        materialsRequired: { type: 'array', items: { type: 'string' } },
        estimatedMinutes: { type: 'number' },
        afterStepId: { type: 'string', description: 'Step id (or title) this new step must come AFTER. Adds an edge automatically. Strongly recommended when there is an existing chain.' },
        beforeStepId: { type: 'string', description: 'Step id (or title) this new step must come BEFORE. Adds an edge automatically.' }
      },
      required: ['title', 'description']
    }
  },
  {
    name: 'update_step',
    description: 'Modify fields of an existing step in the current plan. Only fields in patch are changed.',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            affectedPartRefs: { type: 'array', items: { type: 'string' } },
            addressesConditionRefs: { type: 'array', items: { type: 'string' } },
            toolsRequired: { type: 'array', items: { type: 'string' } },
            materialsRequired: { type: 'array', items: { type: 'string' } },
            estimatedMinutes: { type: 'number' }
          }
        }
      },
      required: ['stepId', 'patch']
    }
  },
  {
    name: 'remove_step',
    description: 'Remove a step from the current plan.',
    parameters: {
      type: 'object',
      properties: { stepId: { type: 'string' } },
      required: ['stepId']
    }
  },
  {
    name: 'add_edge',
    description: 'Add a prerequisite edge between two EXISTING steps in the current plan: source must finish before target can start. Pass exact step ids — not titles, not slugs. Only use this for connecting steps that already exist in the workspace. When you have just created a step via add_step in the same turn and want to wire it in, use add_step\'s afterStepId/beforeStepId parameters instead — the server assigns fresh ids that you cannot predict before the call returns.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Exact id of an existing step (e.g. "clean_parts" or "step_mp9abc..."). The step title is accepted as a fallback but ids are preferred.' },
        target: { type: 'string', description: 'Exact id of an existing step that depends on source.' }
      },
      required: ['source', 'target']
    }
  },
  {
    name: 'remove_edge',
    description: 'Remove a prerequisite edge by id.',
    parameters: {
      type: 'object',
      properties: { edgeId: { type: 'string' } },
      required: ['edgeId']
    }
  },
  {
    name: 'set_active_plan',
    description: 'Switch which plan is the currently-active "strategy". Use this when the user wants to compare or pivot between strategies.',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId']
    }
  },
  {
    name: 'update_plan',
    description: 'Update plan-level metadata: rename a plan, change its status. When you change a step inside a plan such that the plan name no longer fits (e.g. user changed "yellow" to "blue", and the plan was named "Yellow Finish Strategy"), call this to also rename the plan. Use update_step for step-level changes.',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'New short name for the strategy' },
            status: { type: 'string', enum: ['draft', 'active', 'archived'], description: 'New status' }
          }
        }
      },
      required: ['planId', 'patch']
    }
  },
  {
    name: 'remove_plan',
    description: 'Delete a plan/strategy entirely.',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId']
    }
  },
  {
    name: 'propose_options',
    description: 'Attach tappable short-answer options to your reply, so the user can click instead of typing. Use ONLY when your reply ends with a discrete choice between 2-4 alternatives — e.g. "preservation, light restoration, or full restoration?", "hardwax oil or satin varnish?", "go top-to-bottom, or flesh out one phase first?". Do NOT use for open-ended questions ("what are you trying to achieve here?"), for yes/no questions (already trivial to type), or when your reply isn\'t ending with a question. The user can also still type a free answer; the buttons are just a shortcut. Call this AFTER any workspace-changing tools in the same turn, so the buttons appear under the final reply.',
    parameters: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          description: '2 to 4 short labels (2-6 words each). Each label is what the user sees on the button AND what gets sent as their next message when they tap.',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4
        }
      },
      required: ['options']
    }
  }
];
