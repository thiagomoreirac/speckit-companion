# Changelog — SpecKit Companion for the GitHub Copilot app

Changes to the **Copilot app canvas** are listed here. It is versioned on its own in `package.json`; the VS Code extension's changelog is at the repo root: [`../../CHANGELOG.md`](../../CHANGELOG.md).

## [Unreleased]

### Added

- **Converge from the board.** Check an implemented or completed spec against its code. <!-- area: copilot-app -->
- **Run commands with the right context.** Clarify a spec, check a plan, or analyze tasks, and give **Plan**, **Tasks**, and **Implement** scoped, accepted decisions.
- **See and review evidence in tabs.** Preview artifacts, see review status, generate missing evidence, and compare the exact revisions you choose to keep.
- **Build and set up workflows.** Edit nodes and hooks, inspect catalogs, and review hook effects before installing extensions, presets, workflows, or bundles.
- **Preview delivery before creating issues.** Check the destination repository, tasks and delivery owner before sending a GitHub issue request.
- **Carry product ideas into delivery.** Triage bugs and ideas in Companion, derive epics from plans, and review updates before applying them to existing work.
- **Prepare recurring routines.** Draft schedules for commands, agents, GitHub Actions, and Copilot Automations, then review setup with the scheduler that owns them.
- **Hand off dedicated cloud work.** Start from an exact published spec, bug, or Ready idea without changing the session that owns your board.

### Fixed

- **Keep commands in the selected session.** Child dispatch uses session management and never falls back to the parent chat. <!-- area: copilot-app -->
- **Stop on invalid settings or unavailable workflows.** The board shows the problem instead of dispatching with stock defaults. <!-- area: copilot-app -->
- **Follow or pin a worktree.** Follow the session's working directory, choose a checkout, or keep a coordinated child's worktree selected. <!-- area: copilot-app -->

## [0.2.2] - 2026-11-12

### Fixed

- **No made-up recent time on a fresh checkout.** A spec with a run record but no activity shows ==no time== instead of the checkout's file time. ([#1003](https://github.com/alfredoperez/speckit-companion/pull/1003)) <!-- area: copilot-app -->

## [0.2.1] - 2026-11-08

### Fixed

- **New spec keeps a project's timestamp numbering.** The board reads the `feature_numbering` setting newer Spec Kit writes, so the agent gets no sequential folder number. <!-- area: copilot-app -->

## [0.2.0] - 2026-10-13

The board installs as a plugin from this repo, and its buttons run their own steps on every model.

### Changed

- **The board is now packaged as a plugin.** Its files moved one level down, into `com.github.copilot/extensions/speckit-companion/`, so the Copilot app marketplace can install it ==straight from this repo==. ([#918](https://github.com/alfredoperez/speckit-companion/pull/918)) <!-- area: copilot-app -->

### Fixed

- **A button's command runs its own steps on every model.** New spec and the run buttons name the file that holds the command's steps, so an agent that never loaded the command ==reads them before it writes==. ([#913](https://github.com/alfredoperez/speckit-companion/pull/913)) <!-- area: copilot-app; issue: 817 -->
- **Plan cards work on the board.** A `states` block is drawn as a diagram where a click shows that state, and the buttons that did nothing are gone. ([#911](https://github.com/alfredoperez/speckit-companion/pull/911)) <!-- area: copilot-app -->
- **The board unlocks the next step.** A step the agent wrote the document for but never closed in the run record is closed when the turn ends. ([#881](https://github.com/alfredoperez/speckit-companion/pull/881)) <!-- area: copilot-app -->

## [0.1.0] - 2026-09-30

First version.

### Highlights

#### A spec board for the GitHub Copilot app
Open the SpecKit Companion canvas beside the chat to see every spec with its pipeline, task progress and the same Overview the VS Code viewer shows, updating live as the agent works. Buttons run the next step, and New spec asks for a workflow (Companion, Spec Kit or Auto) the way VS Code does. Opening the board tells the agent to wait for your next instruction instead of starting work.
<!-- area: copilot-app; pr: 787 -->
