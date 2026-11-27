# Goal Bar Cursor-style Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the floating goal chrome a Cursor-like single-row strip (pause/resume, edit condition, delete) and add `goal.condition_updated` / `goal.updateCondition`.

**Architecture:** Event-sourced condition updates (no lifecycle entry, so in-flight judges keep their snapshotted condition). `GoalView` tracks `conditionUpdates` for rewind. UI collapses to one row; budget stays in `GoalPanel` only.

**Tech Stack:** TypeScript, Zod protocol events, session-view projection, Electron IPC, React + Vitest + Playwright e2e, i18n zh/en.

**Spec:** [docs/superpowers/specs/2026-11-27-goal-bar-redesign-design.md](../specs/2026-11-27-goal-bar-redesign-design.md)

## Global Constraints

- Do not show turn count or elapsed duration on the goal bar.
- Delete on the bar requires the same confirm dialog pattern as `GoalPanel`.
- Condition edit does not abort the current turn; applies to next turn / next judge.
- In-flight judge uses `PreparedEvaluation.goal` snapshot; `condition_updated` must not bump lifecycle seq.
- Reuse existing `goal.clear` for delete; same error-notice pattern as pause/resume.
- Leave unrelated WIP goal polish in the working tree intact unless it conflicts.

## File map

| File | Role |
|------|------|
| `packages/protocol/src/events.ts` | Add `goal.condition_updated` |
| `packages/protocol/src/contracts/renderer-main.ts` | Add `goal.updateCondition` |
| `packages/core/src/session-view.ts` | Project updates + rewind via `conditionUpdates` |
| `apps/desktop/src/main/services/session-manager.ts` | `updateGoalCondition` |
| `apps/desktop/src/main/services/renderer-gateway.ts` | Wire IPC |
| `apps/desktop/src/renderer/session-store.ts` | `updateGoalCondition` action |
| `apps/desktop/src/renderer/GoalBar.tsx` | Single-row UI + edit + delete |
| `apps/desktop/src/renderer/GoalPanel.tsx` | Edit condition control |
| `packages/i18n/locales/{zh-CN,en-US}/session.json` | Short status + edit/delete strings |
| `docs/plan/goal-mode.md`, ADR-0047, CHANGELOG | Doc sync |

---

### Task 1: Protocol event + IPC

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Modify: `packages/protocol/src/events.test.ts` (fixtures)
- Modify: `packages/protocol/src/contracts/renderer-main.ts`
- Test: `packages/protocol/src/events.test.ts`

- [ ] **Step 1: Add event schema** after `goal.resumed`:

```ts
'goal.condition_updated': z.object({
  goalId: Id,
  condition: z.string().trim().min(1).max(GOAL_CONDITION_MAX),
}),
```

- [ ] **Step 2: Add IPC** next to `goal.clear`:

```ts
'goal.updateCondition': {
  params: z.object({
    sessionId: Id,
    condition: z.string().trim().min(1).max(GOAL_CONDITION_MAX),
  }),
  result: z.object({}),
},
```

- [ ] **Step 3: Add fixture** in `events.test.ts` VALID payloads map; run protocol tests.

- [ ] **Step 4: Commit** `feat(protocol): goal.condition_updated + updateCondition`

---

### Task 2: Session projection

**Files:**
- Modify: `packages/core/src/session-view.ts` (`GoalView`, create, update, rewindGoal)
- Test: `packages/core/src/session-view.test.ts`

**Produces:** `GoalView.conditionUpdates: readonly { seq: number; condition: string }[]`

- [ ] **Step 1: Extend `GoalView`** with `conditionUpdates`. On `goal.created`, set `conditionUpdates: [{ seq: event.seq, condition }]`.
- [ ] **Step 2: Handle `goal.condition_updated`** — only `active`/`paused`; ignore ended / missing / identical condition; append update and set `condition`. Do **not** append lifecycle.
- [ ] **Step 3: `rewindGoal`** — filter `conditionUpdates` by `seq < fromSeq`; set `condition` to last remaining update’s condition (always ≥1 from create).
- [ ] **Step 4: Tests** — update active/paused; ignore ended; rewind restores prior condition.
- [ ] **Step 5: Commit** `feat(core): project goal.condition_updated`

---

### Task 3: Session manager + gateway + store

**Files:**
- Modify: `apps/desktop/src/main/services/session-manager.ts`
- Modify: `apps/desktop/src/main/services/renderer-gateway.ts` (+ test mock)
- Modify: `apps/desktop/src/renderer/session-store.ts`
- Test: `apps/desktop/src/main/services/session-manager.test.ts`, `renderer-gateway.test.ts`

- [ ] **Step 1: `updateGoalCondition`** under `withGoalLock`: require goal-capable; `openGoal`; if missing → `GoalNotFound`; if trimmed condition equals current → `{}` no event; else publish `goal.condition_updated`.
- [ ] **Step 2: Gateway** `endpoint.handle('goal.updateCondition', …)` + commands type.
- [ ] **Step 3: Store** `updateGoalCondition(sessionId, condition): Promise<GoalActionOutcome>` mirroring `pauseGoal`.
- [ ] **Step 4: Tests** for success, noop same text, not_found.
- [ ] **Step 5: Commit** `feat(desktop): goal.updateCondition IPC`

---

### Task 4: i18n short status + bar actions

**Files:**
- Modify: `packages/i18n/locales/zh-CN/session.json`, `en-US/session.json`
- Modify: `apps/desktop/src/renderer/goal-i18n.test.ts`

Keys (zh examples):
- `goal.bar.running` → `进行中` (drop turn interpolation)
- `goal.bar.paused` → `已暂停` (reason in `title` only)
- `goal.bar.pausedRunning` → `本轮结束后暂停`
- `goal.bar.edit`, `goal.bar.delete`, `goal.bar.saveCondition` (aria)
- Reuse panel clear-confirm keys on the bar dialog

- [ ] **Step 1: Update strings** both locales; fix any tests that assert old “第 N / M 轮” / “已暂停：…”.
- [ ] **Step 2: Commit** `i18n(session): shorten goal bar status copy`

---

### Task 5: GoalBar single-row UI

**Files:**
- Modify: `apps/desktop/src/renderer/GoalBar.tsx`
- Modify: `apps/desktop/src/renderer/GoalBar.test.tsx`

- [ ] **Step 1: Layout** — one row: icon, condition (or input), short status, IconButtons pause/resume / Pencil / Trash. Remove open-panel Target button; remove second-line status + duration. Soften card (`py-1.5`, lighter shadow or shared edge with composer).
- [ ] **Step 2: Edit mode** — Pencil → controlled input; Enter save via `updateGoalCondition`; Esc cancel; blur saves if dirty else exits; empty/overlong keep editing + error.
- [ ] **Step 3: Delete** — Trash opens Dialog like GoalPanel → `clearGoal`.
- [ ] **Step 4: Tests** — no turn/duration text; edit save/cancel; delete confirm; pause still works.
- [ ] **Step 5: Commit** `feat(ui): Cursor-style goal bar with edit and delete`

---

### Task 6: GoalPanel edit + docs + e2e

**Files:**
- Modify: `apps/desktop/src/renderer/GoalPanel.tsx` (+ test)
- Modify: `apps/desktop/e2e/goal-mode.spec.ts` if needed
- Modify: `docs/plan/goal-mode.md` §9.2, `docs/adr/0047-goal-mode.md`, `CHANGELOG.md`

- [ ] **Step 1: Panel** — edit control on condition (button or inline) calling `updateGoalCondition`.
- [ ] **Step 2: Docs** — bar is single-row; clear allowed on bar with confirm; no budget on bar; condition updatable.
- [ ] **Step 3: e2e** — assert bar delete and/or condition text update if cheap; else rely on unit tests.
- [ ] **Step 4: Commit** `docs: goal bar redesign + CHANGELOG`

---

## Self-review

- Spec §2.1 bar layout → Task 5  
- Spec §2.2 / §3 condition update → Tasks 1–3, 5–6  
- Spec delete on bar → Task 5  
- Spec no turns/duration on bar → Tasks 4–5  
- Spec judge snapshot → Task 2 (no lifecycle) + existing PreparedEvaluation  
- Spec i18n/docs/tests → Tasks 4–6  
