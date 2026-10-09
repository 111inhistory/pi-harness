import json,re,hashlib,statistics,collections
from pathlib import Path
root=Path('/tmp/pi-jev-english-tuned')
rows=json.loads((root/'results.json').read_text())
groups={
 'external_lookup':['actual_jev_documentation_assignment','benchmark_12_emitterprotocol','en_11_localsendupstream','omp_subtask_0152','omp_subtask_0180','omp_subtask_0181','omp_subtask_0269','omp_subtask_0270','omp_subtask_0301','omp_subtask_0302','omp_subtask_0311','omp_subtask_0346','omp_subtask_0347','omp_subtask_0367','omp_subtask_0410','omp_subtask_0281','omp_subtask_0271','omp_subtask_0316'],
 'local_fact_extraction':['actual_local_startup_assignment','trace_execution_modes','en_12_drmlink','omp_subtask_0177','omp_subtask_0280','omp_subtask_0284','omp_subtask_0310','omp_subtask_0397','omp_subtask_0400','omp_subtask_0286','omp_subtask_0300','omp_subtask_0063','omp_subtask_0309'],
 'existing_option_comparison':['en_10_workspaceresearch','omp_subtask_0053','omp_subtask_0154','omp_subtask_0155','omp_subtask_0332','omp_subtask_0334','omp_subtask_0336','omp_subtask_0337'],
 'text_work':['rewrite_user_documentation','omp_subtask_0390','omp_subtask_0077'],
}
by_id={r['id']:r for r in rows}
manual={}
for category,ids in groups.items():
 for id in ids:
  r=by_id[id];t=r['calls'][0]['request']['state']['delegated_assignment'];h=hashlib.sha256(t.encode()).hexdigest()
  assert h not in manual,(category,id)
  manual[h]={'category':category,'representative':id,'task':t,'selectedModel':r['model'],'role':r['role']}
for r in rows:
 t=r['calls'][0]['request']['state']['delegated_assignment'];h=hashlib.sha256(t.encode()).hexdigest()
 if h in manual:manual[h].setdefault('records',[]).append({'dataset':r['dataset'],'id':r['id'],'selectedModel':r['model']})
patterns={
 'accuracy_or_evidence':r'\b(exact|precise|accurate|evidence|verified|verify|authoritative|factual|grounded)\b',
 'urls_or_paths_or_symbols':r'\b(urls?|paths?|files?|symbols?|sha[s]?|commits?|sections?|page references)\b',
 'versions_dates_status':r'\b(versions?|dates?|status|compatibility|compatible|current|maintained|releases?|timestamps?)\b',
 'table_list_mapping_or_summary':r'\b(tables?|list|lists|shortlist|inventory|inventories|map|mapping|topology|summary|summaries|summariz\w*|bibliography|report|findings)\b',
 'explicit_unknown_or_no_speculation':r'\b(unknown|uncertain\w*|unavailable|not present|not establish|if no|if.*absent|no.*found|do not assume|do not speculate|not.*proof|distinguish|state whether)\b',
 'bounded_scope':r'\b(only|non-goals?|exclude|relevant|focus|no local changes|no changes|do not)\b',
}
values=list(manual.values())
lengths=[len(x['task']) for x in values]
summary={'definition':'Manual semantic judgment of clear Gemini-fit tasks under current user preference; not a label derived from JEV model choice. Exact assignment duplicates are merged. Borderline causal/safety/state-machine tasks are not counted as clear fits.',
 'unique_clear_fits':len(values),'dataset_records_with_these_assignments':sum(len(x['records']) for x in values),
 'categories':dict(collections.Counter(x['category'] for x in values)),
 'role_counts':dict(collections.Counter(x['role'] for x in values)),
 'length_chars':{'min':min(lengths),'median':statistics.median(lengths),'max':max(lengths)},
 'literal_feature_counts':{name:sum(bool(re.search(pattern,x['task'],re.I)) for x in values) for name,pattern in patterns.items()},
 'clear_fits_still_selected_deepseek':[{'id':x['representative'],'models':sorted(set(y['selectedModel'] for y in x['records']))} for x in values if any(y['selectedModel']=='deepseek' for y in x['records'])],
}
(root/'prompt-features.json').write_text(json.dumps({'summary':summary,'tasks':values},ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
