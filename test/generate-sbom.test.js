import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateSbom,
  main,
  parseBunLock,
  stripJsonTrailingCommas,
} from "../scripts/generate-sbom.js";

const COMMIT = "a".repeat(40);
const ARTIFACT_SHA = "b".repeat(64);
const CREATED_AT = "2026-09-16T15:30:00Z";

/** @param {number} byte @param {"sha256"|"sha384"|"sha512"} [algorithm] */
function sri(byte, algorithm = "sha512") {
  const length = algorithm === "sha256" ? 32 : algorithm === "sha384" ? 48 : 64;
  return `${algorithm}-${Buffer.alloc(length, byte).toString("base64")}`;
}

/** @param {{ ambiguous?: boolean, missingIntegrity?: boolean }} [options] */
function lockObject(options = {}) {
  /** @type {Record<string, any>} */
  const packages = {
    prod: ["prod@1.0.0", "", { dependencies: { transitive: "^3.0.0" } }, sri(1)],
    dev: ["dev@2.0.0", "", {}, sri(2, "sha256")],
    transitive: ["transitive@3.1.0", "", {}, options.missingIntegrity ? "" : sri(3, "sha384")],
  };
  if (options.ambiguous) packages["prod@2"] = ["prod@2.0.0", "", {}, sri(4)];
  return {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: "demo-app",
        dependencies: { prod: "1.0.0" },
        devDependencies: { dev: "2.0.0" },
      },
    },
    packages,
  };
}

/** @param {ReturnType<typeof lockObject>} lock */
function bunLockText(lock) {
  return `${JSON.stringify(lock, null, 2).replace(/\n}\s*$/, ",\n}")}\n`;
}

/** @param {{ lock?: ReturnType<typeof lockObject>, packageManager?: string, nodeVersion?: string }} [options] */
function tempRepository(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-sbom-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "demo-app",
    version: "2.3.4",
    packageManager: options.packageManager ?? "bun@1.3.14",
  }));
  fs.writeFileSync(path.join(root, ".node-version"), `${options.nodeVersion ?? "24.11.1"}\n`);
  fs.writeFileSync(path.join(root, "bun.lock"), bunLockText(options.lock ?? lockObject()));
  return root;
}

/** @param {string} root */
function generate(root) {
  return generateSbom(root, {
    sourceCommit: COMMIT,
    artifactSha256: ARTIFACT_SHA,
    createdAt: CREATED_AT,
  });
}

test("trailing comma parser preserves commas inside strings", () => {
  const text = '{"value":"x,}","items":[1,2,],}';
  assert.equal(stripJsonTrailingCommas(text), '{"value":"x,}","items":[1,2]}');
});

test("generates CycloneDX 1.7 with explicit artifact, source, toolchain, and component evidence", () => {
  const root = tempRepository();
  const result = generate(root);
  const { sbom } = result;
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.7");
  assert.equal(sbom.metadata.timestamp, CREATED_AT);
  assert.equal(sbom.metadata.component.name, "demo-app");
  assert.equal(sbom.metadata.component.version, "2.3.4");
  assert.deepEqual(sbom.metadata.component.hashes, [{ alg: "SHA-256", content: ARTIFACT_SHA }]);
  assert.equal(sbom.metadata.properties.some((item) => item.name === "toolkit:sourceCommit" && item.value === COMMIT), true);
  assert.equal(sbom.metadata.properties.some((item) => item.name === "toolkit:nodeVersion" && item.value === "24.11.1"), true);
  assert.equal(sbom.metadata.properties.some((item) => item.name === "toolkit:packageManager" && item.value === "bun@1.3.14"), true);
  assert.equal(sbom.metadata.properties.some((item) => item.name === "toolkit:dependencyGraph" && item.value === "root-direct-only"), true);
  assert.equal(result.summary.components, 3);
  assert.equal(result.summary.directDependencies, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("classifies direct and transitive packages and converts SRI hashes to CycloneDX hex hashes", () => {
  const root = tempRepository();
  const result = generate(root);
  const byName = new Map(result.sbom.components.map((component) => [component.name, component]));
  assert.equal(byName.get("prod")?.properties[0].value, "direct-production");
  assert.equal(byName.get("dev")?.properties[0].value, "direct-development");
  assert.equal(byName.get("transitive")?.properties[0].value, "transitive");
  assert.deepEqual(byName.get("dev")?.hashes, [{ alg: "SHA-256", content: "02".repeat(32) }]);
  assert.deepEqual(byName.get("transitive")?.hashes, [{ alg: "SHA-384", content: "03".repeat(48) }]);
  assert.deepEqual(result.sbom.dependencies, [{
    ref: "application:demo-app@2.3.4",
    dependsOn: ["npm:dev@2.0.0", "npm:prod@1.0.0"],
  }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unavailable package integrity stays explicit instead of inventing a hash", () => {
  const root = tempRepository({ lock: lockObject({ missingIntegrity: true }) });
  const result = generate(root);
  const component = result.sbom.components.find((item) => item.name === "transitive");
  assert.equal(component?.hashes, undefined);
  assert.equal(component?.properties.some((/** @type {any} */ item) => item.name === "toolkit:packageIntegrity" && item.value === "unavailable"), true);
  assert.equal(result.summary.unhashedComponents, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("fails closed when a direct dependency maps to multiple locked versions", () => {
  const root = tempRepository({ lock: lockObject({ ambiguous: true }) });
  assert.throws(() => generate(root), /does not resolve to exactly one locked package/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rejects invalid release identity and unpinned toolchain inputs", () => {
  const root = tempRepository();
  assert.throws(() => generateSbom(root, { sourceCommit: "abc", artifactSha256: ARTIFACT_SHA, createdAt: CREATED_AT }), /source commit/);
  assert.throws(() => generateSbom(root, { sourceCommit: COMMIT, artifactSha256: "bad", createdAt: CREATED_AT }), /artifact SHA256/);
  assert.throws(() => generateSbom(root, { sourceCommit: COMMIT, artifactSha256: ARTIFACT_SHA, createdAt: "today" }), /created-at/);
  fs.rmSync(root, { recursive: true, force: true });

  const floating = tempRepository({ packageManager: "bun@latest" });
  assert.throws(() => generate(floating), /packageManager must pin/);
  fs.rmSync(floating, { recursive: true, force: true });

  const node = tempRepository({ nodeVersion: "24" });
  assert.throws(() => generate(node), /.node-version must contain an exact semantic version/);
  fs.rmSync(node, { recursive: true, force: true });
});

test("rejects malformed Bun lockfiles and symlinked evidence files", () => {
  const root = tempRepository();
  fs.writeFileSync(path.join(root, "bun.lock"), "{");
  assert.throws(() => generate(root), /bun.lock cannot be parsed/);
  fs.rmSync(root, { recursive: true, force: true });

  const linked = tempRepository();
  const external = path.join(os.tmpdir(), `toolkit-sbom-package-${process.pid}.json`);
  fs.writeFileSync(external, JSON.stringify({ name: "demo-app", version: "2.3.4", packageManager: "bun@1.3.14" }));
  fs.rmSync(path.join(linked, "package.json"));
  fs.symlinkSync(external, path.join(linked, "package.json"));
  assert.throws(() => generate(linked), /must be a regular file/);
  fs.rmSync(linked, { recursive: true, force: true });
  fs.rmSync(external, { force: true });
});

test("parseBunLock requires version 1 root workspace and package inventory", () => {
  assert.throws(() => parseBunLock(JSON.stringify({ lockfileVersion: 2, workspaces: {}, packages: {} })), /version 1/);
  assert.throws(() => parseBunLock(JSON.stringify({ lockfileVersion: 1, workspaces: {}, packages: {} })), /root workspace/);
});

test("CLI emits deterministic JSON and leaves repository inputs unchanged", () => {
  const root = tempRepository();
  const files = ["package.json", "bun.lock", ".node-version"];
  const before = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main([
      "--root", root,
      "--source-commit", COMMIT,
      "--artifact-sha256", ARTIFACT_SHA,
      "--created-at", CREATED_AT,
      "--json",
    ]), 0);
  } finally { console.log = originalLog; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.specVersion, "1.7");
  for (const file of files) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), before.get(file));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects incomplete and unknown arguments", () => {
  assert.equal(main([]), 1);
  assert.equal(main(["--unknown"]), 1);
});

test("SBOM generator has no Git, network, environment, subprocess, or repository-write surface", () => {
  const source = fs.readFileSync(new URL("../scripts/generate-sbom.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/(?!cyclonedx\.org\/schema\/bom-1\.7\.schema\.json)/);
  assert.doesNotMatch(source, /writeFile|appendFile|rmSync|unlinkSync|renameSync/);
  assert.match(source, /lstatSync/);
  assert.match(source, /artifactSha256/);
  assert.match(source, /sourceCommit/);
});
