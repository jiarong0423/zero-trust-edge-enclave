# NVIDIA model provenance (Nemotron 3 Nano 4B and Nemotron 3 Super 120B-A12B)


> **Verification note (lead, 2026-10-08).** This record was compiled by a research pass that read some pages through a summarising tool. The lead then opened the official Hugging Face card for `nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16` directly and confirmed: license `nvidia-nemotron-open-model-license`; `temperature=1.0` and `top_p=0.95` recommended for reasoning tasks and `temperature=0.6`, `top_p=0.95` for tool calling; reasoning is on by default and is turned off with `enable_thinking=False` in the chat template; the card lists "Model Dates: Dec 2025 - Jan 2026". Every other version number, release date, size and pricing statement below was NOT re-checked by the lead and should be read as the research pass's report with its source URL.

Read on: 2026-10-08 (every page below was read on this date; all pages fetched through a summarising fetch tool, so exact wording of long cards was not verified line by line).

Scope: research only. No code was changed. Recommendations are marked as such.

## 1. Official model cards

### 1.1 NVIDIA Nemotron 3 Nano 4B

| Item | Finding | Source (read 2026-10-08) |
|---|---|---|
| Exact name | `nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16` (card text also uses the short repo `nvidia/NVIDIA-Nemotron-3-Nano-4B`) | https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16 |
| Version / date | v1.0; Hugging Face release 2026-03-16; model dates Dec 2025 to Jan 2026; pretraining cutoff Sep 2024 | same |
| Latest? | Yes, the card lists no newer revision. It is a ~3.97B-parameter Mamba-2/Transformer hybrid compressed from NVIDIA-Nemotron-Nano-9B-v2; context up to 262K | same |
| License | NVIDIA Nemotron Open Model License; card says "ready for commercial use" | same |
| License terms (paraphrase) | Perpetual, worldwide, royalty-free, irrevocable grant incl. commercial use and derivatives; recipients must get the license text and notices; NVIDIA claims no ownership of outputs; the grant ends for a licensee who sues over patent/copyright infringement by the model or its output; license text last modified 2025-12-15 | https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/ |
| Intended use | Edge agentic AI (Jetson Thor, GeForce RTX, DGX Spark): game NPCs, local voice assistants, IoT automation; English and code | HF BF16 card |
| Sampling | Reasoning tasks: temperature 1.0, top_p 0.95. Tool calling: temperature 0.6, top_p 0.95. top_k and max output tokens: not specified (examples use max_new_tokens 32 / 256 and a TRT-LLM example max_tokens 1024) | HF BF16 card |
| Reasoning control | On by default (`enable_thinking` defaults to True in `apply_chat_template`); off via `enable_thinking=False`. Card also says reasoning is controllable via a system prompt and that turning it off slightly lowers accuracy on harder prompts. Benchmarks on the GGUF card are stated as reasoning-off mode | HF BF16 card; GGUF card |
| System prompt | No guidance beyond the reasoning-control remark | HF BF16 card |
| Structured output | Not addressed. Only a tool-call parser (`qwen3_coder`) and reasoning parser (`nano_v3`) for vLLM are given. GGUF card lists input/output as text only | HF BF16 card; GGUF card |
| Limitations / safety | Validate for your own use case; do not circumvent guardrails without a comparable one; separate Safety/Bias/Privacy subcards exist | HF BF16 card |

### 1.2 NVIDIA Nemotron 3 Super 120B-A12B

| Item | Finding | Source (read 2026-10-08) |
|---|---|---|
| Exact name | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` (NIM API reference names the model `NVIDIA-Nemotron-3-Super-120B-A12B`, API id `nvidia/nemotron-3-super`) | https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16 ; https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b |
| Version / date | v1.0 GA, released 2026-03-11; no revision history on the card. Data: pretraining to Jun 2025, post-training to Feb 2026 | HF card |
| Latest? | Yes for the Super size. Separate checkpoints on the card: NVFP4, Base-BF16, and an updated MTPv2 head. No 3.5 Super found (see section 4) | HF card |
| Architecture | 120B total, 12B active, LatentMoE with Mamba-2, MoE and attention; context up to 1M (256K default in HF config; 1M needs an env var and larger max-model-len) | HF card |
| License | NVIDIA Nemotron Open Model License; "ready for commercial use"; NIM containers fall under separate NVIDIA software terms | HF card; license URL in 1.1 |
| Intended use | Reasoning and chat, agents, RAG, instruction following, long context, tool use, high-volume workloads | HF card |
| Sampling | temperature 1.0, top_p 0.95 "across all tasks and serving backends" (paraphrased from the NIM page); top_k not specified; max_tokens examples 16000 (chat) and 32000 (coding agent config, 32768 output limit) | HF card; NIM page |
| Reasoning control | On by default. Off: `chat_template_kwargs: {"enable_thinking": false}`. Shorter reasoning: `enable_thinking: true` plus `low_effort: true`. `reasoning_budget` is a client-side helper argument (default 512), not a server parameter; if no newline appears within 500 tokens the trace is closed at budget + 500. `force_nonempty_content: true` recommended for coding agents | HF card; NIM page |
| System prompt | Only a sample ("You are a helpful assistant. /think") in the budget example; no dedicated guidance | HF card |
| Structured output | Not addressed (no `response_format`, no guided decoding guidance). Card only says fine-tuning data included structured-output examples | HF card; NIM page (first 100000 characters only; the remaining ~211k characters were not read) |
| Limitations / safety | Test for own use case; keep guardrails; demographic skews in training data, bias audit advised; no section on repetition or long reasoning | HF card |

## 2. Nebius Token Factory (hosted outlet)

| Item | Finding | Source (read 2026-10-08) |
|---|---|---|
| Model id | `nvidia/nemotron-3-super-120b-a12b` (from the sample API call); no version suffix shown | https://nebius.com/services/token-factory/nemotron ; https://nebius.com/blog/posts/nemotron3-super-now-available |
| Announcement | 2026-03-11, "up to 1M tokens" context, tool calling and multi-token prediction mentioned; no structured-output statement; no recommended parameters | blog URL above |
| Context (conflict) | Nebius blog: up to 1M. Third-party aggregator: 256,000 context, 32,768 max output | https://cloudprice.net/models/nebius/nvidia/nemotron-3-super-120b-a12b (via search snippet, page not opened) |
| Pricing | Nebius pages show no figures. Aggregator shows $0.30 input / $0.90 output per 1M tokens (third party, may lag) | cloudprice URL above (search snippet) |
| Deprecation | None stated on the Nebius pages read | blog and Nemotron page |
| Flavors / params | Nebius docs say a `-fast` suffix selects a faster flavor and that the API supports the full set of vLLM parameters. The model catalog (`tokenfactory.nebius.com/endpoints`) and the verbose `/v1/models` listing were not reachable without a login or key | https://docs.tokenfactory.nebius.com/ai-models-inference/overview ; https://docs.tokenfactory.nebius.com/api-reference/examples/list-of-models |
| Family on Nebius | Nebius lists Nemotron 3 Nano 30B, Nano Omni, Super 120B and Ultra 550B | https://nebius.com/services/token-factory/nemotron |

## 3. LM Studio and GGUF side (local outlet)

| Item | Finding | Source (read 2026-10-08) |
|---|---|---|
| Official GGUF | `nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF`: one quantisation only, Q4_K_M, about 2.84 GB | https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF |
| LM Studio community GGUF | `lmstudio-community/NVIDIA-Nemotron-3-Nano-4B-GGUF`: Q4_K_M 2.84 GB, Q6_K 3.93 GB, Q8_0 4.23 GB; license tag `nvidia-open-model-license`; no sampling guidance; no date shown | https://huggingface.co/lmstudio-community/NVIDIA-Nemotron-3-Nano-4B-GGUF |
| LM Studio catalog entry | `nvidia/nemotron-3-nano-4b`, last updated March 16 (year not shown); minimum memory 5 GB; custom fields "Enable Thinking" (default true) and "Truncate Thinking History" (default true); no recommended sampling values; tool use and reasoning toggle listed | https://lmstudio.ai/models/nvidia/nemotron-3-nano-4b |
| Recommended runtime | Official GGUF card gives setup for llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang and others and names none as preferred. Its only server example is llama.cpp (`llama-server -hf ...:Q4_K_M -c 0 ...`). Card gives no temperature, top_p, top_k or max-token values | official GGUF card |
| Other GGUF | Unsloth publishes `unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF` (guide suggests Q8_0 for llama.cpp) | https://unsloth.ai/docs/models/nemotron-3 (via search snippet, page not opened) |

Which quantisation the project's LM Studio actually loads is not recorded in the repository files read here and was not checked.

## 4. Newer family members the owner should know about

| Model | Finding | Source (read 2026-10-08) |
|---|---|---|
| Nemotron 3 Ultra 550B-A55B | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16`, v1.0 GA, 2026-06-04. License is OpenMDW-1.1 (not the Nemotron Open Model License). Same sampling (temperature 1.0, top_p 0.95), `enable_thinking`, plus a `medium_effort` option. Datacenter size (8x B200 class minimum), not usable locally | https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16 |
| Nemotron 3.5 Lightning 30B-A3B | `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`, GA 2026-08-11, OpenMDW-1.1. Press and Artificial Analysis call it the successor to Nemotron 3 Nano 30B-A3B, not to the 4B. Same sampling recommendation (temperature 1.0, top_p 0.95); `enable_thinking` toggle. LM Studio community GGUF is 24.5 GB at Q4_K_M, so it is not a drop-in for a 4B local outlet | https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 ; https://artificialanalysis.ai/articles/nemotron-3-5-lightning-launch ; https://huggingface.co/lmstudio-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF |
| Nano 4B revisions | None found: only v1.0 | HF BF16 card |
| Super revisions | None found beyond the MTPv2 head checkpoint | HF Super card |

## 5. Comparison with what this project does

Project values from `file-adviser.js` (ADVISER_PROVIDERS and the request body). Note: the request body sets `temperature: 1, top_p: 0.95` for every provider first, and the local `shape()` then overrides temperature to 0, so the local outlet also sends `top_p: 0.95`.

### 5.1 Local outlet (Nano 4B, LM Studio)

| Setting sent | Official recommendation | Status | Implication (recommendation only) |
|---|---|---|---|
| `temperature: 0` | 1.0 for reasoning tasks, 0.6 for tool calling; nothing for reasoning-off or schema-constrained answers | DIFFERS | The project measured greedy at 30/30 accepted vs temperature 1 at 3 invalid in 18. Keep, but an A/B at 0.6 under the strict schema is the only official-aligned point worth testing. Greedy decoding may also contribute to the WAIT passivity. |
| `top_p: 0.95` | 0.95 | MATCH | Inert at temperature 0. |
| `reasoning_effort: 'none'` | Not in the card. Official switch is `enable_thinking` or a system prompt; card says off costs a little accuracy on harder prompts | UNKNOWN | The project found `chat_template_kwargs` and `/no_think` ignored by this LM Studio runtime. Reasoning-off is an officially supported mode, but it is the weaker mode on judgment tasks, which fits a passive follow-up decision. Reasoning on (7 to 27 s measured) is the official default and the untested lever. |
| `response_format: json_schema` strict | Card is silent on structured output | UNKNOWN | Constraint is a runtime feature, not a model-card feature; the validator remains the boundary. |
| `max_tokens: 1536` | No recommendation; examples 32, 256, 1024 | UNKNOWN | Headroom choice is empirical and harmless. |
| System message with boundary text | No guidance except that reasoning is system-prompt-controllable | UNKNOWN | Wording of the system prompt is the unexplored lever for passivity (for example stating the decision rule and deadline logic explicitly). |
| Quantisation (not sent, loaded in LM Studio) | Official GGUF is Q4_K_M only; community also has Q6_K and Q8_0 | UNKNOWN | Loaded quant not confirmed. Q8_0 is 1.4 GB larger than Q4_K_M and is worth a passivity test on a 4B. This is an inference, not an official claim. |
| Model version | Only v1.0 exists for Nano 4B | MATCH | No newer 4B to move to. The 30B-A3B successor (Lightning) is a different size class. |

### 5.2 Hosted outlet (Super 120B-A12B, Nebius)

| Setting sent | Official recommendation | Status | Implication (recommendation only) |
|---|---|---|---|
| `temperature: 1` | 1.0 | MATCH | None. |
| `top_p: 0.95` | 0.95 | MATCH | None. |
| `chat_template_kwargs: { enable_thinking: false }` | Documented toggle | MATCH | Optional lighter alternative is `enable_thinking: true` with `low_effort: true`; untested here. |
| `response_format: json_object` | Card silent; Nebius docs say the full vLLM parameter set is supported but do not list this one | UNKNOWN | Works in practice per project history; validator remains the boundary. |
| `max_tokens: 512` | Examples 16000 (chat), 32000 (agent) | UNKNOWN | Adequate with reasoning off for a five-field answer; would truncate if reasoning were turned on. |
| Model id `nvidia/nemotron-3-super-120b-a12b` | Nebius pages show this id | MATCH | Nebius id differs from the NIM id `nvidia/nemotron-3-super`; do not mix them. |
| Version | v1.0 GA is the only listed version | MATCH | MTPv2 head is a separate checkpoint, not a hosted-model change visible to callers. |

### 5.3 Biggest differences

1. Local `temperature: 0` against official 0.6 to 1.0.
2. Local reasoning forced off against an official default of reasoning on.
3. Local settings were chosen to satisfy a strict validator and latency, not the card. The card is silent on structured output and does not endorse the combination.

## 6. Unconfirmed

- Which GGUF quantisation of Nano 4B the project's LM Studio loads.
- Whether `reasoning_effort` is a recognised control for Nemotron in any official NVIDIA source; no official page mentions it.
- Official guidance on structured output (`json_schema`, `json_object`) for either model; both cards are silent.
- Official max_tokens or top_k recommendations for Nano 4B; not given.
- Nebius Super context length (1M per Nebius blog vs 256K per an aggregator), pricing (only third-party figures), deprecation status (none on pages read), and whether the catalog entry has a version suffix. The authenticated catalog and `/v1/models?verbose=true` were not read.
- The remaining ~211k characters of the NIM API reference page for Super were not read.
- The full text of the Nemotron Open Model License was summarised by the fetch tool; read the primary text before relying on legal terms.
- No official "Nemotron 3.5 Super" or "Nemotron 3.5 Nano" announcement was found; absence is not proof that none exists.
- Release dates are as printed on Hugging Face cards; the LM Studio catalog shows only "March 16" with no year.
- Unsloth page and aggregator pages (cloudprice) were seen only as search snippets.
