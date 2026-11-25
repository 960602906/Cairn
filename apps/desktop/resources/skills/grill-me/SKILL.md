---
name: grill-me
description: Interview the user one question at a time to stress-test a plan, design or decision before any code is written. Use when the user asks to be grilled, wants an idea challenged, or asks you to poke holes in a plan.
---

# Grill me

Goal: reach a shared, explicit understanding of the user's plan by walking every branch of its decision tree, then hand back a short agreed spec.

## Rules

- Do not write or edit code, and do not run commands that change anything, until the user ends the session or approves the spec.
- Ask exactly one question per message, then wait for the answer.
- With every question, give your recommended answer and a one-line reason, so the user can simply agree.
- If the project can answer a question (code, configuration, docs, git history), look it up yourself instead of asking. Say what you found and ask only about what is still unclear.
- Settle the decisions other decisions depend on first; details come after.
- Do not accept vague answers such as "it should be fast" or "handle errors properly": ask for the concrete number, case or behaviour.
- Point out risks, edge cases and contradictions with earlier answers as soon as you notice them.
- Keep a running list of decisions. Do not reopen a settled decision unless a later answer contradicts it.
- Reply in the user's language.

## Flow

1. Restate the goal in one or two sentences, list the open branches you see, and ask the first question.
2. Continue one question at a time. When a branch is settled, say so in one line and move on.
3. Stop when every branch is settled or the user says to stop.
4. Write the agreed spec: goal; decisions, each with its reason; in scope and out of scope; edge cases and how they are handled; remaining open questions; suggested next steps. Then ask whether to save it to a file (for example `docs/plan/<topic>.md`) or to start implementing.
