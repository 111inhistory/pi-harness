#!/usr/bin/env python3
"""
generate_english_benchmark.py
Curate 20 representative, real-world English subagent tasks from OMP history.
"""

import json
import os

ALL_OMP = "experiments/jev-routing/omp_subagent_prompts_all.json"
OUTPUT = "experiments/jev-routing/omp_english_benchmark.json"

with open(ALL_OMP, 'r', encoding='utf-8') as f:
    items = json.load(f)

# Map by task_name or specific identifiers
selected_names = [
    # Investigation / Research (scout)
    ("VerifyNoNestedAgentApi", "researcher", "gemini", "investigation_pi_apis"),
    ("VerifyExtraExamples", "researcher", "gemini", "investigation_pi_examples"),
    ("EmitterProtocol", "researcher", "gemini", "reverse_engineering_protocol"),
    ("LocalSendUpstream", "researcher", "gemini", "network_diagnosis"),
    ("DrmLink", "researcher", "gemini", "kernel_sysfs_diagnostics"),
    ("WorkspaceResearch", "researcher", "gemini", "system_research"),
    ("FeatureAudit", "researcher", "gemini", "system_inventory_audit"),
    ("ServiceAudit", "researcher", "gemini", "service_dependency_audit"),
    
    # Execution / Implementation (executor -> deepseek for code, gemini for docs)
    ("CoreBuild", "executor", "deepseek", "build_system_implementation"),
    ("DaemonRescue", "executor", "deepseek", "cpp_daemon_implementation"),
    ("CLI", "executor", "deepseek", "cli_tool_implementation"),
    ("OBSPlugin", "executor", "deepseek", "plugin_implementation"),
    
    # Independent Review / Security Audit (reviewer -> gemini)
    ("IrlightReview", "reviewer", "gemini", "cross_component_review"),
    ("ObsSafetyAudit", "reviewer", "gemini", "security_lock_audit"),
    ("CliMesonAudit", "reviewer", "gemini", "build_configuration_audit"),
    ("CoreDaemonAudit", "reviewer", "gemini", "daemon_correctness_audit"),
    ("FinalCppPackagingReview", "reviewer", "gemini", "packaging_compliance_audit"),
    ("ReviewStackCore", "reviewer", "gemini", "protocol_spec_review"),
    ("SuspendReview", "reviewer", "gemini", "system_hook_review"),
    ("MozillaWaylandIme", "researcher", "gemini", "wayland_ime_diagnostics")
]

selected_dict = {name: (role, model, cat) for name, role, model, cat in selected_names}

found_cases = []
seen_names = set()

for item in items:
    if item['language'] != 'en':
        continue
    name = item['task_name']
    if name in selected_dict and name not in seen_names:
        seen_names.add(name)
        role, model, cat = selected_dict[name]
        case_id = f"en_{len(found_cases)+1:02d}_{name.lower()}"
        found_cases.append({
            "id": case_id,
            "task_name": name,
            "category": cat,
            "expected_role": role,
            "expected_model": model,
            "original_agent": item["assigned_agent"],
            "caller_model": item["caller_model"],
            "batch_context": item["batch_context"],
            "task": item["task_text"],
            "delegated_assignment": item["delegated_assignment"]
        })

print(f"Matched {len(found_cases)} target cases.")
# If any missing from selected_names, let's see which ones
missing = set(selected_dict.keys()) - seen_names
if missing:
    print(f"Missing names: {missing}")

# Save to output
with open(OUTPUT, 'w', encoding='utf-8') as f:
    json.dump(found_cases, f, ensure_ascii=False, indent=2)

print(f"Saved {len(found_cases)} cases to {OUTPUT}")
