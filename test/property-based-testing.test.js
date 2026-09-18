import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import { validateAgentWorker } from "../scripts/agent-worker.js";
import {
  getAgentTask,
  openAgentTaskRegistry,
  registerAgentTask,
  transitionAgentTask,
} from "../scripts/agent-task-registry.js";
import {
  fastCheck as fc,
  formatPropertyTestResult,
  runCustomProperty,
  runNumericInvariantProperty,
  runPolicyProperty,
  runStateTransitionProperty,
  runValidatorProperty,
  validatePropertyTestPolicy,
} from "../scripts/property-based-testing.js";

const BASE_TIME = Date.parse("2026-09-18T03:00:00Z");
function rawPolicy(overrides = {}) {
  return {
    version: 1,
    seed: 424242,
    numRuns: 100,
    maxSkipsPerRun: 100,
    path: null,
    ...overrides,
  };
}

/** @param {string} id */
function taskValue(id = "task:property") {
  return {
    version: 1,
    id,
    role: "diagnose",
    repository: { id: "demo-repo", baseCommit: "a".repeat(40) },
    createdAt: "2026-09-18T03:00:00Z",
    risk: "LOW",
    objective: "Exercise explicit state transition properties",
    authority: {
      filesystem: "READ_ONLY",
      shell: "NONE",
      network: "NONE",
      merge: false,
      deploy: false,
      productionMutation: false,
    },
    scope: {
      allowedPaths: ["src/**"],
      deniedPaths: [],
      requiredChecks: ["test"],
    },
    dependsOn: [],
  };
}
const STATES = [
  "QUEUED",
  "ROUTED",
  "RUNNING",
  "WAITING_REVIEW",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
  "SUPERSEDED",
];

const ALLOWED = new Map([
  ["QUEUED", new Set(["ROUTED", "BLOCKED", "FAILED", "CANCELLED", "SUPERSEDED"])],
  ["ROUTED", new Set(["QUEUED", "RUNNING", "BLOCKED", "FAILED", "CANCELLED", "SUPERSEDED"])],
  ["RUNNING", new Set(["WAITING_REVIEW", "COMPLETED", "BLOCKED", "FAILED", "CANCELLED"])],
  ["WAITING_REVIEW", new Set(["COMPLETED", "BLOCKED", "FAILED", "CANCELLED"])],
  ["BLOCKED", new Set(["QUEUED", "CANCELLED", "SUPERSEDED"])],
  ["FAILED", new Set(["QUEUED", "CANCELLED", "SUPERSEDED"])],
  ["COMPLETED", new Set()],
  ["CANCELLED", new Set()],
  ["SUPERSEDED", new Set()],
]);

/** @type {Record<string,string[]>} */
const PATH_TO = {
  QUEUED: [],
  ROUTED: ["ROUTED"],
  RUNNING: ["ROUTED", "RUNNING"],
  WAITING_REVIEW: ["ROUTED", "RUNNING", "WAITING_REVIEW"],
  BLOCKED: ["BLOCKED"],
  FAILED: ["FAILED"],
  COMPLETED: ["ROUTED", "RUNNING", "COMPLETED"],
  CANCELLED: ["CANCELLED"],
  SUPERSEDED: ["SUPERSEDED"],
};
/** @param {number} offset */
function iso(offset) {
  return new Date(BASE_TIME + offset * 1000).toISOString();
}

/** @param {string} target */
function registryAtState(target) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "property-registry-"));
  const file = path.join(root, "control.sqlite");
  const db = openAgentTaskRegistry(file);
  const task = taskValue();
  registerAgentTask(db, task, iso(0));
  let state = "QUEUED";
  let revision = 0;
  let offset = 1;
  for (const next of PATH_TO[target] ?? []) {
    transitionAgentTask(db, {
      taskId: task.id,
      fromState: state,
      toState: next,
      expectedRevision: revision,
      at: iso(offset),
    });
    state = next;
    revision += 1;
    offset += 1;
  }
  return { root, db, task, state, revision, offset };
}
test("Property Test Policy v1 is deterministic and bounded", () => {
  const valid = validatePropertyTestPolicy(rawPolicy());
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  assert.equal(valid.policy?.seed, 424242);
  assert.equal(valid.policy?.path, null);

  for (const invalid of [
    { ...rawPolicy(), seed: 2 ** 40 },
    { ...rawPolicy(), numRuns: 0 },
    { ...rawPolicy(), maxSkipsPerRun: -1 },
    { ...rawPolicy(), path: "../bad" },
    { ...rawPolicy(), timeoutMs: 1000 },
  ]) {
    assert.equal(validatePropertyTestPolicy(invalid).valid, false);
  }
});

test("failing property exposes deterministic replay coordinates but no raw counterexample", () => {
  const property = {
    id: "synthetic-less-than-ten",
    arbitraries: [fc.integer({ min: 0, max: 100 })],
    predicate: (/** @type {number} */ value) => value < 10,
  };
  const first = runCustomProperty(rawPolicy({ numRuns: 50 }), property);
  assert.equal(first.status, "FAIL");
  assert.equal(first.replay?.seed, first.run.seed);
  assert.ok(first.replay?.path);
  assert.equal(first.counterexampleStored, false);
  assert.equal(first.errorStored, false);
  assert.equal("counterexample" in first, false);

  const replay = runCustomProperty(
    rawPolicy({ seed: first.replay.seed, path: first.replay.path, numRuns: 50 }),
    property,
  );
  assert.equal(replay.status, "FAIL");
  assert.equal(replay.run.counterexamplePath, first.run.counterexamplePath);
});
test("Agent Task validator is total over JSON and canonical output is idempotent", () => {
  const report = runValidatorProperty(rawPolicy({ numRuns: 250 }), {
    id: "agent-task-validator-totality",
    arbitraries: [fc.jsonValue()],
    predicate: (value) => {
      const result = validateAgentTask(value);
      if (!result.valid || !result.task) return true;
      const again = validateAgentTask(result.task);
      return again.valid
        && again.task !== null
        && JSON.stringify(again.task) === JSON.stringify(result.task);
    },
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.property.category, "VALIDATOR");
  assert.equal(report.run.numRuns, 250);
});

test("Agent Role Policy canonical output is idempotent over arbitrary JSON", () => {
  const report = runPolicyProperty(rawPolicy({ numRuns: 250 }), {
    id: "agent-role-policy-idempotence",
    arbitraries: [fc.jsonValue()],
    predicate: (value) => {
      const result = validateAgentRolePolicy(value);
      if (!result.valid || !result.policy) return true;
      const again = validateAgentRolePolicy(result.policy);
      return again.valid
        && again.policy !== null
        && JSON.stringify(again.policy) === JSON.stringify(result.policy);
    },
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.property.category, "POLICY");
});
test("Task Registry enforces the explicit transition matrix for generated state pairs", () => {
  const report = runStateTransitionProperty(rawPolicy({ numRuns: 80 }), {
    id: "agent-task-transition-matrix",
    arbitraries: [fc.constantFrom(...STATES), fc.constantFrom(...STATES)],
    predicate: (fromState, toState) => {
      const fixture = registryAtState(fromState);
      try {
        const before = getAgentTask(fixture.db, fixture.task.id);
        const allowed = ALLOWED.get(fromState)?.has(toState) ?? false;
        let succeeded = false;
        try {
          transitionAgentTask(fixture.db, {
            taskId: fixture.task.id,
            fromState,
            toState,
            expectedRevision: fixture.revision,
            at: iso(fixture.offset + 1),
          });
          succeeded = true;
        } catch {
          succeeded = false;
        }
        const after = getAgentTask(fixture.db, fixture.task.id);
        if (allowed !== succeeded) return false;
        if (!allowed) {
          return after?.state === before?.state
            && after?.revision === before?.revision
            && after?.attemptCount === before?.attemptCount;
        }
        return after?.state === toState
          && after?.revision === fixture.revision + 1;
      } finally {
        fixture.db.close();
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.property.category, "STATE_TRANSITION");
});
test("Agent Worker validity follows declared numeric read and write capacities", () => {
  const report = runNumericInvariantProperty(rawPolicy({ numRuns: 200 }), {
    id: "agent-worker-load-capacity",
    arbitraries: [
      fc.integer({ min: 1, max: 32 }),
      fc.integer({ min: 0, max: 8 }),
      fc.integer({ min: 0, max: 40 }),
      fc.integer({ min: 0, max: 12 }),
    ],
    predicate: (maxRead, maxWrite, readOnlyTasks, writeTasks) => {
      const raw = {
        version: 1,
        id: "worker:property",
        class: "COMPUTE",
        state: "ONLINE",
        observedAt: "2026-09-18T03:00:00Z",
        resources: {
          cpuCores: 8,
          memoryMiB: 16384,
          gpu: null,
        },
        capabilities: ["git"],
        execution: {
          worktrees: true,
          maxReadOnlyTasks: maxRead,
          maxWriteTasks: maxWrite,
        },
        load: { readOnlyTasks, writeTasks },
        models: [],
      };
      const result = validateAgentWorker(raw);
      const expected = readOnlyTasks <= maxRead && writeTasks <= maxWrite;
      return result.valid === expected;
    },
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.property.category, "NUMERIC_INVARIANT");
});
test("category adapters preserve one common result contract", () => {
  const arbitrary = [fc.boolean()];
  const predicate = () => true;
  const reports = [
    runValidatorProperty(rawPolicy({ numRuns: 5 }), { id: "validator-demo", arbitraries: arbitrary, predicate }),
    runPolicyProperty(rawPolicy({ numRuns: 5 }), { id: "policy-demo", arbitraries: arbitrary, predicate }),
    runStateTransitionProperty(rawPolicy({ numRuns: 5 }), { id: "transition-demo", arbitraries: arbitrary, predicate }),
    runNumericInvariantProperty(rawPolicy({ numRuns: 5 }), { id: "numeric-demo", arbitraries: arbitrary, predicate }),
    runCustomProperty(rawPolicy({ numRuns: 5 }), { id: "custom-demo", arbitraries: arbitrary, predicate }),
  ];
  assert.deepEqual(
    reports.map((report) => report.property.category),
    ["VALIDATOR", "POLICY", "STATE_TRANSITION", "NUMERIC_INVARIANT", "CUSTOM"],
  );
  assert.equal(reports.every((report) => report.status === "PASS"), true);
  assert.equal(reports.every((report) => report.execution.shell === false), true);
  assert.equal(reports.every((report) => report.execution.network === false), true);
});

test("invalid predicate return becomes a property failure and arbitrary surface is bounded", () => {
  const badReturn = runCustomProperty(rawPolicy({ numRuns: 5 }), {
    id: "bad-return",
    arbitraries: [fc.boolean()],
    predicate: /** @type {any} */ (() => "yes"),
  });
  assert.equal(badReturn.status, "FAIL");
  assert.equal(badReturn.errorStored, false);
  assert.throws(
    () => runCustomProperty(rawPolicy(), {
      id: "no-arbitrary",
      arbitraries: [],
      predicate: () => true,
    }),
    /between one and eight/,
  );
});
test("human report contains replay metadata but no raw counterexample or error", () => {
  const result = runCustomProperty(rawPolicy({ numRuns: 20 }), {
    id: "format-demo",
    arbitraries: [fc.integer({ min: 0, max: 2 })],
    predicate: (value) => value < 1,
  });
  const output = formatPropertyTestResult(result);
  assert.match(output, /Property Test Result v1/);
  assert.match(output, /Seed:/);
  assert.match(output, /Counterexample path:/);
  assert.match(output, /Raw counterexample stored: false/);
  assert.doesNotMatch(output, /\[[0-9,\s-]+\]/);
});

test("property adapter source has no filesystem network subprocess or implicit clock surface", () => {
  const source = fs.readFileSync(
    new URL("../scripts/property-based-testing.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs|node:child_process|fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /Date\.now\(\)|process\.env/);
  assert.match(source, /from "fast-check"/);
  assert.match(source, /counterexampleStored: false/);
});
