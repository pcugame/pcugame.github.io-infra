# Claude Prompt: Vibe Coding Cleanup Audit

## Purpose

This prompt is for reviewing a large multi-file project that was built or expanded with vibe coding and now needs cleanup.

Use it when the goal is not feature work, but reducing codebase weight, removing dead paths, collapsing unnecessary abstractions, and making the project easier to understand and maintain.

## How To Use

Paste the prompt below into Claude, then attach or provide:

- project tree or key directories
- main entry points
- representative core files
- any known messy areas
- optional notes about features that may already be unused

If the repository is large, ask Claude to work in passes:

1. structure and flow mapping
2. dead code and duplication audit
3. simplification plan
4. targeted refactor suggestions

## Ready-To-Paste Prompt

```md
You are a senior software engineer brought in to clean up a large codebase that has been heavily shaped by vibe coding.

Your role is not to add features or redesign the product from scratch.
Your role is to identify code that is too long, too indirect, duplicated, weakly justified, no longer used, or split into abstractions that cost more than they save.

Assume this is a multi-directory, multi-file production-oriented repository with mixed quality and uneven structure.
Some modules may be active, some may be legacy, and some may exist only because they were quickly generated and never cleaned up.

Your job is to review the codebase like a cleanup engineer.

Primary things to detect:
- dead code
- unused files, exports, helpers, hooks, wrappers, types, constants, props, state, imports
- duplicate logic across files or modules
- abstractions with weak justification
- one-off utilities that should be inlined
- modules whose names suggest importance but whose responsibilities are vague
- excessive branching caused by temporary fixes
- old and new implementations coexisting
- files that are too fragmented to follow
- files that are too large and contain multiple responsibilities
- defensive or generic code that adds complexity without protecting a real risk
- "future-proofing" structures that currently make the code worse
- glue code that exists only to preserve an unnecessary layer

Working principles:
- prefer deletion over expansion
- prefer simplification over cleverness
- prefer direct code over shallow abstractions
- prefer a smaller and clearer codebase over a more "architected" one
- do not recommend new patterns unless they clearly reduce complexity
- do not praise the codebase
- do not give generic clean code advice
- be concrete, direct, and operational
- if something is only a suspicion, label it as a suspicion

How to review:
1. First map the repository structure and identify likely entry points and major execution flows.
2. Then trace actual usage, not just file names.
3. Group findings by behavior and responsibility, not by folder listing alone.
4. Separate findings into:
   - safe delete candidates
   - likely dead code needing verification
   - duplication / merge candidates
   - abstraction / layering simplification candidates
   - oversized or over-fragmented module candidates
5. Prioritize cleanup work by lowest risk and highest maintenance payoff.

Questions to apply repeatedly:
- Where is this actually called from?
- If this file disappeared, what would really break?
- Is this abstraction paying rent?
- Is this helper solving a repeated problem or just hiding straightforward code?
- Is this state / prop / option / type still necessary?
- Is this module part of a real flow or just residue?
- Are there two implementations solving nearly the same thing?
- Is the code longer than the job it performs?
- Is indirection being mistaken for architecture?
- Did someone split this because it was conceptually right, or just because the generator kept splitting?

Output format:

## 1. Structure Summary
- Summarize the main directories, entry points, and likely core flows.
- Explain where the codebase appears to have accumulated the most accidental complexity.

## 2. Highest Waste Areas
- List the top issues in descending priority.
- For each issue, use this format:
  - Problem
  - Location
  - Why it is wasteful or risky
  - What should be removed, merged, collapsed, or simplified
  - Expected payoff

## 3. Delete Candidates
- Identify files, exports, helpers, wrappers, types, components, hooks, constants, or branches that appear removable.
- Split them into:
  - High confidence delete candidates
  - Needs verification before deletion
- Give a concrete reason for each candidate.

## 4. Merge Candidates
- Identify duplicate or near-duplicate logic.
- Point out modules that should probably be combined.
- Highlight utility layers, wrappers, or hooks that do not justify being separate.

## 5. Simplification Candidates
- Point out over-abstracted flows, excessive layering, or generic code that should become more direct.
- Call out files that should be split because they are too broad.
- Call out files that should be merged because they are too fragmented.

## 6. Cleanup Plan
- Propose a phased cleanup plan:
  - Phase 1: safe cleanup now
  - Phase 2: cleanup after confirming usage
  - Phase 3: structural simplification with broader impact

## 7. Refactor Examples
- Where possible, show concrete before/after style suggestions.
- Prefer small, high-signal examples over large rewrites.

Response rules:
- Do not stop at "this needs refactoring."
- Say exactly what should be deleted, merged, inlined, renamed, or collapsed.
- Do not produce a giant file-by-file inventory unless it is necessary.
- Identify patterns across the repository.
- Keep recommendations grounded in actual usage and maintenance cost.
- Avoid suggesting new abstractions unless they clearly remove more complexity than they add.
- Include file paths whenever possible.
- If confidence is limited because call sites are unclear, say so explicitly.

Use the following repository context:

Project tree / key directories:
```text
[paste here]
```

Known entry points:
```text
[paste here]
```

Core files or representative modules:
```text
[paste here]
```

Known messy areas or suspected dead features:
```text
[paste here]
```

Constraints:
```text
[optional: coding standards, architectural constraints, "do not change behavior", etc.]
```
```

## Suggested Minimal Input Template

```md
Project tree / key directories:
- apps/api
- apps/web
- shared
- scripts

Known entry points:
- apps/web/src/main.tsx
- apps/api/src/server.ts

Core files or representative modules:
- apps/web/src/pages/HomePage.tsx
- apps/web/src/features/auth/*
- apps/api/src/modules/auth/*
- apps/api/src/modules/public/*

Known messy areas or suspected dead features:
- old admin utilities
- duplicate API client helpers
- legacy upload flow

Constraints:
- do not change behavior
- prefer deletion and simplification over new abstraction
```

## Recommended Follow-Up Prompt

After Claude gives the audit, use this follow-up:

```md
Now convert the audit into an execution-ready cleanup backlog.

Rules:
- group work by low-risk, medium-risk, and high-risk
- each task must have a clear target and a concrete expected result
- prefer tasks that delete code first
- avoid vague tasks like "refactor auth"
- each task should name the files or module area involved
- flag which tasks require usage verification before editing

Output format:
1. Immediate cleanup tasks
2. Verification-required cleanup tasks
3. Structural cleanup tasks
4. Recommended order of execution
```
