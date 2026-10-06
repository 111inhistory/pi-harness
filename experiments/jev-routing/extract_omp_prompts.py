#!/usr/bin/env python3
"""
extract_omp_prompts.py
Extract subagent task prompts from ~/.omp stats.db and session jsonl logs.
Produces:
1. omp_subagent_prompts_all.json - Complete extracted dataset of all historical subagent tasks.
2. omp_subagent_benchmark_cases.json - Curated diverse benchmark cases for Jev routing experiment.
"""

import os
import sys
import json
import sqlite3
from datetime import datetime

STATS_DB = "/home/skwj111/.omp/stats.db"
OUTPUT_ALL = "experiments/jev-routing/omp_subagent_prompts_all.json"
OUTPUT_BENCHMARK = "experiments/jev-routing/omp_subagent_benchmark_cases.json"

def is_chinese(text: str) -> bool:
    return any('\u4e00' <= char <= '\u9fff' for char in text)

def extract_all():
    if not os.path.exists(STATS_DB):
        raise FileNotFoundError(f"Stats DB not found at {STATS_DB}")

    conn = sqlite3.connect(STATS_DB)
    c = conn.cursor()
    # Query all task tool calls
    c.execute("""
        SELECT session_file, tool_call_id, entry_id, model, timestamp 
        FROM tool_calls 
        WHERE tool_name = 'task' 
        ORDER BY timestamp ASC
    """)
    rows = c.fetchall()
    print(f"Found {len(rows)} 'task' tool call records in stats.db")

    all_subtasks = []
    seen_hashes = set()

    for sf, tcid, eid, caller_model, ts in rows:
        if not os.path.exists(sf):
            continue
        try:
            with open(sf, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    if tcid not in line:
                        continue
                    try:
                        record = json.loads(line)
                        msg = record.get('message', {})
                        for content in msg.get('content', []):
                            if content.get('type') == 'toolCall' and (content.get('id') == tcid or tcid in content.get('id', '')):
                                args = content.get('arguments', {})
                                if isinstance(args, str):
                                    try:
                                        args = json.loads(args)
                                    except:
                                        pass
                                if not isinstance(args, dict):
                                    continue

                                batch_context = args.get('context', '')
                                tasks = args.get('tasks', [])
                                if not isinstance(tasks, list):
                                    continue

                                for sub_idx, t in enumerate(tasks):
                                    if not isinstance(t, dict):
                                        continue
                                    
                                    task_text = t.get('task', '')
                                    if not task_text.strip():
                                        continue

                                    task_name = t.get('name', f"subtask_{sub_idx}")
                                    agent = t.get('agent')
                                    effort = t.get('effort')

                                    # Assemble delegated_assignment as per pi-harness extensions/subagent.mjs:478-481
                                    if batch_context.strip():
                                        delegated = f"# Batch context\n\n{batch_context.strip()}\n\n# Task\n\n{task_text.strip()}"
                                    else:
                                        delegated = f"# Task\n\n{task_text.strip()}"

                                    lang = 'zh' if is_chinese(delegated) else 'en'
                                    dt = datetime.fromtimestamp(ts / 1000.0).isoformat() if ts else ""

                                    item = {
                                        "id": f"omp_subtask_{len(all_subtasks) + 1:04d}",
                                        "timestamp": ts,
                                        "datetime": dt,
                                        "session_file": sf,
                                        "tool_call_id": tcid,
                                        "caller_model": caller_model,
                                        "batch_context": batch_context.strip(),
                                        "task_name": task_name,
                                        "task_text": task_text.strip(),
                                        "assigned_agent": agent,
                                        "effort": effort,
                                        "delegated_assignment": delegated,
                                        "language": lang,
                                        "char_length": len(delegated)
                                    }
                                    all_subtasks.append(item)
                    except Exception as e:
                        continue
        except Exception as e:
            continue

    print(f"Total extracted subtasks: {len(all_subtasks)}")
    
    with open(OUTPUT_ALL, 'w', encoding='utf-8') as f:
        json.dump(all_subtasks, f, ensure_ascii=False, indent=2)
    print(f"Saved all prompts to {OUTPUT_ALL}")

    return all_subtasks

def curate_benchmark_cases(all_subtasks):
    """
    Select high-quality, representative, distinct scenarios from the extracted OMP tasks.
    We classify tasks into:
    - Research/Investigation (code exploration, failure diagnosis, reverse engineering analysis) -> expected role: researcher
    - Concrete implementation/editing (bug fixing, feature implementation, refactoring) -> expected role: executor
    - Independent review/audit (code review, security review, factual verification) -> expected role: reviewer
    - Markdown documentation rewriting vs code writing -> expected model: gemini vs deepseek
    """
    # Pick a curated subset representing diverse domains and languages
    curated = []
    
    # We want a set of cases covering:
    # 1. EN Researcher: investigating/verifying installed Pi package APIs
    # 2. EN Executor: implementing code changes or patches
    # 3. EN Reviewer: independent code review or contract review
    # 4. EN Executor (Markdown/Doc): authoring documentation
    # 5. ZH Researcher: Linux kernel/driver or reverse engineering investigation
    # 6. ZH Executor: bug fix / code patch in project
    # 7. ZH Reviewer: code review or safety audit in Chinese
    # 8. Decompiled C code exploration (Novatek / Ghidra analysis)
    # 9. Windows debloating service audit
    # 10. Large batch context with targeted diagnostic task
    
    seen_signatures = set()
    
    for item in all_subtasks:
        text = item["delegated_assignment"]
        sig = text[:120]
        if sig in seen_signatures:
            continue

        agent = item["assigned_agent"]
        name = item["task_name"]
        lang = item["language"]
        task = item["task_text"]
        ctx = item["batch_context"]

        # Rule-based categorization for benchmark annotation
        expected_role = None
        expected_model = None
        category = None

        if agent == "reviewer" or "review" in name.lower() or "audit" in name.lower():
            if "fix" in task.lower() or "repair" in task.lower() or "apply" in task.lower():
                expected_role = "executor"
                expected_model = "deepseek"
                category = "repair_with_audit"
            else:
                expected_role = "reviewer"
                expected_model = "gemini"
                category = "independent_review"
        elif agent == "scout" or "verify" in name.lower() or "inspect" in name.lower() or "explore" in name.lower():
            if "modify" in ctx.lower() or "fix" in task.lower() or "patch" in task.lower():
                expected_role = "executor"
                expected_model = "deepseek"
                category = "investigate_and_fix"
            else:
                expected_role = "researcher"
                # If documentation or general reading/evidence
                expected_model = "gemini"
                category = "research_and_investigation"
        elif "doc" in name.lower() or "write" in name.lower() or "author" in name.lower():
            if "code" in task.lower() or ".py" in task.lower() or ".c" in task.lower() or ".mjs" in task.lower():
                expected_role = "executor"
                expected_model = "deepseek"
                category = "code_implementation"
            else:
                expected_role = "executor"
                expected_model = "gemini"
                category = "documentation_authoring"
        else:
            # Default or task
            if any(w in task.lower() for w in ["implement", "create", "write", "patch", "fix", "repair", "add"]):
                expected_role = "executor"
                expected_model = "gemini" if "document" in task.lower() or "markdown" in task.lower() else "deepseek"
                category = "execution"
            else:
                expected_role = "researcher"
                expected_model = "gemini"
                category = "investigation"

        # Check if this task is well-structured and interesting
        if len(task) > 150 and len(ctx) > 50:
            seen_signatures.add(sig)
            curated.append({
                "id": f"benchmark_{len(curated) + 1:02d}_{name.lower()[:20].replace(' ', '_')}",
                "source_omp_id": item["id"],
                "source_caller_model": item["caller_model"],
                "original_agent": agent,
                "language": lang,
                "category": category,
                "expected_role": expected_role,
                "expected_model": expected_model,
                "task_name": name,
                "batch_context": ctx,
                "task": task,
                "delegated_assignment": item["delegated_assignment"]
            })
            if len(curated) >= 16:
                break

    print(f"Curated {len(curated)} benchmark scenarios from real OMP history.")
    with open(OUTPUT_BENCHMARK, 'w', encoding='utf-8') as f:
        json.dump(curated, f, ensure_ascii=False, indent=2)
    print(f"Saved benchmark cases to {OUTPUT_BENCHMARK}")

if __name__ == "__main__":
    tasks = extract_all()
    curate_benchmark_cases(tasks)
