#!/usr/bin/env python3
"""
run_jev_routing.py
Two-stage JEV routing experiment runner via OpenRouter Decisions API.
Follows the specification at https://openrouter.ai/docs/guides/community/jev
and repository design in docs/subagent-routing-experiment.md.
"""

import os
import sys
import json
import time
import argparse
from datetime import datetime
import urllib.request
import urllib.error

DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_MODEL = "~typesafe/jev-latest"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROLES_FILE = os.path.join(SCRIPT_DIR, "role_definitions.json")
INSTRUCTIONS_FILE = os.path.join(SCRIPT_DIR, "routing_instructions.json")
PREFERENCES_FILE = os.path.join(SCRIPT_DIR, "model_preferences.json")
STARTUP_FILE = os.path.join(SCRIPT_DIR, "startup_context.json")
BENCHMARK_FILE = os.path.join(SCRIPT_DIR, "omp_subagent_benchmark_cases.json")
ENGLISH_BENCHMARK_FILE = os.path.join(SCRIPT_DIR, "omp_english_benchmark.json")
RECOVERED_FILE = os.path.join(SCRIPT_DIR, "recovered_english_cases.json")
ORIGINAL_FILE = os.path.join(SCRIPT_DIR, "original_cases.json")
ALL_OMP_FILE = os.path.join(SCRIPT_DIR, "omp_subagent_prompts_all.json")
RESULTS_DIR = os.path.join(SCRIPT_DIR, "results")

def load_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

def build_state(assignment_text, startup_context=None, selected_role=None):
    state = {
        "delegated_assignment": assignment_text
    }
    if startup_context is not None:
        state["startup_context"] = startup_context
    if selected_role is not None:
        state["selected_role"] = selected_role
    return state

def estimate_tokens(obj):
    s = json.dumps(obj, ensure_ascii=False)
    # Approximate ~3.5 chars per token for mixed code/json/prose
    return max(1, len(s) // 4)

def call_openrouter_decisions(payload, api_key, endpoint=DEFAULT_ENDPOINT, timeout=45):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(endpoint, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("HTTP-Referer", "https://github.com/pi-harness/subagent-routing")
    req.add_header("X-Title", "Pi Harness Subagent Routing Experiment")

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            latency_ms = int((time.time() - t0) * 1000)
            res_body = response.read().decode('utf-8')
            return json.loads(res_body), latency_ms, None
    except urllib.error.HTTPError as e:
        latency_ms = int((time.time() - t0) * 1000)
        err_body = e.read().decode('utf-8', errors='ignore')
        return None, latency_ms, f"HTTP {e.code}: {err_body}"
    except Exception as e:
        latency_ms = int((time.time() - t0) * 1000)
        return None, latency_ms, str(e)

def run_dry_run_stage(stage_name, payload):
    # Simulated response for testing pipeline
    if stage_name == "role":
        criteria = list(payload["questions"]["role"]["criteria"].keys())
        simulated_choice = criteria[0]
        probs = {k: (0.90 if k == simulated_choice else 0.05) for k in criteria}
        simulated_answer = {
            "type": "choice",
            "choice": simulated_choice,
            "probabilities": probs,
            "confidence": 0.90
        }
    else:
        criteria = list(payload["questions"]["model"]["criteria"].keys())
        simulated_choice = criteria[0]
        probs = {k: (0.95 if k == simulated_choice else 0.05) for k in criteria}
        simulated_answer = {
            "type": "choice",
            "choice": simulated_choice,
            "probabilities": probs,
            "confidence": 0.95
        }
    tokens = estimate_tokens(payload)
    return {
        "id": "dry_run_" + stage_name,
        "model": "typesafe/jev-1.13-dryrun",
        "provider": "TypeSafe",
        "answers": {stage_name: simulated_answer},
        "usage": {
            "input_tokens": tokens,
            "output_tokens": 0,
            "cost": tokens * 0.000000042
        }
    }, 15, None

def main():
    parser = argparse.ArgumentParser(description="Jev Two-Stage Subagent Routing Experiment Runner")
    parser.add_argument("--api-key", default=os.environ.get("OPENROUTER_API_KEY"), help="OpenRouter API Key")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="Decisions API endpoint")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model alias or ID")
    parser.add_argument("--dataset", choices=["english_benchmark", "recovered", "benchmark", "original", "omp_all"], default="english_benchmark", help="Dataset to test")
    parser.add_argument("--variant", choices=["assignment_only", "full_startup", "both"], default="assignment_only", help="Startup context variant")
    parser.add_argument("--limit", type=int, default=10, help="Max cases to run (default: 10)")
    parser.add_argument("--case-id", help="Run only specific case id")
    parser.add_argument("--dry-run", action="store_true", help="Perform offline validation without calling paid API")
    parser.add_argument("--verbose", action="store_true", help="Print full payloads")
    args = parser.parse_args()

    # Load configuration & definitions
    roles = load_json(ROLES_FILE)
    instructions = load_json(INSTRUCTIONS_FILE)
    preferences = load_json(PREFERENCES_FILE)
    startup_context = load_json(STARTUP_FILE)

    # Load selected dataset
    if args.dataset == "recovered":
        cases = load_json(RECOVERED_FILE)
    elif args.dataset == "english_benchmark":
        cases = load_json(ENGLISH_BENCHMARK_FILE)
    elif args.dataset == "benchmark":
        cases = load_json(BENCHMARK_FILE)
    elif args.dataset == "original":
        cases = load_json(ORIGINAL_FILE)
    else:
        cases = load_json(ALL_OMP_FILE)

    if args.case_id:
        cases = [c for c in cases if c.get("id") == args.case_id or c.get("task_name") == args.case_id]
        if not cases:
            print(f"Error: case {args.case_id} not found.")
            sys.exit(1)
    else:
        cases = cases[:args.limit]

    variants = ["assignment_only", "full_startup"] if args.variant == "both" else [args.variant]

    if not args.api_key and not args.dry_run:
        print("[Notice] No OPENROUTER_API_KEY provided in environment or --api-key. Defaulting to --dry-run mode.")
        args.dry_run = True

    print("=" * 80)
    print(f"JEV SUBAGENT ROUTING EXPERIMENT PREPARATION & RUNNER")
    print(f"Mode: {'DRY RUN (Validation only)' if args.dry_run else 'LIVE API EXECUTION'}")
    print(f"Endpoint: {args.endpoint}")
    print(f"Model: {args.model}")
    print(f"Dataset: {args.dataset} ({len(cases)} cases)")
    print(f"Variants: {variants}")
    print(f"Candidate Roles: {list(roles.keys())}")
    print(f"Candidate Models: {list(preferences.keys())}")
    print("=" * 80)

    results_log = []
    summary_rows = []

    for c_idx, case in enumerate(cases):
        case_id = case.get("id", f"case_{c_idx+1}")
        task_name = case.get("task_name", case.get("name", case_id))
        assignment = case.get("delegated_assignment")
        if not assignment:
            ctx = case.get("batch_context", case.get("context", ""))
            task_text = case.get("task", "")
            assignment = f"# Batch context\n\n{ctx}\n\n# Task\n\n{task_text}" if ctx else f"# Task\n\n{task_text}"

        expected_role = case.get("expected_role", case.get("expectedRole", "N/A"))
        expected_model = case.get("expected_model", case.get("expectedModel", "N/A"))

        print(f"\n[{c_idx + 1}/{len(cases)}] Case: {case_id} ({task_name})")
        print(f"    Expected: role={expected_role}, model={expected_model}")

        for variant in variants:
            st_ctx = startup_context if variant == "full_startup" else None

            # --- STAGE 1: ROLE SELECTION ---
            stage1_state = build_state(assignment, startup_context=st_ctx)
            stage1_payload = {
                "model": args.model,
                "state": stage1_state,
                "questions": {
                    "role": {
                        "type": "choice",
                        "instructions": instructions["role"],
                        "criteria": roles
                    }
                }
            }

            if args.verbose:
                print(f"    [Payload Stage 1 ({variant})]: {json.dumps(stage1_payload)[:300]}...")

            if args.dry_run:
                stage1_res, lat1, err1 = run_dry_run_stage("role", stage1_payload)
            else:
                stage1_res, lat1, err1 = call_openrouter_decisions(stage1_payload, args.api_key, args.endpoint)

            if err1:
                print(f"    [Error Stage 1]: {err1}")
                continue

            role_ans = stage1_res.get("answers", {}).get("role", {})
            selected_role_id = role_ans.get("choice")
            role_p = role_ans.get("probabilities", {}).get(selected_role_id, 0.0)
            role_conf = role_ans.get("confidence", 0.0)

            print(f"    -> Variant [{variant}] Stage 1 (Role): {selected_role_id} (p={role_p:.2f}, conf={role_conf:.2f}, {lat1}ms)")

            # --- STAGE 2: MODEL SELECTION ---
            # Crucial design requirement: state includes the actual selected role instructions
            stage2_selected_role = {
                "id": selected_role_id,
                "instructions": roles.get(selected_role_id, "")
            }
            stage2_state = build_state(assignment, startup_context=st_ctx, selected_role=stage2_selected_role)
            stage2_payload = {
                "model": args.model,
                "state": stage2_state,
                "questions": {
                    "model": {
                        "type": "choice",
                        "instructions": instructions["model"],
                        "criteria": preferences
                    }
                }
            }

            if args.verbose:
                print(f"    [Payload Stage 2 ({variant})]: {json.dumps(stage2_payload)[:300]}...")

            if args.dry_run:
                stage2_res, lat2, err2 = run_dry_run_stage("model", stage2_payload)
            else:
                stage2_res, lat2, err2 = call_openrouter_decisions(stage2_payload, args.api_key, args.endpoint)

            if err2:
                print(f"    [Error Stage 2]: {err2}")
                continue

            model_ans = stage2_res.get("answers", {}).get("model", {})
            selected_model_id = model_ans.get("choice")
            model_p = model_ans.get("probabilities", {}).get(selected_model_id, 0.0)
            model_conf = model_ans.get("confidence", 0.0)

            print(f"    -> Variant [{variant}] Stage 2 (Model): {selected_model_id} (p={model_p:.2f}, conf={model_conf:.2f}, {lat2}ms)")

            cost = (stage1_res.get("usage", {}).get("cost", 0.0) or 0.0) + (stage2_res.get("usage", {}).get("cost", 0.0) or 0.0)
            in_tokens = (stage1_res.get("usage", {}).get("input_tokens", 0) or 0) + (stage2_res.get("usage", {}).get("input_tokens", 0) or 0)

            summary_rows.append({
                "case_id": case_id,
                "task_name": task_name,
                "variant": variant,
                "expected_role": expected_role,
                "selected_role": selected_role_id,
                "role_prob": role_p,
                "expected_model": expected_model,
                "selected_model": selected_model_id,
                "model_prob": model_p,
                "two_stage_latency_ms": lat1 + lat2,
                "total_input_tokens": in_tokens,
                "total_cost_usd": cost
            })

            results_log.append({
                "case_id": case_id,
                "variant": variant,
                "stage1": {
                    "request": stage1_payload,
                    "response": stage1_res,
                    "latency_ms": lat1
                },
                "stage2": {
                    "request": stage2_payload,
                    "response": stage2_res,
                    "latency_ms": lat2
                }
            })

    # Summary table
    print("\n" + "=" * 80)
    print("EXPERIMENT SUMMARY")
    print(f"{'Case ID':<25} {'Variant':<16} {'Role':<12} {'Model':<10} {'Latency':<8} {'Tokens'}")
    print("-" * 80)
    for row in summary_rows:
        print(f"{row['case_id'][:24]:<25} {row['variant']:<16} {row['selected_role']:<12} {row['selected_model']:<10} {row['two_stage_latency_ms']}ms   {row['total_input_tokens']}")
    print("=" * 80)

    # Save artifact
    os.makedirs(RESULTS_DIR, exist_ok=True)
    ts_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file = os.path.join(RESULTS_DIR, f"run_{ts_str}.json")
    artifact = {
        "timestamp": datetime.now().isoformat(),
        "mode": "dry_run" if args.dry_run else "live",
        "dataset": args.dataset,
        "endpoint": args.endpoint,
        "model": args.model,
        "cases_count": len(cases),
        "total_requests": len(results_log) * 2,
        "summary": summary_rows,
        "records": results_log
    }
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, ensure_ascii=False, indent=2)
    print(f"\nArtifact successfully saved to {out_file}\n")

if __name__ == "__main__":
    main()
