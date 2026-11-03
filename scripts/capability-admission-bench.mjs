#!/usr/bin/env node
/**
 * Bounded performance check for the admission consolidation.
 *
 * Compares the pre-consolidation shape (a scope view and a full branch scan per
 * tool name) with the consolidated shape (one admission view per operation plus
 * per-name predicates) across tool counts, branch record counts and chain depth.
 *
 * It measures two things that answer different questions:
 *   - read counts: how many catalog and branch reads one operation performs;
 *   - wall time: what that costs on this machine. Fixed read counts do not imply
 *     constant total time, and the numbers below are a single-host sample, not a
 *     promise.
 *
 * The "per name" arm is a reference implementation of the removed shape, kept
 * here instead of in the product. No caching, telemetry or benchmark dependency.
 *
 * Usage:
 *   node --import tsx scripts/capability-admission-bench.mjs [--json]
 */
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { createToolAdmission } from '../src/capability/admission.ts';
import { createCapabilityScopeView, setCapabilityParent } from '../src/capability/scope.ts';

const json = process.argv.includes('--json');
const TOOL_COUNTS = [50, 200, 800];
const RECORD_COUNTS = [0, 10, 50];
const DEPTHS = [1, 3];
const ITERATIONS = 120;
const WARMUP = 20;

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
        counters.branchIterations += 1;
        return target[Symbol.iterator].bind(target);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

function record(index) {
  return {
    version: 1,
    result: {
      tools: [{ ref: `tool://fixture_${index}`, name: `fixture_${index}`, kind: 'tool', status: 'available' }],
      mcp: [{
        ref: `namespace://mcp__fixture_${index}`, name: `mcp__fixture_${index}`, kind: 'mcp', status: 'available',
        tools: [{ ref: `mcp://fixture_${index}/op`, name: `mcp__fixture_${index}__op`, exposure: 'deferred' }],
      }],
      manual: [{ ref: `tool://manual_${index}`, name: `manual_${index}`, kind: 'tool', status: 'available' }],
    },
  };
}

function tools(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `fixture_${index}`,
    description: 'fixture tool',
    exposure: 'direct',
  }));
}

/** Pre-consolidation shape: resolve the scope and rescan the branch for each name. */
function perName(catalog, branch, names, counters) {
  let admitted = 0;
  for (const name of names) {
    const view = createCapabilityScopeView(catalog);
    const selected = new Set();
    for (const entry of branch) {
      for (const category of ['tools', 'mcp', 'manual']) {
        for (const hit of entry.result[category] ?? []) {
          for (const member of hit.tools ?? [hit]) selected.add(member.name);
        }
      }
    }
    if (view.allows(name) && selected.has(name)) admitted += 1;
  }
  counters.admitted += admitted;
}

/** Consolidated shape: one view per operation, predicates per name. */
function perOperation(catalog, branch, names, counters) {
  const admission = createToolAdmission(catalog, branch);
  let admitted = 0;
  for (const name of names) if (admission.declares(name)) admitted += 1;
  counters.admitted += admitted;
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
      const branchRecords = Array.from({ length: recordCount }, (_, index) => record(index));
      for (const arm of ['per-name', 'per-operation']) {
        const counters = { getAllTools: 0, getActiveTools: 0, branchIterations: 0, admitted: 0 };
        const catalog = countingHost(tools(toolCount), counters);
        const branch = countingBranch(branchRecords, counters);
        let root = catalog;
        if (depth > 1) {
          for (let level = 1; level < depth; level += 1) {
            const child = countingHost(tools(toolCount), counters);
            setCapabilityParent(child, root);
            root = child;
          }
        }
        const names = tools(toolCount).map((tool) => tool.name);
        const countersBefore = { ...counters };
        const elapsed = measure(() => (arm === 'per-name' ? perName : perOperation)(root, branch, names, counters));
        const iterations = ITERATIONS + WARMUP;
        rows.push({
          depth,
          tools: toolCount,
          records: recordCount,
          arm,
          ms: Number(elapsed.toFixed(3)),
          getAllToolsPerOp: Number(((counters.getAllTools - countersBefore.getAllTools) / iterations).toFixed(2)),
          getActiveToolsPerOp: Number(((counters.getActiveTools - countersBefore.getActiveTools) / iterations).toFixed(2)),
          branchScansPerOp: Number(((counters.branchIterations - countersBefore.branchIterations) / iterations).toFixed(2)),
        });
      }
    }
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify({
    iterations: ITERATIONS, warmup: WARMUP, rows,
  }, null, 2)}\n`);
} else {
  process.stdout.write(`iterations=${ITERATIONS} warmup=${WARMUP} (median ms per operation)\n`);
  process.stdout.write('depth tools records arm            ms      getAll  getActive  branchScans\n');
  for (const row of rows) {
    process.stdout.write(
      `${String(row.depth).padStart(5)} ${String(row.tools).padStart(5)} ${String(row.records).padStart(7)} `
      + `${row.arm.padEnd(15)} ${String(row.ms).padStart(8)} ${String(row.getAllToolsPerOp).padStart(7)} `
      + `${String(row.getActiveToolsPerOp).padStart(10)} ${String(row.branchScansPerOp).padStart(12)}\n`,
    );
  }
}
