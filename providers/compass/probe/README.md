# Selection-first model probe

## Latest observed state — 2026-10-15 rerun

Under new explicit owner approval (one Tokyo L4, at most one hour, additional USD10, Mac IAP loopback preflight), the corrected requests produced **8/8 HTTP 200 and 8/8 expected choices** from the actual self-hosted model. First request 9.298s; subsequent requests 0.282–1.077s. All five created resource types were deleted and independently read back as empty. See [the live evidence](../notes/model-evidence.md). This is eight single English trials, not general accuracy, product readiness or paid E2E. No GPU remains from this run; no automatic additional run or permanent deployment is authorized. Independent Claude Code Opus5.5 live-result and evidence review is complete: LGTM, no remaining required fixes. The jointly designed prompt/cases and catalog-specific hints limit this result; it is sufficient for a minimal API prototype, not generalization or production readiness. Older checkpoints below retain their historical scope.

Owner instruction: first make the Jev-compatible model choose a useful Provider, then expose Compass as a Provider, then connect its payment flow. MPP expansion is paused. This is an isolated model feasibility probe, not the paid production service; original production safety requirements remain.

- `catalog.json`: three API endpoint candidates from the public, documented MPP catalog. Exa is listed first-party; CoinGecko and OpenWeather entries are third-party Locus integrations, not official direct MPP deployments. Listing metadata is not live availability, a current quote, or Router compatibility. All purchases disabled.
- `cases.json`: English expected labels only, NOT model responses. Includes selection, missing input, no match, and an explicitly synthetic malicious-description case.
- These external entries are model-evaluation candidates rather than the approved production design's existing Router-route catalog. They must not silently replace that production catalog or imply new payment support.
- Current Router discovery was readable: fixed routes all name ETH snapshots; dynamic profiles are payment paths, not different service capabilities. Do not turn profile count into a Provider diversity claim.
- Existing Arc/Solana Provider docs include SOL snapshots, but the actual curl probe of the Arc SOL URL returned 404. Source presence is not deployment readiness; this is not a new repair task.

The initial actual-model response deliverable is now recorded in the live evidence above. Next is live-result review and the smallest Compass API slice, with production-design reconciliation before implementation. No rules/mock answers may be presented as model results. No fixed confidence threshold is justified yet.

## Minimal model request contract

Source: https://raw.githubusercontent.com/taeold/djev-run/2f6e6b9b455eec27dcdc0a4cb71a3fafdec6acc8/README.md

`POST /v1/systemone` with `state` and `questions.selection` (`type: choice`, `instructions`, `criteria`); expected response field is `answers.selection.choice`. Criteria are exactly the three catalog IDs, `needs_clarification`, and `none`. Provider descriptions are untrusted data. Output IDs outside the allowlist and malformed responses are errors, not no-match decisions. Expected labels must never enter a model request. The earlier list-shaped criteria contract was mistaken: the actual pinned image rejected all eight requests with HTTP 422 before inference. Criteria must be an object mapping those five IDs, in the same order, to `null`; every other request field and the expected labels are preserved. The corrected shape first passed the exact pinned parser offline; the separately authorized rerun above subsequently verified actual HTTP/model inference for these eight cases.

## Prior L4 execution and pre-rerun gate (historical)

Owner previously explicitly approved the bounded execution scope with 「許可します。」: Tokyo Compute Engine L4 x1, at most one hour, total budget USD10, Compute/IAP enablement, container execution only inside the new VM, private model access, cleanup of new resources. The earlier RTX PRO 6000/Cloud Run/Singapore proposal is superseded. No permission for region/model substitution, purchases, or quota increases is inferred.

The project-wide GPU quota limit 0 was an earlier blocker, not the current execution result. In `.claude_workflow/local/l4-run-20261015-001547/`, `manifest.json` and `health.json` record a real Tokyo L4 boot and health HTTP 200. All eight `/v1/systemone` requests then returned 422 for list-shaped choice criteria before inference; no selection succeeded. `parent-cleanup-verification.json` confirms removal of all created instances, disks, firewalls, subnets and networks. Preserve these original artifacts.

The previous absolute time envelope ended at **2026-10-15T00:44:05Z**. At that checkpoint no new paid scope was approved. Local tests and the correction did not renew permission, time or budget. The subsequent explicit approval and completed rerun are recorded above; that approval is not open-ended.
- Target candidate: Compute Engine `g2-standard-4`, one L4 24 GB, 4 vCPU / 16 GiB host RAM, Tokyo `asia-northeast1`. Official GPU table lists G2 in zones a, b and c. This is published support, not available account quota or capacity.
- Official live pricing UI, explicitly switched to Tokyo: standard on-demand VM price USD 0.907714004/hour, including the bundled GPU/CPU/RAM, excluding disk/network. Codelab USD0.71/hour is not the Tokyo quote.
- Proposed run limits remain one VM, at most one hour, USD10 total budget including ancillary costs. Use a fixed absolute termination time or `--max-run-duration=1h` with `--instance-termination-action=DELETE` and boot disk auto-delete. The prior run used an absolute deletion deadline; a future run still needs a newly approved envelope. Do not restart the VM or reset its allowed runtime.
- Historical pre-enable observation: the regional quota probe returned `SERVICE_DISABLED`; it did not establish a zero quota. Compute and IAP enablement were subsequently read-back verified under the previous scope.
- Use private model access through IAP; never expose inference to the public internet. The workshop recipe runs Docker inside the new VM. Prior Docker prohibition must be scoped/cleared before that execution; no local Docker or existing Router changes are allowed.
- Workshop revision: `9058f36f9ded43e37b6d193d3ce980956bc68669`. Startup source pins `ghcr.io/taeold/djev-run@sha256:efbf11a54e10c42b7d1379194befe100535171bfe9ed70dc1e431302d2b7a14b`; model `nvidia/diffusiongemma-26B-A4B-it-NVFP4`. The prior startup pinned model revision `ec4ff3df205028f4e81c954c2227f9312b3ec2ea`; boot/health evidence does not establish selection quality or corrected-request compatibility. Do not execute the upstream installer: it can enable APIs or create other resources.
- `requests.jsonl` contains the eight request payloads with case IDs outside the model payload. Expected labels remain only in `cases.json`; prior results contain pre-inference errors, not observed choices. Send only each row's `request` member to the server.

## Offline contract correction and local checks

Inspection-only source: `.claude_workflow/local/l4-image-contract/structured_server.py`, full SHA-256 `2cfeae752c36434964ba2dd37871078f8dba476df25c3b2045451312cc93f214`. Its adjacent `provenance.json` records the pinned container digest above and verified layer digest `sha256:090469abf45ca0c70300d45c50efc16421c59c8a2f874f86f63e838eb797fe32`. This cache remains ignored/local; no upstream implementation is copied into product files.

`.claude_workflow/local/contract_parser.py` fails closed on source hash drift and AST-selects only reviewed `SchemaError`, `jev_schema`, `parse_schema`, `schedule`, and literal constants `MAX_QUESTIONS`, `MAX_SAMPLES`, `SPAN_REGION`, `SPAN_LIST_REGION`, `JEV_EXTENSIONS`. It does not import the server module or GPU dependencies. Operational preflight pins the complete corrected eight-request fixture and executes the exact parser before any gcloud call or resource creation; missing cache or mismatched inputs stop execution.

Run from this worktree, without `--execute`:

```sh
python3 .claude_workflow/local/test_contract_parser.py
python3 .claude_workflow/local/test_contract_loop.py
python3 .claude_workflow/local/test_l4_guards.py
python3 .claude_workflow/local/run_l4_probe.py
```

Evidence is under `.claude_workflow/local/contract-evidence/contract-*.json`, with command, exit status and output. The original requests, expected cases and operational script are preserved alongside it. Parser RED: all eight current requests rejected with the real criteria error; GREEN: all eight corrected requests accepted, with negative list/hash drift/fixture mismatch and byte-preservation checks. Loop tests use **mocked transport only**, not model evidence. They verify one first submission, save-before-stop for non-200/malformed/non-allowlisted responses, stopping on later failures, no retries or request rewriting, and continuation on valid but unexpected choices. Health remains in `health.json`; `schema_valid`, `transport_success` and `matches_expected` are separate result fields. Invalid transport/schema results have unevaluated quality (`null`).

Focused tests pass (parser 5, loop 3, existing guards 2). In the author's restricted local sandbox the default preflight reached its existing loopback availability check, then stopped at `socket.bind(('127.0.0.1', 18096))` with `PermissionError: [Errno 1] Operation not permitted`. No escalation or bypass was attempted. At that checkpoint the denied bind was not rerun through another executor and the operational permission boundary remained unresolved. Later, the owner explicitly approved the Mac loopback preflight as a separate action; that preflight passed before the new cloud run. The socket-free parser and mocked-loop tests are separate checks already within the local scope. This is not a cloud or parser failure and is not a complete operational preflight pass.

Progress: local green + independent Claude review → new explicit bounded cloud approval → one real smoke request → remaining seven are completed. Next gates: per-case quality and latency review → Compass API → separately approved payment integration. A valid smoke choice may differ from its expected label; retain that quality mismatch. None of the offline results demonstrates model selection success.

Sources:
- https://docs.cloud.google.com/compute/docs/gpus/gpu-regions-zones
- https://cloud.google.com/products/compute/pricing/accelerator-optimized#accelerator-optimized-machine-type-family (Tokyo selected)
- https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime
- https://github.com/gca-americas/discriminative-models-workshop/blob/9058f36f9ded43e37b6d193d3ce980956bc68669/scripts/gemma_vm_startup.sh

## Historical superseded Cloud Run proposal (NOT active)

At the time of this superseded proposal, read-only gcloud access worked. The enabled-service listing did not include run.googleapis.com or compute.googleapis.com. Nothing was enabled at that stage. Official Cloud Run docs confirm RTX PRO 6000 support in us-central1, minimum 20 vCPU/80 GiB. Current images, model revision, quota, actual price, startup and inference remain unverified.

Owner prefers a region closer to Tokyo. RTX PRO 6000 Cloud Run is documented in asia-southeast1 (Singapore); Tokyo is not in that GPU's supported-region list. Actual quota/capacity and regional price remain unverified. Do not switch regions without owner agreement.

Proposed initial allowance (NOT approved): project subetha/configuration subetha-compass; private authenticated Cloud Run in asia-southeast1 (Singapore); max one GPU instance, min zero; GPU allocation up to one hour and estimated total spend budget USD10, including necessary storage/image staging. No execution unless current price estimate fits. Remove only newly created probe resources after the run. Cloud billing has delayed reporting: budget alone is not an instantaneous hard cap. Any larger run, alternate service/model, paid downstream API or signature remains separately gated.
