#!/usr/bin/env python3
"""
assemble_recovered_cases.py
Assemble the mistakenly filtered case (omp_subtask_0221 with 2 Chinese chars)
and companion recovered English engineering cases from OMP history.
"""

import json

ALL_OMP = "experiments/jev-routing/omp_subagent_prompts_all.json"
OUTPUT = "experiments/jev-routing/recovered_english_cases.json"

with open(ALL_OMP, 'r', encoding='utf-8') as f:
    items = json.load(f)

# Find target IDs
target_ids = [
    ("omp_subtask_0221", "reviewer", "gemini", "CodeReviewer (contains 2 Chinese chars '放行')"),
    ("omp_subtask_0252", "executor", "deepseek", "FixSourceIntegrity (concrete bug patch)"),
    ("omp_subtask_0262", "executor", "deepseek", "ImplementStackCore (kernel core implementation)"),
    ("omp_subtask_0390", "executor", "gemini", "UpdateSuspendDoc (documentation authoring)"),
    ("omp_subtask_0060", "reviewer", "gemini", "DscPatchReview (kernel patch review)"),
    ("omp_subtask_0325", "researcher", "gemini", "NiriSpawnBehavior (Wayland IPC research)"),
    ("omp_subtask_0065", "reviewer", "gemini", "ReviewUdevRule (system udev rules review)"),
    ("omp_subtask_0318", "executor", "deepseek", "AdaptThinkingPatch (code patch)")
]

target_map = {tid: (role, model, desc) for tid, role, model, desc in target_ids}

cases = []
for item in items:
    tid = item["id"]
    if tid in target_map:
        role, model, desc = target_map[tid]
        cases.append({
            "id": tid,
            "task_name": item["task_name"],
            "description": desc,
            "expected_role": role,
            "expected_model": model,
            "original_agent": item["assigned_agent"],
            "caller_model": item["caller_model"],
            "batch_context": item["batch_context"],
            "task": item["task_text"],
            "delegated_assignment": item["delegated_assignment"]
        })

print(f"Assembled {len(cases)} cases including the mistakenly filtered case.")
with open(OUTPUT, 'w', encoding='utf-8') as f:
    json.dump(cases, f, ensure_ascii=False, indent=2)
print(f"Saved to {OUTPUT}")
