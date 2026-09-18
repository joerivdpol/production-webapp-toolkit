import fc from "fast-check";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PATH = /^(?:[0-9]+(?::[0-9]+)*)?$/;
const CATEGORIES = new Set([
  "VALIDATOR",
  "POLICY",
  "STATE_TRANSITION",
  "NUMERIC_INVARIANT",
  "CUSTOM",
]);

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized)
    ? normalized
    : null;
}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({
        id: scope + "-field-unknown",
        detail: scope + ' contains unsupported field "' + key + '"',
      });
    }
  }
}

/** @param {unknown} value */
export function validatePropertyTestPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) {
    return {
      valid: false,
      policy: null,
      errors: [{ id: "policy-invalid", detail: "property test policy must be an object" }],
    };
  }
  rejectUnknown(value, ["version", "seed", "numRuns", "maxSkipsPerRun", "path"], "policy", errors);
  if (value.version !== 1) {
    errors.push({ id: "version-invalid", detail: "property test policy version must be exactly 1" });
  }
  const seed = integer(value.seed, -2147483648, 2147483647);
  const numRuns = integer(value.numRuns, 1, 10000);
  const maxSkipsPerRun = integer(value.maxSkipsPerRun, 0, 10000);
  const pathValue = value.path === null ? null : text(value.path, 1024);
  if (seed === null) errors.push({ id: "seed-invalid", detail: "seed must be a signed 32-bit integer" });
  if (numRuns === null) errors.push({ id: "num-runs-invalid", detail: "numRuns must be between 1 and 10000" });
  if (maxSkipsPerRun === null) errors.push({ id: "max-skips-invalid", detail: "maxSkipsPerRun must be between 0 and 10000" });
  if (value.path !== null && (!pathValue || !PATH.test(pathValue))) {
    errors.push({ id: "path-invalid", detail: "path must be null or a fast-check counterexample path" });
  }
  if (errors.length || seed === null || numRuns === null || maxSkipsPerRun === null) {
    return { valid: false, policy: null, errors };
  }
  return {
    valid: true,
    policy: {
      version: 1,
      seed,
      numRuns,
      maxSkipsPerRun,
      path: pathValue,
    },
    errors: [],
  };
}

/** @param {unknown} value */
function isArbitrary(value) {
  if (!((typeof value === "object" && value !== null) || typeof value === "function")) return false;
  const candidate = /** @type {any} */ (value);
  return typeof candidate.generate === "function"
    && typeof candidate.canShrinkWithoutContext === "function"
    && typeof candidate.shrink === "function";
}
/** @param {unknown} rawPolicy @param {{id:string,category:string,arbitraries:unknown[],predicate:(...values:any[])=>boolean|void}} spec */
export function runFastCheckProperty(rawPolicy, spec) {
  const policyResult = validatePropertyTestPolicy(rawPolicy);
  if (!policyResult.valid || !policyResult.policy) {
    throw new Error("Property Test Policy v1 is invalid");
  }
  const policy = policyResult.policy;
  const propertyId = text(spec?.id, 128);
  const category = text(spec?.category, 32);
  if (!propertyId || !ID.test(propertyId)) throw new Error("property id must be a portable identifier");
  if (!category || !CATEGORIES.has(category)) throw new Error("property category is unsupported");
  if (!Array.isArray(spec.arbitraries) || spec.arbitraries.length < 1 || spec.arbitraries.length > 8 || spec.arbitraries.some((item) => !isArbitrary(item))) {
    throw new Error("property must declare between one and eight fast-check arbitraries");
  }
  if (typeof spec.predicate !== "function") throw new Error("property predicate must be a function");

  /** @type {(...values:any[])=>boolean} */
  const predicate = (...values) => {
    const result = spec.predicate(...values);
    if (result === undefined) return true;
    if (typeof result !== "boolean") {
      throw new Error("property predicate must return boolean or undefined");
    }
    return result;
  };
  const property = /** @type {any} */ (fc.property)(...spec.arbitraries, predicate);
  const details = /** @type {any} */ (fc.check(property, {
    seed: policy.seed,
    numRuns: policy.numRuns,
    maxSkipsPerRun: policy.maxSkipsPerRun,
    path: policy.path ?? "",
    endOnFailure: false,
    verbose: 0,
  }));
  const status = details.failed || details.interrupted ? "FAIL" : "PASS";
  return {
    version: 1,
    property: { id: propertyId, category },
    policy,
    status,
    run: {
      seed: details.seed,
      numRuns: details.numRuns,
      numSkips: details.numSkips,
      numShrinks: details.numShrinks,
      counterexamplePath: details.counterexamplePath,
    },
    replay: status === "FAIL"
      ? { seed: details.seed, path: details.counterexamplePath }
      : null,
    counterexampleStored: false,
    errorStored: false,
    execution: {
      arbitraryGeneration: true,
      predicateEvaluation: true,
      shell: false,
      network: false,
    },
    semantics: "fast-check evaluates only the explicit caller property over generated synthetic values; seed and shrink path support deterministic replay, while no business rule or correctness claim is inferred by the adapter",
  };
}
/** @param {unknown} policy @param {{id:string,arbitraries:unknown[],predicate:(...values:any[])=>boolean|void}} spec */
export function runValidatorProperty(policy, spec) {
  return runFastCheckProperty(policy, { ...spec, category: "VALIDATOR" });
}
/** @param {unknown} policy @param {{id:string,arbitraries:unknown[],predicate:(...values:any[])=>boolean|void}} spec */
export function runPolicyProperty(policy, spec) {
  return runFastCheckProperty(policy, { ...spec, category: "POLICY" });
}
/** @param {unknown} policy @param {{id:string,arbitraries:unknown[],predicate:(...values:any[])=>boolean|void}} spec */
export function runStateTransitionProperty(policy, spec) {
  return runFastCheckProperty(policy, { ...spec, category: "STATE_TRANSITION" });
}
/** @param {unknown} policy @param {{id:string,arbitraries:unknown[],predicate:(...values:any[])=>boolean|void}} spec */
export function runNumericInvariantProperty(policy, spec) {
  return runFastCheckProperty(policy, { ...spec, category: "NUMERIC_INVARIANT" });
}
/** @param {unknown} policy @param {{id:string,arbitraries:unknown[],predicate:(...values:any[])=>boolean|void}} spec */
export function runCustomProperty(policy, spec) {
  return runFastCheckProperty(policy, { ...spec, category: "CUSTOM" });
}
/** @param {ReturnType<typeof runFastCheckProperty>} report */
export function formatPropertyTestResult(report) {
  const lines = [
    "Property Test Result v1",
    "",
    "Property: " + report.property.id,
    "Category: " + report.property.category,
    "Status: " + report.status,
    "Seed: " + report.run.seed,
    "Runs: " + report.run.numRuns,
    "Skips: " + report.run.numSkips,
    "Shrinks: " + report.run.numShrinks,
    "Counterexample path: " + (report.run.counterexamplePath ?? "(none)"),
    "Raw counterexample stored: false",
    "Raw error stored: false",
    "Shell: false",
    "Network: false",
    "Semantics: " + report.semantics,
  ];
  return lines.join("\n");
}

export { fc as fastCheck };
