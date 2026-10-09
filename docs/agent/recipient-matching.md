# Recipient matching

Written 2026-10-10. Describes what is in the code on this branch; nothing here is deployed.

## The rule

The sender names a person by Chinese name, by employee number, or both. `recipient-match.js`
`resolveRecipient()` applies it, in this order:

1. A Chinese name carried by exactly one enabled person in the pool matches that person directly.
2. A name carried by several people needs the employee number (the directory `id`, unique, checked at load).
   The number must match exactly and must be one of the people sharing the name.
3. A number that points to someone other than the unique name match is a conflict and is refused.
4. A name nobody carries (for example a surname with an honorific) resolves only with an employee number, and
   the answer says the name was not verified.
5. Anything else is refused. Nobody is ever picked first.

The pool is the whole directory, narrowed by the department and tags the sender gives, so uniqueness does
not depend on who is on one authorization. The route then limits what is shown to people on the sender's
authorization; a person outside it looks the same as a person who does not exist.

Traditional and Simplified spellings are not unified. A variant spelling does not match by name and falls to
the employee number. Full-width forms and white space are normalised.

## Data

`nameZh` (string, up to 64), `aliases` (up to eight other names: a nickname, an English name, a former name),
`title` (a short job title, shown beside the name) and `tags` (`region`, `team`, `role`; each a short word)
are optional per person, validated when the registry loads and by the administrator's `person.create` /
`person.update`. A registry without them behaves as before.

An alias is tried only when nobody carries the formal name, and a match through one is never treated as a
verified name: the checklist turns it into a question for the sender.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `POST /api/directory/resolve` | the operator of the authorization | `{authorizationId, nameZh?, employeeId?, department?, tags?}`; answers status, code, the person or the candidates on the authorization, attempts left, and `review` |
| `GET /api/admin/match-guard` | administrator | lists senders and authorizations with a failure count or a lock |
| `POST /api/admin/match-guard` | administrator | `{operatorId, authorizationId}` clears a lock |

Three failed or ambiguous matches in a row on one (sender, authorization) lock it: `423 MATCH_QUARANTINED`
until an administrator clears it. A success resets the count. The state is `match-guard.json` in the data
directory, private to the owner; a file that exists but cannot be read stops matching.

## The checklist and the second opinion

After the match, `match-confirm.js` holds a table of 405 cells over five codes (how many people fit, what
decided it, whether the department or tags decided it, whether the reverse check passed, how many failures
came before). The tags themselves never reach an adviser: only whether they were what made a shared name
unique (`NARROW_DECISIVE`). It answers CONFIRM, ASK_HUMAN or
REFUSE. CONFIRM exists only for one person, checked both ways, with a verified name or number. The page selects
the person on CONFIRM and otherwise shows a button, so the sender chooses.

`MATCH_AI_REVIEW` is off unless it is exactly `local` (the loopback model) or `dual` (the loopback model and the
hosted one, each asked once). The model sees only the four codes. It can turn a CONFIRM into ASK_HUMAN; it
cannot turn a refusal or a question into a confirmation, and an answer outside the table is discarded. The
calls run on the shared API queue, so they add their length to every request waiting behind them.

`followup-table.js` lists the 36 cells of the follow-up decision with the fixture's answer and every legal
action. `node scripts/measure-tables.mjs` prints both tables beside the saved model answers, with no model call.

## Limits

- Agreement with the table is not accuracy. Nobody has labelled these cells.
- The note reader (`public/note-classify.js`) is a fixed keyword list and runs in the browser only. It fills
  fields and narrows the list; it selects nobody.
- Chinese names are set by an administrator one person at a time; there is no bulk import.
- Vector ranking (below) is display order only and off by default.

## Similarity ranking

`recipient-rank.js`, behind `RECIPIENT_RANKING=vector` (exact value, off by default). `POST /api/directory/rank`
takes a short text the sender types for this purpose (up to 100 characters; it is not the note, and it is not
stored) and returns an order of the people on the authorization. People are described by Chinese name, display
name, department and tags, embedded once by a model on this machine (`LOCAL_MODEL_BASE_URL`, loopback only,
default model `text-embedding-nomic-embed-text-v1.5`) and compared by cosine similarity in memory. Nobody
outside the authorization is ranked or sent to the model. It never selects anyone and is not part of the
matching rule, so it does not touch the failure count. If the model cannot answer, the order is the fixed one
(department, name, id) and the answer says why; matching never depends on it.

Measured with the real model on an invented directory of 60 people and 12 queries (`node scripts/rank-eval.mjs`):
first result correct 10 times in 12, against 3 in 12 for the page's existing search box and 1 in 12 for the
fixed order. The search box found nobody in 9 of the 12 queries. It does not read every phrasing: for
"業務的劉先生" the first result was wrong, which is the case the note reader handles by rule. The numbers
describe that model on that directory only.

## Filling the directory from a table

`node scripts/import-directory-mapping.mjs --table mapping.csv --registry access.json [--out candidate.json]`

The table is a CSV (UTF-8) with the columns `employee_id` (required), `name_zh`, `name_en`, `aliases`
(separated by `|`), `title`, `department`, `region`, `team`, `role`, `email`. Rows are matched to people who are
already in the registry; the tool never creates a person, because creating one issues a token. An empty cell
leaves that field alone. By default it only reads and reports: line numbers and employee numbers, never a
name, plus how many Chinese names would still be shared. With `--out` and no errors it writes a new candidate
registry (never over an existing file, never over the registry), for the owner to review and put in place.

## Reading the note with a model

`note-understand.js`, `POST /api/directory/understand`, behind `NOTE_AI=local` (exact value, off by default).
The keyword reader in the browser keeps the note in the browser. This is the one place the note leaves it,
and only to a model on this machine (loopback only, nothing is stored): the sender presses a separate button
that says so. The model is given the note and a closed vocabulary (the department names and tag values on the
sender's authorization) and answers in a fixed shape. It is never shown the people. Fixed code then keeps
only what the note itself supports and what belongs to someone on the authorization: a department or tag must
be in the vocabulary and be something the note says, a name or employee number must appear in the note and
belong to a person on the authorization, and a surname with an honorific stays a surname. It fills boxes and
selects nobody.

Measured with the real model (`node scripts/note-eval.mjs`, 24 invented notes, a 4B model): with fixed-code
checks it got 21 notes exactly right against 13 for the keyword reader, mostly because the keyword reader
does not read tags or phrases like "業務那個姓劉的". Without those checks, before they were added, it also got
13: it filled a name or a tag nobody had said. The checks were written after seeing those failures on this
same set, so the 21 is optimistic; it needs a fresh set of notes before it means more. In the live page one of
two notes missed its department, and the first call after idle took about 8 seconds (2 to 3 seconds
afterwards).

## Delivery status check

`state-check.js` and `POST /api/tasks/status-check` (the sender, for their own task; the button "Check status"
in the task history). For each delivery it reads six codes (the job state, how long it has been in that state
judged against what is normal for the state, how many tries, a class for the reason it is in that state, the
pickup state, the window band) and a table of 4500 cells answers NORMAL, WATCH or NEEDS_HUMAN with one of nine
reasons. The page shows a fixed sentence by reason. It only reads: nothing is written, not even to the audit
trail. `STATE_AI_REVIEW` (exactly `local` or `dual`, off by default) asks a model for a second opinion on the
same codes; the model can raise the level by one step and never lower it, and is not asked when the table
already says a person is needed.

## Not done

The follow-up decision table has no tag dimension. What a tag should change about a reminder is a policy
question, and adding a dimension that changes nothing would be decoration. It needs the owner's rule first.
