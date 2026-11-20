# T015: viewer parity

The comparison uses the viewer feature's [merge commit](https://github.com/alfredoperez/speckit-companion/commit/688e4a18ca7bf934e7ca562c3859cd58e672a4e2) and its exact first parent, `0fdef53363dd338916c4366d5c4556bda9734ff8`, rather than the current branch. Both detached worktrees used their lockfiles, development webpack output, and their own static Storybook build.

## Bundle comparison

Run `node tooling/scripts/viewer-bundle-diff.mjs <before-dist> <after-dist>`. The exit code is `1` because the viewer bundle differs.

| Bundle | Normalized result |
|---|---|
| `spec-viewer.js` | 25,461 differing lines; development output grew from 572,524 to 955,222 bytes |
| `spec-editor.js` | Identical |
| `process-create.js` | Identical |
| `pipeline-builder.js` | Identical |

These are development build sizes, not a reproduction of the `+148 KB` recorded in the historical run. The two measurements should not be compared without matching build settings.

## Computed styles

Run `node tooling/scripts/viewer-style-diff.mjs <before-storybook> <before-dist> <after-dist> <after-storybook>` in headless Chrome. The runner compares computed styles and pseudo-elements in light and dark themes. It selects 263 historical stories; the final render count can be lower than 526 if a baseline story does not render.

The independent comparison partitioned all 263 eligible stories across eight invocations of the same runner using its `STORIES` filter. It compared **524 renders with zero computed-style differences**. The baseline `scenes-teamboard-run--ctx-specified` produced no rendered DOM in either theme: Storybook reported a missing component annotation in the default export. Its two renders were excluded; no parity claim is made for that story. A separate focused run covered the ActivityPanel stories `canonical`, `dossier-rich`, and `dossier-mid-pipeline` in both themes: six renders, zero differences.
