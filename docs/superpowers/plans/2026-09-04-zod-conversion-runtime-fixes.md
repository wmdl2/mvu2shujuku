# Zod Conversion Runtime Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the Zod card save verification reliable, remove non-prefixed pure MVU world-book pipelines, and recover a foreign database checkpoint only in a pristine new chat.

**Architecture:** Keep the converter's conservative content classification, but add explicit detection for dedicated Chinese rule/protocol entries. Extend the shared initialization helper with a narrowly-scoped pristine-chat recovery flag, then make the extension treat a replaced foreign checkpoint as a new initialization rather than historical state. The generated root extension remains a build artifact of `src/mvu2shujuku.js`.

**Tech Stack:** JavaScript, Node.js built-in test harness, generated SillyTavern extension bundle.

**Spec:** User-approved design in the 2026-09-04 conversation: delete pure migrated MVU entries in the converted copy, do not use `if (false)`, and never reset a progressed chat.

## Global Constraints

- Read local MVU/SP reference snapshots before relying on upstream behavior.
- Preserve the original PNG and all existing chat files.
- A foreign checkpoint may be replaced only when the chat has one assistant opening floor and no user floor.
- Existing or progressed chats must retain their persistent database state.
- Do not commit automatically; leave changes reviewable in the current worktree.

---

### Task 1: Save-verification clone scope

**Files:**
- Modify: `test/run-tests.js`
- Modify: `src/mvu2shujuku.js`

**Interfaces:**
- Consumes: generated extension UI save flow.
- Produces: save verification writes a detached `tavern_helper` value without referencing a core-private identifier.

- [x] **Step 1: Write a failing generated-extension test** that executes the save flow far enough to call `writeExtensionField` and observes no `deepClone` reference error.
- [x] **Step 2: Run the focused test and confirm it fails with `deepClone is not defined`.**
- [x] **Step 3: Add a UI-local JSON-safe clone and use it for the official field write.**
- [x] **Step 4: Re-run the focused test and confirm the detached value is written successfully.**

### Task 2: Non-prefixed pure MVU world-book entries

**Files:**
- Modify: `test/run-tests.js`
- Modify: `src/mvu2shujuku.js`

**Interfaces:**
- Consumes: world-book entry comment/content and already parsed update rules.
- Produces: converted entries omit dedicated `变量更新规则` and `变量处理指令集` pipelines while retaining mixed narrative/EJS entries.

- [x] **Step 1: Write failing conversion tests** with literal dedicated rule, output-protocol, and mixed narrative fixtures.
- [x] **Step 2: Run the focused tests and confirm dedicated entries remain unexpectedly.**
- [x] **Step 3: Add conservative comment/content classification for dedicated Chinese rule and protocol entries.**
- [x] **Step 4: Re-run the focused tests and confirm only pure migrated entries are removed.**

### Task 3: Pristine-chat foreign checkpoint recovery

**Files:**
- Modify: `test/run-tests.js`
- Modify: `src/mvu2shujuku.js`

**Interfaces:**
- Consumes: current chat floors, checkpoint presence, expected template table names, and runtime table names.
- Produces: `mvu2shujukuEnsureInit(...).replacedFreshForeignCheckpoint` and effective historical-checkpoint handling in the extension.

- [x] **Step 1: Write failing integration tests** proving a foreign checkpoint is replaced in a one-floor assistant-only chat and preserved after a user floor exists.
- [x] **Step 2: Run the focused tests and confirm the pristine-chat case incorrectly skips initialization.**
- [x] **Step 3: Add a shared pristine-opening predicate and allow initialization only for a checkpoint whose runtime is missing expected tables.**
- [x] **Step 4: Treat a replaced foreign checkpoint as newly initialized for greeting baselines and continuity.**
- [x] **Step 5: Re-run the focused tests and confirm both the recovery and non-destructive guard.**

### Task 4: Actual-card regression, release metadata, and build

**Files:**
- Modify: `test/run-tests.js`
- Modify: `README.md`
- Modify: `COMPATIBILITY.md`
- Modify: `CHANGELOG.md`
- Modify: `manifest.json`
- Generate: `index.js`

**Interfaces:**
- Consumes: `/mnt/e/Download/MVU_Zod-.png` when present.
- Produces: version 0.3.7 installable extension and documented recovery behavior.

- [x] **Step 1: Add an optional actual-card regression** that verifies the two pure protocol entries are absent, the mixed master EJS entry remains, and a representative JSONPatch parses.
- [x] **Step 2: Run the actual-card/focused tests before implementation changes where applicable, then after all fixes.**
- [x] **Step 3: Update user-facing compatibility and changelog notes plus manifest version 0.3.7.**
- [x] **Step 4: Run `node build-extension.js` and syntax-check the generated bundle.**
- [x] **Step 5: Run `node test/run-tests.js` and inspect the final diff.**
