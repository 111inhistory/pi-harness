#!/usr/bin/env node
/**
 * Bounded performance check for the admission consolidation.
 *
 * Both arms read the *same* valid branch records and use the *same* admission
 * rule; they differ only in how often that rule is resolved:
 *   - "per name" is the removed shape: one scope view and one full branch scan
 *     for every tool name (a reference implementation kept here, not in product
 *     code);
 *   - "per operation" is the current shape: `createToolAdmission` once per
 *     operation, then a predicate per name.
 *
 * Every scenario first proves both arms admit exactly the same names and that
 * `discoveryRecords` really parsed the records; otherwise the comparison would
 * silently measure two different questions.
 *
 * Read counts and wall time answer different questions. Fixed read counts do not
 * imply constant total time, and the numbers are one host's median sample, not a
 * promise.
 *
 * Usage:
 *   node --import tsx scripts/capability-admission-bench.mjs [--json]
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { createToolAdmission, isMcpExecutionTool, isNativeDiscoveryTool } from '../src/capability/admission.ts';
import { discoveryRecords } from '../src/capability/discovery-record.ts';
import { manualToolMatcher } from '../src/capability/manual-tools.ts';
import {
  createCapabilityScopeView, setCapabilityParent, setCapabilityRootOnlyPolicy,
} from '../src/capability/scope.ts';

const json = process.argv.includes('--json');
const TOOL_COUNTS = [20, 60, 150];
const RECORD_COUNTS = [0, 10, 50];
const DEPTHS = [1, 3];
const ITERATIONS = 60;
const WARMUP = 10;
/** Every third manual record is a user enablement, so both manual answers occur. */
const MANUAL_EVERY = 3;

function countingHost(tools, counters) {
  return {
    getAllTools() {
      counters.getAllTools += 1;
      return tools;
    },
    getActiveTools() {
      counters.getActiveTools += 1;
      return tools.map((tool) => tool.name);
    },
  };
}

function countingBranch(records, counters) {
  return new Proxy(records, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) {
        counters.branchScans += 1;
        return target[Symbol.iterator].bind(target);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/** One valid `capability-discovery` entry, the shape `discoveryRecords` parses. */
function recordEntry(index) {
  return {
    type: 'custom',
    customType: 'capability-discovery',
    data: {
      version: 1,
      result: {
        status: 'ok',
        tools: [{ ref: `tool://fixture_${index}`, name: `fixture_${index}`, kind: 'tool', status: 'available' }],
        mcp: [{
          ref: `namespace://mcp__fixture_${index}`,
          name: `mcp__fixture_${index}`,
          kind: 'mcp',
          status: 'available',
          tools: [{ ref: `mcp://fixture_${index}/op`, name: `mcp__fixture_${index}__op`, exposure: 'deferred' }],
        }],
        skills: [],
        ...(index % MANUAL_EVERY === 0
          ? { manual: [{ ref: `tool://manual_${index}`, name: `manual_${index}`, kind: 'tool', status: 'available' }] }
          : {}),
        coverage: { local: 'searched', remote: 'not_searched' },
      },
    },
  };
}

/** Plain, MCP and manual tools, so the sample covers all three admission paths. */
function tools(count) {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    list.push({ name: `fixture_${index}`, description: 'fixture tool', exposure: 'direct' });
  }
  for (let index = 0; index < count; index += 1) {
    list.push({ name: `mcp__fixture_${index}__op`, description: 'fixture MCP tool', exposure: 'deferred' });
  }
  for (let index = 0; index < count; index += 1) {
    list.push({ name: `manual_${index}`, description: 'fixture manual tool', exposure: 'direct' });
  }
  return list;
}

/**
 * The shared admission rule, written once. Both arms call it; only the number of
 * resolutions differs.
 */
function admits(view, selected, manual, rootOnly, name) {
  const admitsManual = rootOnly === null || !rootOnly(name) || (view.root && manual.has(name));
  return !isNativeDiscoveryTool(name)
    && view.allows(name)
    && (!isMcpExecutionTool(name) || selected.has(name))
    && admitsManual;
}

function scan(branch) {
  const selected = new Set();
  const manual = new Set();
  for (const record of discoveryRecords(branch)) {
    for (const category of ['tools', 'mcp', 'manual']) {
      for (const hit of record.result[category] ?? []) {
        for (const member of hit.tools ?? [hit]) {
          if (typeof member.name !== 'string' || member.name === '') continue;
          selected.add(member.name);
          if (category === 'manual') manual.add(member.name);
        }
      }
    }
  }
  return { selected, manual };
}

/** Pre-consolidation shape: resolve the scope and rescan the branch per name. */
function perName(catalog, branch, names, counters) {
  const admitted = [];
  for (const name of names) {
    const view = createCapabilityScopeView(catalog);
    const { selected, manual } = scan(branch);
    if (admits(view, selected, manual, view.rootOnly, name)) admitted.push(name);
  }
  counters.admitted += admitted.length;
  return admitted;
}

/** Consolidated shape: one view per operation, predicates per name. */
function perOperation(catalog, branch, names, counters) {
  const admission = createToolAdmission(catalog, branch);
  const admitted = names.filter((name) => admission.admits(name));
  counters.admitted += admitted.length;
  return admitted;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(run) {
  const samples = [];
  for (let index = 0; index < WARMUP; index += 1) run();
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const rows = [];
for (const depth of DEPTHS) {
  for (const toolCount of TOOL_COUNTS) {
    for (const recordCount of RECORD_COUNTS) {
      const branchRecords = Array.from({ length: recordCount }, (_, index) => recordEntry(index));
      const names = tools(toolCount).map((tool) => tool.name);

      // Correctness before timing: both arms must see parsed records and agree.
      const checkCounters = { getAllTools: 0, getActiveTools: 0, branchScans: 0, admitted: 0 };
      const checkCatalog = countingHost(tools(toolCount), checkCounters);
      const checkBranch = countingBranch(branchRecords, checkCounters);
      const parsed = discoveryRecords(checkBranch).length;
      assert.equal(parsed, recordCount, `depth ${depth}: every record must parse`);
      let checkRoot = checkCatalog;
      setCapabilityRootOnlyPolicy(checkRoot, manualToolMatcher(['manual_*']));
      for (let level = 1; level < depth; level += 1) {
        const child = countingHost(tools(toolCount), checkCounters);
        setCapabilityParent(child, checkRoot);
        checkRoot = child;
      }
      const reference = perName(checkRoot, checkBranch, names, { admitted: 0 });
      const current = perOperation(checkRoot, checkBranch, names, { admitted: 0 });
      assert.deepEqual([...current].sort(), [...reference].sort(),
        `depth ${depth} tools ${toolCount} records ${recordCount}: both arms must admit the same names`);
      assert.ok(reference.includes('fixture_0'), 'a plain tool is admitted');
      if (recordCount > 0) {
        assert.ok(reference.includes('mcp__fixture_0__op'), 'the parsed MCP member is admitted');
      } else {
        assert.ok(!reference.includes('mcp__fixture_0__op'), 'an unselected MCP tool is refused');
      }
      if (depth === 1) {
        assert.equal(reference.includes('manual_0'), recordCount > 0,
          'a root manual tool needs the user record');
      } else {
        assert.ok(!reference.includes('manual_0'), 'a child scope never admits a manual tool');
      }

      for (const arm of ['per-name', 'per-operation']) {
        const counters = { getAllTools: 0, getActiveTools: 0, branchScans: 0, admitted: 0 };
        const catalog = countingHost(tools(toolCount), counters);
        const branch = countingBranch(branchRecords, counters);
        let root = catalog;
        setCapabilityRootOnlyPolicy(root, manualToolMatcher(['manual_*']));
        for (let level = 1; level < depth; level += 1) {
          const child = countingHost(tools(toolCount), counters);
          setCapabilityParent(child, root);
          root = child;
        }
        const before = { ...counters };
        const elapsed = measure(() => (arm === 'per-name' ? perName : perOperation)(root, branch, names, counters));
        const iterations = ITERATIONS + WARMUP;
        rows.push({
          depth,
          tools: toolCount * 3,
          records: recordCount,
          arm,
          admitted: reference.length,
          ms: Number(elapsed.toFixed(3)),
          getAllToolsPerOp: Number(((counters.getAllTools - before.getAllTools) / iterations).toFixed(2)),
          getActiveToolsPerOp: Number(((counters.getActiveTools - before.getActiveTools) / iterations).toFixed(2)),
          branchScansPerOp: Number(((counters.branchScans - before.branchScans) / iterations).toFixed(2)),
        });
      }
    }
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify({ iterations: ITERATIONS, warmup: WARMUP, rows }, null, 2)}\n`);
} else {
  process.stdout.write(`iterations=${ITERATIONS} warmup=${WARMUP} (median ms per operation; both arms admit the same names)\n`);
  process.stdout.write('depth tools records arm            admitted      ms   getAll getActive branchScans\n');
  for (const row of rows) {
    process.stdout.write(
      `${String(row.depth).padStart(5)} ${String(row.tools).padStart(5)} ${String(row.records).padStart(7)} `
      + `${row.arm.padEnd(15)} ${String(row.admitted).padStart(8)} ${String(row.ms).padStart(7)} `
      + `${String(row.getAllToolsPerOp).padStart(8)} ${String(row.getActiveToolsPerOp).padStart(9)} `
      + `${String(row.branchScansPerOp).padStart(11)}\n`,
    );
  }
}
