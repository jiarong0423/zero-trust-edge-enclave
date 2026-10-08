# Adviser Bench

Written 2026-10-08. `scripts/bench-adviser.mjs` reruns one comparison on the follow-up decision:
the deterministic fixture, a loopback local model (NVIDIA Nemotron 3 Nano 4B) and the hosted model
(NVIDIA Nemotron 3 Super 120B on Nebius Token Factory), on the same 36 inputs. Both model outlets go
through the production `requestFileAdvice` path, so the metadata projection, the system boundary, the
output schema and the validator are exactly what the service uses. Zero dependencies; Node 20.11 or later.

The 36 inputs are 4 time codes (`WINDOW_FULL`, `WINDOW_MOST`, `WINDOW_LITTLE`, `WINDOW_LAST`) x 3 pickup
codes (`PICKUP_NONE`, `PICKUP_SOME`, `PICKUP_ALL`) x nudge counts 0 to `MAX_NUDGES` (2). Each input
carries only those five pseudonymous fields (with a fixed placeholder task alias); no document, recipient
or key exists in the script.

## Modes

| Command | Network | Cost | What it does |
| --- | --- | --- | --- |
| `node scripts/bench-adviser.mjs` (or `npm run bench`) | none | none | Prints the 36-row table and the fixture action counts (WAIT 16 / REMIND 8 / ESCALATE 12). |
| `node scripts/bench-adviser.mjs --local` | loopback only | none | Probes `<base>/models`, requires the model to be loaded, then makes 36 calls. |
| `node scripts/bench-adviser.mjs --cloud --yes-spend` | `api.tokenfactory.nebius.com` | money | 36 calls, 1.2 s apart, hard cap 40. |

`--out <file>` writes the result as JSON. It uses exclusive creation and refuses (exit 2) if the file
exists, before any model call is made. The JSON holds the grid, the fixture answers, per-outlet answers
and latencies, the summaries, endpoint host and model name. It holds no key. `--local` and `--cloud` can
be combined; every gate for both is checked before the first call.

Exit codes: 0 done; 2 refused or not ready (nothing written); 1 unexpected failure.

### Local (`--local`)

- `LOCAL_MODEL_BASE_URL`, default `http://127.0.0.1:1234/v1`. Must be loopback (`127.0.0.1`, `::1`,
  `localhost`) and a plain `/v1` URL. Anything else is refused before any request. The production outlet
  applies the same rule, so a remote host cannot be passed off as local.
- `LOCAL_MODEL_NAME`, default `nvidia-nemotron-3-nano-4b`. It must appear in the runtime's `/models` list.
- If the probe fails or the model is not loaded, the script prints a line starting
  `ERROR local model not ready`, exits 2 and writes no output file. A refused connection is therefore never
  recorded as 36 model rejections.

### Hosted (`--cloud --yes-spend`)

Both are required, and the key must already be in the process environment:

```
NEBIUS_API_KEY=... node scripts/bench-adviser.mjs --cloud --yes-spend --out result.json
```

- The script never reads a `.env` file or any key file, never prints the key, and redacts it from any
  error text it records. Without the flag or without the key it exits 2 before any request.
- Optional: `NEBIUS_BASE_URL` (default `https://api.tokenfactory.nebius.com/v1`) and `NEBIUS_MODEL`
  (default `nvidia/nemotron-3-super-120b-a12b`). The production rule still applies: host
  `api.tokenfactory.nebius.com`, model name starting `nvidia/`.
- Before the first call it prints the call count and an estimated cost. With `NEBIUS_PRICE_INPUT_PER_M` and
  `NEBIUS_PRICE_OUTPUT_PER_M` set (USD per million tokens) the estimate is an upper bound: about 4
  characters per input token for the system boundary plus the input, and every answer at the provider's
  `max_tokens`. With either price missing it prints "unpriced". The estimate is not a bill; check the
  provider's usage page.
- Calls are sequential and 1.2 s apart. The repo's `NEBIUS_BUDGET_USD` accounting is not applied here;
  the 40-call cap and your own provider limits are the controls.

## Running on an edge device (for example an NVIDIA Jetson)

Run the runtime and the script on the same machine so the traffic never leaves loopback.

1. Start an OpenAI-compatible server on the device (LM Studio, llama.cpp `llama-server`, or similar) with
   the Nemotron 3 Nano 4B model loaded, listening on `127.0.0.1`.
2. Set `LOCAL_MODEL_BASE_URL` to its `/v1` URL and `LOCAL_MODEL_NAME` to the id shown by `GET /v1/models`.
3. `node scripts/bench-adviser.mjs --local --out local.json`.

The script asks the runtime for a JSON-schema constrained answer with reasoning off and temperature 0, as
the production local outlet does (`file-adviser.js`). A runtime that ignores those fields can be slower or
refuse more answers; the rejection counts in the summary show it. Each call has a 10 s timeout. No
internet connection is needed for the fixture or local modes.

## Reading the output

Per outlet the footer prints: accepted count (an answer counts only if it passes the production
validator), action distribution of accepted answers, how many accepted answers have the same action as the
fixture, and latency min, median and max over accepted answers (median of an even count is the rounded mean
of the two middle values). Rejected answers are listed by code and excluded from the distribution,
agreement and latency.

## What the numbers do not mean

- The fixture is a blunt stand-in, not ground truth; agreement is not accuracy. It is a short lookup
  written to be predictable. A model that disagrees with it may be right, and one that agrees may be right
  by accident.
- Agreement compares the action only, not the reason code.
- Accepted means the answer passed schema and coherence checks (for example, a reason that contradicts the
  input is rejected). It does not mean the answer was good.
- One run is one sample of 36 synthetic inputs with a fixed task alias, one prompt and one runtime build.
  Models are not deterministic across runtimes, quantisations or settings, and hosted models change. Do not
  extrapolate to real traffic, to other prompts, or to other hardware; latency in particular depends on the
  device, the quantisation, cold versus warm start and, for the hosted model, the network path.
- The adviser's output is untrusted data. The backend alone authorises and sends, so none of these numbers
  is a security measurement.
