import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { withSyntheticTestcontainers } from "../scripts/testcontainers-integration.js";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("smoke fixture git failed");
  return result.stdout.trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testcontainers-smoke-"));
  fs.writeFileSync(path.join(root, "README.md"), "# synthetic smoke\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Smoke"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "synthetic fixture"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}
function redisCommand(parts) {
  return "*" + parts.length + "\r\n"
    + parts.map((part) => "$" + Buffer.byteLength(part) + "\r\n" + part + "\r\n").join("");
}

async function sendRedis(host, port, parts, expected) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("synthetic Redis probe timed out"));
    }, 5000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(redisCommand(parts)));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes(expected)) {
        clearTimeout(timer);
        socket.end();
        resolve();
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
const fixture = repository();
try {
  const policy = {
    version: 1,
    repository: { id: "toolkit-smoke", commit: fixture.commit },
    testcontainersVersion: "12.1.0",
    scenarioId: "scenario:redis-smoke",
    dataClassification: "SYNTHETIC_ONLY",
    startupTimeoutMs: 60000,
    containers: [{
      id: "cache",
      image: "redis@sha256:e957842a3e7962bfe3e5ab9814eab06e029a2f0d7b0f5d74178af12713b9ab4d",
      exposedPorts: [6379],
      environment: [],
    }],
  };

  const output = await withSyntheticTestcontainers(
    fixture.root,
    policy,
    "2026-09-19T00:00:00Z",
    async (runtime) => {
      const cache = runtime.containers.find((container) => container.id === "cache");
      assert.ok(cache);
      const port = cache.ports.find((entry) => entry.containerPort === 6379)?.mappedPort;
      assert.ok(port);
      await sendRedis(cache.host, port, ["PING"], "+PONG");
      await sendRedis(cache.host, port, ["SET", "toolkit:synthetic:v1", "ok"], "+OK");
      await sendRedis(cache.host, port, ["GET", "toolkit:synthetic:v1"], "$2\r\nok");
      return "synthetic-roundtrip-pass";
    },
  );

  assert.equal(output.result, "synthetic-roundtrip-pass");
  assert.equal(output.evidence.overallStatus, "PASS");
  assert.equal(output.evidence.cleanup.status, "PASS");
  assert.equal(output.evidence.cleanup.stopped, 1);
  assert.equal(output.evidence.productionDataAuthorized, false);
  const serialized = JSON.stringify(output.evidence);
  assert.doesNotMatch(serialized, /127\.0\.0\.1|localhost|mappedPort|synthetic-roundtrip-pass/);
  console.log("Testcontainers Redis synthetic smoke: PASS");
} finally {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}
