# Human Ground-Truth Labels For The Follow-Up Adviser

Status: tooling only. No labels exist yet, and none were produced by this module. The earlier comparison (`followup-adviser-comparison-2026-10-08.md`) and the prompt profile record (`followup-prompt-profile-2026-10-08.md`) both say the fixture is a blunt stand-in and agreement with it is not accuracy. This module is how that gap gets closed: the owner labels the inputs, and saved model results are scored against those labels.

## Who decides

The labels are the owner's judgement under the owner's own policy. Whether that policy is compliance-first, convenience-first or something else changes which actions are defensible, so the policy is stated by the owner in the label file itself (the `POLICY:` line of a sheet, or the first prompt of the interactive session). The tools never write, suggest, default or derive a label, a preferred action or a policy. A label file without a policy statement is refused by the scorer, and a statement counts only when it holds at least one letter or digit (any script): `-`, `.`, a zero-width character or a row of commas left by a spreadsheet is no policy. Nothing in these scripts calls a model or the network.

## The inputs

The adviser sees five fields: `taskAlias`, `snapshotVersion`, `timeCode`, `nudgeCount`, `pickupCode`. The label sheet shows exactly that projection with the same fixed placeholder `taskAlias` the benchmark scripts use.

- `timeCode` x4: `WINDOW_FULL`, `WINDOW_MOST`, `WINDOW_LITTLE`, `WINDOW_LAST`.
- `pickupCode` x3: `PICKUP_NONE`, `PICKUP_SOME`, `PICKUP_ALL`.
- `nudgeCount` 0 to `MAX_NUDGES` (2).

That is 36 combinations. The 12 with `PICKUP_ALL` are unreachable: the worker never asks the adviser when everything has been collected, and the validator accepts only WAIT there. They are not on the sheet, not asked in the interactive session, and not scored. The remaining 24 are the labelled set.

The code lists are imported from `delivery-followup.js` (`TIME_CODES` and `PICKUP_CODES` are exported there) rather than typed again, and `scripts/label-followup.mjs` checks every combination against the exported `ADVICE_KINDS.followup.accepts` gate; if either constant changes shape the script fails on import instead of labelling a stale grid.

## Label semantics

For each input the owner gives:

- the set of ALL acceptable actions among `WAIT`, `REMIND`, `ESCALATE` (a set, because more than one action can be defensible), and
- the single preferred action, which must be inside that set, and
- an optional free-text note.

Case and order inside the set do not matter. Commas, spaces, semicolons and slashes (ASCII only) separate actions; in a Markdown sheet use comma, space or slash. The pipe is not a separator: in a Markdown table it splits the cell. Each word must be plain ASCII letters (`WAIT`, `REMIND`, `ESCALATE`): lookalike letters (a dotless i, a long s, Cyrillic or full-width letters), zero-width characters and no-break spaces are refused, not folded into an action. An action listed twice (`WAIT, WAIT`) is refused rather than counted once, so a slip is visible. In the JSON file `timeCode` and `pickupCode` must be strings and `nudgeCount` an integer; nothing is converted (`"0"`, `[0]` and `["WINDOW_FULL"]` are not accepted).

## Making labels

Sheet (plain Markdown or CSV, chosen by the file extension; refuses to overwrite):

```bash
node scripts/label-followup.mjs --sheet labels-sheet.md
node scripts/label-followup.mjs --sheet labels-sheet.csv
```

Fill in the `POLICY:` line (Markdown) or the `# POLICY:` line (CSV) and, per row, `acceptable_actions`, `preferred_action` and `note`. Rows are matched by `timeCode`, `pickupCode` and `nudgeCount`, not by position.

- Markdown sheet: every row must have exactly as many cells as the header; a row with more or fewer cells is refused and listed (it is not repaired), because a stray pipe shifts every later cell and could turn a half-written row into a complete label. To put a pipe in a note write `\|`.
- CSV sheet: the file is parsed as CSV first. `# ...` comment lines and the `# POLICY:` line count only before the header row, as raw lines (a spreadsheet application may instead quote them and pad them with trailing commas; both are read, and the padding commas are not part of the policy). After the header row nothing is a comment: a line inside a quoted note, even one that starts with `#` or `# POLICY:`, is note text, and a stray `#` row is an ordinary row that is reported as not one of the 24 inputs. A row with extra non-empty cells beyond the header is refused.

Interactive terminal session (needs a TTY on stdin; it fails with an explanatory error otherwise, and writes nothing):

```bash
node scripts/label-followup.mjs --interactive --labels-out labels.json
node scripts/label-followup.mjs --interactive --labels-out labels.json --resume
```

The session asks for the policy statement first (it must hold a letter or digit; control characters are removed), then walks the 24 inputs. A `--resume` file whose policy is blank asks for the policy again before anything else; if input ends there the file is left as it was. Per input: the acceptable set, then the preferred action (always asked, even when the set has one member), then a note. Enter at the first question skips an input (it stays unlabelled and is asked again on resume); `q` saves and quits. The labels file is created with exclusive creation (an existing file is refused; use `--resume`), and after every answer it is rewritten atomically (temporary sibling file, then rename), so an interrupted session loses nothing already answered. If input ends early the exit code is 3 and progress is kept.

One session per labels file: the session takes an exclusive lock file, `<labels file>.lock` (created with exclusive creation, `wx`), and releases it on quit, end of input, error and normal process exit. A second session on the same file (a second `--resume`, or a new session at a path that has a lock) is refused with exit code 2 and an explanation, instead of two sessions each rewriting the file from their own memory and losing the other's answers. A lock left behind by a crashed or killed session (for example `kill -9`, or power loss) is never deleted automatically: check that no other session is running, then delete the `.lock` file yourself and resume.

## Scoring

```bash
node scripts/score-labels.mjs --labels labels.json --results a.json b.json [--out report.md]
```

`--labels` accepts the interactive JSON file or a filled sheet (`.md`, `.csv`). `--out` is written exclusively (an existing file is refused); without it the report goes to stdout. A path that cannot be written, such as a missing parent directory for `--sheet`, `--out` or `--labels-out`, is reported as `ERROR cannot write <path>: <code>` with exit code 2, never as an uncaught exception.

The scorer refuses to score, exit code 2 and nothing written, unless the policy statement is non-empty and all 24 inputs have a complete label (a non-empty acceptable set, one valid preferred action inside it). Every problem is listed.

Result files are the saved JSON of the earlier experiments and of `scripts/bench-adviser.mjs --out`. Supported shapes; extra fields are ignored:

| Shape | Sources produced |
| --- | --- |
| rows with `model` (`followup-compare-<time>.json`) | one |
| rows with `local4b` and `cloud120b` (`followup-compare-cloud-<time>.json`) | two |
| rows with `variant` and `model` (`followup-prompt-variants-<time>.json`) | one per variant |
| rows with `outlets.<name>` (`bench-adviser/1`, `bench-*.json`) | one per outlet |

An answer is `"ACTION/REASON"`; the action word must be plain ASCII letters (any case). `null`, a missing column and a refused `outlets` entry are no usable answer. The `accepted` flag is trusted only when it is the boolean `true`: for `model` and `cloud120b`, a row that carries `accepted` is an answer only when it is `true` (`false` is a refusal; `0`, `"false"`, `"true"`, `null` and any other value are treated as no answer and counted in a report warning); a row of a format that has no `accepted` key keeps its answer; an `outlets` entry needs `accepted: true` (a missing or non-boolean flag is no answer and is counted). `local4b` never depends on the flag. Result sources are kept apart by the triple (column, outlet, variant), so crafted names cannot merge two of them. The `fixture` column of a result file is not a source; the fixture source is computed from the current `syntheticFollowupAdvice`, and a file whose fixture column differs is reported in a warning. Fixture-only files (no model column) and the reasoning experiment (`followup-reasoning-*.json`, which has named cases and no grid fields) are refused with a reason. `PICKUP_ALL` rows are ignored and counted in a warning.

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
- The scorer trusts the action text in the files and the boolean `accepted: true`; it does not re-run any model or the validator.
- Nothing can tell a human label from a machine-written one. The labels file and the sheets carry no provenance (no signature, no author field, no record of how the text was produced), and the scorer only checks that the file is complete and well formed. That the labels are a person's own judgement is the owner's responsibility; if a model or a script filled them in, the scores here are no longer ground truth and nothing in these tools will show it.

## Echoed text

Every string that the tools echo to a terminal, an error message or the Markdown report (the policy, model, variant and outlet names, file names) goes through one sanitiser, `safeText` in `scripts/label-followup.mjs`: C0 and C1 control characters (so ANSI and OSC escape sequences), DEL, line and paragraph separators and invisible or bidirectional format characters are removed, and in the report Markdown special characters are escaped so a name cannot add a heading, link, tag or table cell. The policy is split on any line ending (`\r\n`, `\n`, `\r`) and each line stays inside the quoted block.

## Tests

```bash
node --test scripts/label-followup.test.mjs scripts/score-labels.test.mjs
```
