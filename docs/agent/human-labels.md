# Human Ground-Truth Labels For The Follow-Up Adviser

Status: tooling only. No labels exist yet, and none were produced by this module. The earlier comparison (`followup-adviser-comparison-2026-10-08.md`) and the prompt profile record (`followup-prompt-profile-2026-10-08.md`) both say the fixture is a blunt stand-in and agreement with it is not accuracy. This module is how that gap gets closed: the owner labels the inputs, and saved model results are scored against those labels.

## Who decides

The labels are the owner's judgement under the owner's own policy. Whether that policy is compliance-first, convenience-first or something else changes which actions are defensible, so the policy is stated by the owner in the label file itself (the `POLICY:` line of a sheet, or the first prompt of the interactive session). The tools never write, suggest, default or derive a label, a preferred action or a policy. A label file without a policy statement is refused by the scorer. Nothing in these scripts calls a model or the network.

## The inputs

The adviser sees five fields: `taskAlias`, `snapshotVersion`, `timeCode`, `nudgeCount`, `pickupCode`. The label sheet shows exactly that projection with the same fixed placeholder `taskAlias` the benchmark scripts use.

- `timeCode` x4: `WINDOW_FULL`, `WINDOW_MOST`, `WINDOW_LITTLE`, `WINDOW_LAST`.
- `pickupCode` x3: `PICKUP_NONE`, `PICKUP_SOME`, `PICKUP_ALL`.
- `nudgeCount` 0 to `MAX_NUDGES` (2).

That is 36 combinations. The 12 with `PICKUP_ALL` are unreachable: the worker never asks the adviser when everything has been collected, and the validator accepts only WAIT there. They are not on the sheet, not asked in the interactive session, and not scored. The remaining 24 are the labelled set.

The code lists are read from `delivery-followup.js` rather than typed again. `TIME_CODES` and `PICKUP_CODES` are not exported there, so `scripts/label-followup.mjs` reads the two array literals from that file and checks every value against the exported `ADVICE_KINDS.followup.accepts` gate; if either constant is renamed or changes shape the script fails on import instead of labelling a stale grid. Exporting the constants would remove that step (not done here: this module owns no other file).

## Label semantics

For each input the owner gives:

- the set of ALL acceptable actions among `WAIT`, `REMIND`, `ESCALATE` (a set, because more than one action can be defensible), and
- the single preferred action, which must be inside that set, and
- an optional free-text note.

Spelling, case, order and repeats inside the set do not matter. Commas, spaces, semicolons, slashes and pipes separate actions.

## Making labels

Sheet (plain Markdown or CSV, chosen by the file extension; refuses to overwrite):

```bash
node scripts/label-followup.mjs --sheet labels-sheet.md
node scripts/label-followup.mjs --sheet labels-sheet.csv
```

Fill in the `POLICY:` line (Markdown) or the `# POLICY:` line (CSV) and, per row, `acceptable_actions`, `preferred_action` and `note`. Rows are matched by `timeCode`, `pickupCode` and `nudgeCount`, not by position. In the Markdown sheet avoid the pipe character in notes (a pipe in the last column is tolerated and rejoined, but other columns must not contain one).

Interactive terminal session (needs a TTY on stdin; it fails with an explanatory error otherwise, and writes nothing):

```bash
node scripts/label-followup.mjs --interactive --labels-out labels.json
node scripts/label-followup.mjs --interactive --labels-out labels.json --resume
```

The session asks for the policy statement first, then walks the 24 inputs. Per input: the acceptable set, then the preferred action (always asked, even when the set has one member), then a note. Enter at the first question skips an input (it stays unlabelled and is asked again on resume); `q` saves and quits. The labels file is created with exclusive creation (an existing file is refused; use `--resume`), and after every answer it is rewritten atomically (temporary sibling file, then rename), so an interrupted session loses nothing already answered. If input ends early the exit code is 3 and progress is kept.

## Scoring

```bash
node scripts/score-labels.mjs --labels labels.json --results a.json b.json [--out report.md]
```

`--labels` accepts the interactive JSON file or a filled sheet (`.md`, `.csv`). `--out` is written exclusively (an existing file is refused); without it the report goes to stdout.

The scorer refuses to score, exit code 2 and nothing written, unless the policy statement is non-empty and all 24 inputs have a complete label (a non-empty acceptable set, one valid preferred action inside it). Every problem is listed.

Result files are the saved JSON of the earlier experiments and of `scripts/bench-adviser.mjs --out`. Supported shapes; extra fields are ignored:

| Shape | Sources produced |
| --- | --- |
| rows with `model` (`followup-compare-<time>.json`) | one |
| rows with `local4b` and `cloud120b` (`followup-compare-cloud-<time>.json`) | two |
| rows with `variant` and `model` (`followup-prompt-variants-<time>.json`) | one per variant |
| rows with `outlets.<name>` (`bench-adviser/1`, `bench-*.json`) | one per outlet |

An answer is `"ACTION/REASON"`. `null`, a missing column, a refused `outlets` entry, and a row marked `accepted: false` (for `model` and `cloud120b`) are no usable answer. The `fixture` column of a result file is not a source; the fixture source is computed from the current `syntheticFollowupAdvice`, and a file whose fixture column differs is reported in a warning. Fixture-only files (no model column) and the reasoning experiment (`followup-reasoning-*.json`, which has named cases and no grid fields) are refused with a reason. `PICKUP_ALL` rows are ignored and counted in a warning.

Per source the report gives, out of the 24 reachable inputs:

- acceptable (answer inside the acceptable set), and acceptable of answered,
- preferred (answer equals the preferred action),
- over-action (stronger than every acceptable action, order `WAIT < REMIND < ESCALATE`),
- under-action (weaker than every acceptable action),
- between (not in the set, but neither stronger nor weaker than all of it, for example REMIND against `{WAIT, ESCALATE}`),
- no answer (refused, missing or null: not acceptable, and neither over nor under),
- a table of the rows where the source is not inside the acceptable set.

The report also quotes the owner's policy statement, states that the 12 `PICKUP_ALL` inputs are excluded and unreachable, and warns when a label names REMIND at `nudgeCount` 2 (production fixed code refuses REMIND there, so no source can take effect with it).

## Limits

- 24 inputs, one owner, one policy, and one run per source in the saved files. Rates are descriptive, not statistical, and a second labeller would likely differ on the defensible-set boundaries.
- The result files are synthetic-grid benchmarks. Scoring them says how a source behaves on this grid under the owner's policy, not how it behaves on real deliveries.
- The result files live in the git-ignored `output/experiments/` of the original checkout and are read only; the tests use small synthetic copies of the formats, not the real files.
- The scorer trusts the `accepted` flags and action text in the files; it does not re-run any model or the validator.

## Tests

```bash
node --test scripts/label-followup.test.mjs scripts/score-labels.test.mjs
```
