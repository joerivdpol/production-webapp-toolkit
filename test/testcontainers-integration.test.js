import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { GenericContainer } from "testcontainers";

import {
  formatTestcontainersEvidence,
  main,
  smokeTestcontainersScenario,
  validateTestcontainersScenarioPolicy,
  withSyntheticTestcontainers,
} from "../scripts/testcontainers-integration.js";

const COLLECTED = "2026-09-19T00:30:00Z";

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testcontainers-integration-"));
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

/** @param {string} commit @param {Partial<any>} [overrides] @returns {any} */
function rawPolicy(commit, overrides = {}) {
  return {
    version: 1,
    repository: { id: "demo-repo", commit },
    testcontainersVersion: "12.1.0",
    scenarioId: "scenario:integration",
    dataClassification: "SYNTHETIC_ONLY",
    startupTimeoutMs: 30000,
    containers: [
      {
        id: "cache",
        image: "redis:7.4-alpine",
        exposedPorts: [6379],
        environment: [],
      },
      {
        id: "database",
        image: "postgres:17-alpine",
        exposedPorts: [5432],
        environment: [
          { key: "POSTGRES_USER", value: "synthetic_user", classification: "SYNTHETIC" },
          { key: "POSTGRES_PASSWORD", value: "synthetic_test_only_password", classification: "SYNTHETIC" },
          { key: "POSTGRES_DB", value: "synthetic_database", classification: "SYNTHETIC" },
        ],
      },
    ],
    ...overrides,
  };
}
/** @param {{failStartIndex?:number,failStopIndex?:number}} [options] @returns {any} */
function fakeRuntime(options = {}) {
  /** @type {any[]} */ const events = [];
  let builderIndex = 0;
  class FakeStarted {
    /** @param {number} index @param {any} config */
    constructor(index, config) { this.index = index; this.config = config; }
    getHost() { return "private-runtime-host"; }
    /** @param {number} port */
    getMappedPort(port) { return 20000 + this.index * 1000 + port % 1000; }
    async stop() {
      events.push(["stop", this.index]);
      if (options.failStopIndex === this.index) throw new Error("synthetic stop failure");
    }
  }
  class FakeGenericContainer {
    /** @param {string} image */
    constructor(image) {
      this.index = builderIndex++;
      /** @type {any} */ this.config = { image, ports: [], environment: {}, timeout: null, wait: null };
      events.push(["construct", this.index, image]);
    }
    /** @param {...number} ports */
    withExposedPorts(...ports) { this.config.ports = ports; events.push(["ports", this.index, [...ports]]); return this; }
    /** @param {number} timeout */
    withStartupTimeout(timeout) { this.config.timeout = timeout; events.push(["timeout", this.index, timeout]); return this; }
    /** @param {any} wait */
    withWaitStrategy(wait) { this.config.wait = wait; events.push(["wait", this.index]); return this; }
    /** @param {Record<string,string>} environment */
    withEnvironment(environment) { this.config.environment = { ...environment }; events.push(["environment", this.index, { ...environment }]); return this; }
    async start() {
      events.push(["start", this.index]);
      if (options.failStartIndex === this.index) throw new Error("synthetic start failure");
      return new FakeStarted(this.index, this.config);
    }
  }
  return {
    events,
    dependencies: {
      GenericContainer: FakeGenericContainer,
      Wait: { forListeningPorts: () => ({ kind: "listening-ports" }) },
    },
  };
}

test("policy accepts bounded synthetic services with explicit image versions", () => {
  const result = validateTestcontainersScenarioPolicy(rawPolicy("a".repeat(40)));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.policy?.containers.length, 2);
  assert.equal(result.policy?.containers[0].id, "cache");
  assert.equal(result.policy?.containers[1].environment.length, 3);
});

test("policy accepts immutable image digest references", () => {
  const raw = rawPolicy("a".repeat(40));
  raw.containers = [{
    id: "service",
    image: "registry.example.invalid/service@sha256:" + "b".repeat(64),
    exposedPorts: [8080],
    environment: [],
  }];
  assert.equal(validateTestcontainersScenarioPolicy(raw).valid, true);
});

test("policy rejects latest untagged fixed-port-like objects and non-synthetic environment", () => {
  const base = "a".repeat(40);
  const cases = [];
  const latest = rawPolicy(base); latest.containers[0].image = "redis:latest"; cases.push(latest);
  const untagged = rawPolicy(base); untagged.containers[0].image = "redis"; cases.push(untagged);
  const fixed = rawPolicy(base); fixed.containers[0].exposedPorts = [{ container: 6379, host: 6379 }]; cases.push(fixed);
  const secret = rawPolicy(base); secret.containers[1].environment[0].value = "real_user"; cases.push(secret);
  const host = rawPolicy(base); host.containers[0].hostNetwork = true; cases.push(host);
  const privileged = rawPolicy(base); privileged.containers[0].privileged = true; cases.push(privileged);
  for (const candidate of cases) assert.equal(validateTestcontainersScenarioPolicy(candidate).valid, false);
});

test("policy rejects duplicate ids ports env keys and unsupported version", () => {
  const base = "a".repeat(40);
  const duplicateId = rawPolicy(base); duplicateId.containers[1].id = "cache";
  const duplicatePort = rawPolicy(base); duplicatePort.containers[0].exposedPorts = [6379, 6379];
  const duplicateEnv = rawPolicy(base); duplicateEnv.containers[1].environment.push({ ...duplicateEnv.containers[1].environment[0] });
  const version = rawPolicy(base, { testcontainersVersion: "11.0.0" });
  for (const candidate of [duplicateId, duplicatePort, duplicateEnv, version]) {
    assert.equal(validateTestcontainersScenarioPolicy(candidate).valid, false);
  }
});

test("callback receives private connection data while evidence omits host and env values", async () => {
  const repo = repository(), runtime = fakeRuntime();
  try {
    /** @type {any} */ let callbackRuntime = null;
    const output = await withSyntheticTestcontainers(
      repo.root,
      rawPolicy(repo.commit),
      COLLECTED,
      async (value) => { callbackRuntime = value; return "done"; },
      runtime.dependencies,
    );
    assert.equal(output.result, "done");
    assert.equal(callbackRuntime.containers[0].host, "private-runtime-host");
    assert.equal(callbackRuntime.containers[0].ports[0].mappedPort > 0, true);
    assert.equal(output.evidence.cleanup.status, "PASS");
    assert.equal(output.evidence.cleanup.stopped, 2);
    assert.equal(output.evidence.executionPerformed, true);
    assert.equal(output.evidence.fixedHostPortsConfigured, false);
    assert.equal(output.evidence.hostNetworkConfigured, false);
    assert.equal(output.evidence.privilegedModeConfigured, false);
    assert.equal(output.evidence.bindMountsConfigured, false);
    assert.equal(output.evidence.productionDataAuthorized, false);
    const serialized = JSON.stringify(output.evidence);
    assert.doesNotMatch(serialized, /private-runtime-host|synthetic_test_only_password|synthetic_user|POSTGRES_PASSWORD/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("builder receives only exposed ports timeout listening wait and synthetic environment", async () => {
  const repo = repository(), runtime = fakeRuntime();
  try {
    await smokeTestcontainersScenario(repo.root, rawPolicy(repo.commit), COLLECTED, runtime.dependencies);
    const names = runtime.events.map((/** @type {any} */ event) => event[0]);
    assert.deepEqual(names.filter((/** @type {any} */ name) => name === "start").length, 2);
    assert.equal(names.includes("bind"), false);
    assert.equal(names.includes("privileged"), false);
    assert.equal(names.includes("network"), false);
    const environmentEvent = runtime.events.find((/** @type {any} */ event) => event[0] === "environment");
    assert.deepEqual(environmentEvent?.[2], {
      POSTGRES_DB: "synthetic_database",
      POSTGRES_PASSWORD: "synthetic_test_only_password",
      POSTGRES_USER: "synthetic_user",
    });
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});
test("containers stop in reverse order after successful callback", async () => {
  const repo = repository(), runtime = fakeRuntime();
  try {
    await withSyntheticTestcontainers(repo.root, rawPolicy(repo.commit), COLLECTED, async () => null, runtime.dependencies);
    assert.deepEqual(runtime.events.filter((/** @type {any} */ event) => event[0] === "stop"), [["stop", 1], ["stop", 0]]);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("callback failure still cleans every started container", async () => {
  const repo = repository(), runtime = fakeRuntime();
  try {
    await assert.rejects(
      withSyntheticTestcontainers(repo.root, rawPolicy(repo.commit), COLLECTED, async () => { throw new Error("private callback details"); }, runtime.dependencies),
      /callback failed after cleanup/,
    );
    assert.deepEqual(runtime.events.filter((/** @type {any} */ event) => event[0] === "stop"), [["stop", 1], ["stop", 0]]);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("partial startup failure cleans already-started services", async () => {
  const repo = repository(), runtime = fakeRuntime({ failStartIndex: 1 });
  try {
    await assert.rejects(
      withSyntheticTestcontainers(repo.root, rawPolicy(repo.commit), COLLECTED, async () => null, runtime.dependencies),
      /service failed to start/,
    );
    assert.deepEqual(runtime.events.filter((/** @type {any} */ event) => event[0] === "stop"), [["stop", 0]]);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("cleanup failure is blocking even when callback passes", async () => {
  const repo = repository(), runtime = fakeRuntime({ failStopIndex: 0 });
  try {
    await assert.rejects(
      withSyntheticTestcontainers(repo.root, rawPolicy(repo.commit), COLLECTED, async () => "ok", runtime.dependencies),
      /cleanup failed/,
    );
    assert.deepEqual(runtime.events.filter((/** @type {any} */ event) => event[0] === "stop"), [["stop", 1], ["stop", 0]]);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("exact repository commit and clean worktree are required before container start", async () => {
  const repo = repository(), runtime = fakeRuntime();
  try {
    await assert.rejects(
      smokeTestcontainersScenario(repo.root, rawPolicy("b".repeat(40)), COLLECTED, runtime.dependencies),
      /HEAD does not match/,
    );
    fs.writeFileSync(path.join(repo.root, "dirty.txt"), "dirty\n");
    await assert.rejects(
      smokeTestcontainersScenario(repo.root, rawPolicy(repo.commit), COLLECTED, runtime.dependencies),
      /must be clean/,
    );
    assert.equal(runtime.events.length, 0);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("framework import matches pinned public Testcontainers API", () => {
  assert.equal(typeof GenericContainer, "function");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies.testcontainers, "12.1.0");
});

test("human evidence contains service identity but no private runtime host", async () => {
  const repo = repository(), runtime = fakeRuntime();
  try {
    const evidence = await smokeTestcontainersScenario(repo.root, rawPolicy(repo.commit), COLLECTED, runtime.dependencies);
    const output = formatTestcontainersEvidence(evidence);
    assert.match(output, /Testcontainers Integration Evidence v1/);
    assert.match(output, /redis:7.4-alpine/);
    assert.match(output, /Cleanup: PASS/);
    assert.doesNotMatch(output, /private-runtime-host|synthetic_test_only_password/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("CLI validates explicit policy and rejects unknown arguments without Docker execution", async () => {
  const repo = repository(), policyFile = path.join(repo.root, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify(rawPolicy(repo.commit)));
  const originalLog = console.log, originalError = console.error; console.log = () => {}; console.error = () => {};
  try {
    assert.equal(await main(["validate", "--policy", policyFile, "--json"]), 0);
    assert.equal(await main(["validate", "--unknown", "x"]), 1);
  } finally { console.log = originalLog; console.error = originalError; fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("integration source has no private host socket bind privileged or fixed-port surface", () => {
  const source = fs.readFileSync(new URL("../scripts/testcontainers-integration.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DOCKER_HOST|docker\.sock|ssh:\/\/|withBindMounts|withPrivilegedMode|withNetworkMode|withFixedExposedPort|process\.env/);
  assert.doesNotMatch(source, /localhost:\d+|127\.0\.0\.1:\d+/);
  assert.match(source, /withExposedPorts/);
  assert.match(source, /withWaitStrategy/);
});

test("collectedAt is explicit and callback is mandatory", async () => {
  const repo = repository(), runtime = fakeRuntime();
  try {
    await assert.rejects(withSyntheticTestcontainers(repo.root, rawPolicy(repo.commit), "not-time", async () => null, runtime.dependencies), /absolute ISO/);
    await assert.rejects(withSyntheticTestcontainers(repo.root, rawPolicy(repo.commit), COLLECTED, /** @type {any} */ (null), runtime.dependencies), /explicit callback/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("public Testcontainers template is valid and contains no maintainer infrastructure", () => {
  const file = new URL("../templates/testcontainers-scenario-policy.v1.json", import.meta.url);
  const rawText = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(rawText);
  const result = validateTestcontainersScenarioPolicy(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.doesNotMatch(rawText, /tailscale|ssh:\/\/|docker\.sock|maintainer|private-runtime-host/i);
});

test("package scripts and CI pin the real Testcontainers smoke", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies.testcontainers, "12.1.0");
  assert.equal(pkg.scripts["integration:testcontainers"], "node scripts/testcontainers-integration.js");
  assert.equal(pkg.scripts["integration:testcontainers:smoke"], "node integration/testcontainers-smoke.mjs");
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /Testcontainers synthetic Redis smoke/);
  assert.match(workflow, /bun run integration:testcontainers:smoke/);
});
