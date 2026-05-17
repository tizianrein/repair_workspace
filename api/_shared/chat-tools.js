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
    description: 'Register a new observed condition (damage/defect/feature) on a specific artefact part. Use one call per affected part — never collapse multiple parts into one call.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Short label for the condition type (e.g. "Crack", "Weathering", "Loose joint")' },
        description: { type: 'string', description: 'Concise description of what was observed' },
        partRef: { type: 'string', description: 'ID of the affected part' },
        status: { type: 'string', enum: ['suspected', 'confirmed', 'refuted'], description: 'Confidence status. Default "suspected" unless the user has clear visual confirmation.' },
        confidence: { type: 'number', description: 'Confidence 0..1. Default 0.7.' }
      },
      required: ['type', 'description', 'partRef']
    }
  },
  {
    name: 'remove_condition',
    description: 'Remove a condition by its id.',
    parameters: {
      type: 'object',
      properties: { hypothesisId: { type: 'string' } },
      required: ['hypothesisId']
    }
  },
  {
    name: 'update_condition',
    description: 'Update fields of an existing condition. Only the fields in patch are changed.',
    parameters: {
      type: 'object',
      properties: {
        hypothesisId: { type: 'string' },
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
      required: ['hypothesisId', 'patch']
    }
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
              addressesHypothesisRefs: { type: 'array', items: { type: 'string' }, description: 'IDs of conditions this step addresses' },
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
    description: 'Add a single step to the current plan, optionally between existing steps. Use this for small edits to an existing plan rather than recreating it.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        affectedPartRefs: { type: 'array', items: { type: 'string' } },
        addressesHypothesisRefs: { type: 'array', items: { type: 'string' } },
        toolsRequired: { type: 'array', items: { type: 'string' } },
        materialsRequired: { type: 'array', items: { type: 'string' } },
        estimatedMinutes: { type: 'number' },
        afterStepId: { type: 'string', description: 'Optional: place this step after this one (adds an edge)' },
        beforeStepId: { type: 'string', description: 'Optional: place this step before this one (adds an edge)' }
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
            addressesHypothesisRefs: { type: 'array', items: { type: 'string' } },
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
    description: 'Add a prerequisite edge between two steps: source must finish before target can start.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        target: { type: 'string' }
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
    name: 'remove_plan',
    description: 'Delete a plan/strategy entirely.',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId']
    }
  }
];
