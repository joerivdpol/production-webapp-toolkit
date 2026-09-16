import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  collectDockerContainerRuntimeEvidence,
  formatDockerContainerRuntimeEvidence,
  main,
} from "../scripts/collect-docker-container-runtime-evidence.js";
import { validateRuntimeEvidence } from "../scripts/runtime-evidence.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** @param {{running?:any,revision?:any}} [values] */
function fakeDocker(values = {}) {
  /** @type {string[][]} */ const calls = [];
  /** @param {string[]} args */
  const runner = (args) => {
    calls.push(args);
    if (args.includes("{{.State.Running}}")) return values.running ?? { ok: true, stdout: "true\n" };
    if (args.some((item) => item.includes(".Config.Labels"))) return values.revision ?? { ok: true, stdout: `${COMMIT}\n` };
    throw new Error("unexpected docker call");
  };
  return { runner, calls };
}

test("running container revision label emits canonical container-scoped Runtime Evidence", () => {
  const docker = fakeDocker();
  const result = collectDockerContainerRuntimeEvidence(
    { container: "example-1", runtimeName: "example-container", environment: "production" },
    { runDocker: docker.runner, now: () => "2026-09-16T19:00:00Z" },
  );
  assert.equal(result.ok, true);
  assert.equal(validateRuntimeEvidence(result.evidence).valid, true);
  assert.equal(result.evidence?.deployment.commit, COMMIT);
  assert.equal(result.evidence?.evidence.source, "docker-container-label:org.opencontainers.image.revision");
  assert.equal(result.evidence?.evidence.authenticated, false);
  assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.kind, "container");
  assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "container");
  assert.equal(docker.calls.length, 2);
});

test("custom revision label is explicit and only the requested label is inspected", () => {
  const docker = fakeDocker();
  const result = collectDockerContainerRuntimeEvidence(
    { container: "example-1", runtimeName: "example", revisionLabel: "com.example.build.revision" },
    { runDocker: docker.runner, now: () => "2026-09-16T19:00:00Z" },
  );
  assert.equal(result.ok, true);
  const labelCall = docker.calls.find((args) => args.some((item) => item.includes(".Config.Labels")));
  assert.equal(labelCall?.some((item) => item.includes("com.example.build.revision")), true);
  assert.equal(labelCall?.some((item) => item.includes(".Config.Env")), false);
});

test("stopped unavailable and invalid revision containers fail closed before timestamp", () => {
  let clockCalls = 0;
  const stopped = fakeDocker({ running: { ok: true, stdout: "false\n" } });
  assert.equal(collectDockerContainerRuntimeEvidence(
    { container: "example", runtimeName: "runtime" },
    { runDocker: stopped.runner, now: () => { clockCalls += 1; return "2026-09-16T19:00:00Z"; } },
  ).ok, false);
  const invalid = fakeDocker({ revision: { ok: true, stdout: "latest\n" } });
  assert.equal(collectDockerContainerRuntimeEvidence(
    { container: "example", runtimeName: "runtime" },
    { runDocker: invalid.runner, now: () => { clockCalls += 1; return "2026-09-16T19:00:00Z"; } },
  ).ok, false);
  assert.equal(clockCalls, 0);
});

test("invalid identifiers labels labels and explicit environment are rejected without Docker", () => {
  const docker = fakeDocker();
  assert.equal(collectDockerContainerRuntimeEvidence({ container: "bad/name", runtimeName: "x" }, { runDocker: docker.runner }).ok, false);
  assert.equal(collectDockerContainerRuntimeEvidence({ container: "ok", runtimeName: " " }, { runDocker: docker.runner }).ok, false);
  assert.equal(collectDockerContainerRuntimeEvidence({ container: "ok", runtimeName: "x", environment: " " }, { runDocker: docker.runner }).ok, false);
  assert.equal(collectDockerContainerRuntimeEvidence({ container: "ok", runtimeName: "x", revisionLabel: "bad label" }, { runDocker: docker.runner }).ok, false);
  assert.equal(docker.calls.length, 0);
});

test("invalid collector clock fails after successful Docker inspection", () => {
  const docker = fakeDocker();
  const result = collectDockerContainerRuntimeEvidence(
    { container: "example", runtimeName: "runtime" },
    { runDocker: docker.runner, now: () => "today" },
  );
  assert.equal(result.ok, false);
  assert.equal(docker.calls.length, 2);
});

test("human output states container scope running state and authentication limit", () => {
  const docker = fakeDocker();
  const result = collectDockerContainerRuntimeEvidence(
    { container: "example", runtimeName: "runtime" },
    { runDocker: docker.runner, now: () => "2026-09-16T19:00:00Z" },
  );
  const text = formatDockerContainerRuntimeEvidence(result);
  assert.match(text, /Identity scope: container/);
  assert.match(text, /Container state: RUNNING/);
  assert.match(text, /Authenticated: false/);
});

test("CLI argument validation rejects missing duplicate and unknown input without invoking Docker", () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(main(["--container", "x"]), 1);
    assert.equal(main(["--container", "x", "--runtime-name", "y", "--runtime-name", "z"]), 1);
    assert.equal(main(["--unknown"]), 1);
  } finally { console.error = originalError; }
});

test("collector operational surface is read-only Docker inspect and never reads environment values", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-docker-container-runtime-evidence.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync/);
  assert.match(source, /"inspect"/);
  assert.match(source, /\.Config\.Labels/);
  assert.doesNotMatch(source, /\.Config\.Env|process\.env|\bfetch\s*\(|https?:\/\//);
  assert.doesNotMatch(source, /\b(?:run|start|stop|restart|rm|exec|pull|push|build|create)\b/);
  assert.doesNotMatch(source, /writeFile|appendFile|rmSync|unlinkSync|renameSync|mkdirSync/);
});
