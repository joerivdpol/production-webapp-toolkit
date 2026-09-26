import test from "node:test";
import assert from "node:assert/strict";

import { inspectPort, normalizePort, parseArguments, parseLsof } from "../scripts/ci-port-guard.js";

test("port guard validates only unprivileged TCP ports", () => {
  assert.equal(normalizePort("43174"), 43174);
  for (const value of ["0", "80", "65536", "abc", "43174.5"]) {
    assert.equal(normalizePort(value), null);
  }
});

test("lsof parser retains PID, command, and owner", () => {
  assert.deepEqual(parseLsof("p123\ncnode\nu1000\np456\ncnext-server\nu1000\n"), [
    { pid: 123, command: "node", uid: "1000" },
    { pid: 456, command: "next-server", uid: "1000" },
  ]);
});

test("port guard arguments require cleanup before force", () => {
  assert.deepEqual(parseArguments(["--port", "43174", "--cleanup", "--force", "--json"]), {
    port: 43174,
    cleanup: true,
    force: true,    json: true,
  });
  assert.equal(parseArguments(["--port", "43174", "--force"]), null);
});

test("free high port inspection is non-blocking", () => {
  const result = inspectPort(43179);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.listeners));
});
