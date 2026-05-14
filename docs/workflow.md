# Workflow

The paper describes three coupled phases: Knowledge Generation, Design and Action Generation, Situated Guidance and Feedback. v2 keeps that structure but makes the boundaries between phases more permeable: you can return to phase 1 from phase 3 when hidden damage is revealed during execution.

## Phase 1 · Knowledge generation

**Entity work:** load or generate the `instance` (parts + connections + spatial graph), gather `evidence` (photos, measurements, notes), register `hypotheses` for what might be wrong.

Hypotheses start as `suspected`. Confirming a hypothesis requires attaching evidence — a confirmation photo, an exposed condition observed during disassembly, a measurement that matches. Refuting is also recorded: "I expected rot, found none" is preserved as a finding, not deleted.

A hypothesis with no evidence and `confidence < 0.5` is a question to investigate, not a damage to plan around.

**AI calls used:** `POST /api/propose` with `scope: "assembly"` to extract the part list from images; `scope: "hypotheses"` to catalogue suspected conditions. `POST /api/chat` for asking questions about what you're seeing.

## Phase 2 · Design and action generation

**Entity work:** set the `intent` (radar of competing values + summary archetype), set `constraints` (tools, materials, time, budget, skill), generate one or more `plans`.

A plan is a directed graph of `steps`, connected by `edges` of three kinds (`prerequisite`, `alternative-to`, `enables`), grouped into `mutexGroups` where the user must pick one approach.

Every step carries a `justification` linking it back to the driving intent axes, the driving hypotheses, and the constraints that shaped it. Selecting a step in the UI shows that trace. Adjusting the intent and regenerating shows a diff against the previous plan — not a from-scratch replacement.

**AI calls used:** `POST /api/propose` with `scope: "interventions"` for the plan. The propose endpoint always returns commands the user can review and accept (or reject) — it never mutates the workspace directly.

## Phase 3 · Situated guidance and feedback

**Entity work:** mark steps `in-progress` and `completed`, write `executionLog` entries that record actual duration, deviation from plan, rationale, and the evidence captured during work.

Crucially: phase 3 can spawn phase 1 work. During disassembly, a new condition becomes visible → add a new `hypothesis`, optionally attach a confirmation photo as `evidence`, optionally trigger replan. The plan that produced the original step keeps its history; the new plan version references the parent.

**AI calls used:** `POST /api/chat` scoped to the current step is the main one. `POST /api/propose` with `scope: "interventions"` and a reference to the existing plan triggers a replan that diff-patches rather than replaces.

## What's deliberately not a phase

There is no "approval phase" yet. Plans have a `status` field with `proposed | approved` values, but the UI for sign-off is deferred to v1.1. For the workshop, all plans are `draft`.

There is no "knowledge persistence" phase. The paper's conclusion talks about repair feeding back into a long-term knowledge structure for future maintenance. Exporting workspace JSON is the v1.0 version of that. The repair-pattern library (the RAG layer) is the v2.0 version.
