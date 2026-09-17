#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareEcosystemHistory,
  validateEcosystemDashboardSnapshot,
} from "./compare-ecosystem-history.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const CADENCES = new Set(["HOURLY", "DAILY", "WEEKLY"]);
const WEEKDAYS = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
const OVERALL_TRIGGERS = new Set(["WARN", "FAIL"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z][A-Za-z0-9._+-]{0,63}(?:\/[A-Za-z0-9._+-]{1,64})+)$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** @param {string} value */
function validTimezone(value) {
  if (!TIMEZONE_PATTERN.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0)); return true; }
  catch { return false; }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 1024) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && ID_PATTERN.test(normalized) ? normalized : null;
}

/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value @param {number} minimum @param {number} maximum */
function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null;
}

/** @param {unknown} value @param {string} field @param {Array<{id:string,detail:string}>} errors */
function ids(value, field, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    errors.push({ id: `${field}-invalid`, detail: `${field} must be a non-empty bounded array` });
    return null;
  }
  const normalized = value.map(portableId);
  if (normalized.some((item) => item === null)) {
    errors.push({ id: `${field}-id-invalid`, detail: `${field} contains an invalid portable identifier` });
    return null;
  }
  const result = /** @type {string[]} */ (normalized);
  if (new Set(result).size !== result.length) {
    errors.push({ id: `${field}-duplicate`, detail: `${field} contains duplicate identifiers` });
    return null;
  }
  return result.sort();
}

/** @param {unknown} value */
export function validateScheduledReportingPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "scheduled reporting policy must be an object" }] };
  rejectUnknown(value, ["version", "schedule", "notification"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let schedule = null;
  if (!object(value.schedule)) errors.push({ id: "schedule-invalid", detail: "schedule must be an object" });
  else {
    rejectUnknown(value.schedule, ["id", "cadence", "timezone", "hour", "minute", "weekday"], "schedule", errors);
    const scheduleId = portableId(value.schedule.id);
    const cadence = text(value.schedule.cadence, 16);
    const timezone = text(value.schedule.timezone, 128);
    const minute = integer(value.schedule.minute, 0, 59);
    const hour = value.schedule.hour === undefined ? null : integer(value.schedule.hour, 0, 23);
    const weekday = value.schedule.weekday === undefined ? null : text(value.schedule.weekday, 8);
    if (!scheduleId || !cadence || !CADENCES.has(cadence) || !timezone || !validTimezone(timezone) || minute === null) {
      errors.push({ id: "schedule-fields-invalid", detail: "schedule requires portable id, supported cadence/timezone, and minute" });
    } else if (cadence === "HOURLY") {
      if (value.schedule.hour !== undefined || value.schedule.weekday !== undefined) errors.push({ id: "hourly-schedule-invalid", detail: "HOURLY schedule permits minute only" });
      else schedule = { id: scheduleId, cadence, timezone, minute };
    } else if (cadence === "DAILY") {
      if (hour === null || value.schedule.weekday !== undefined) errors.push({ id: "daily-schedule-invalid", detail: "DAILY schedule requires hour and minute and forbids weekday" });
      else schedule = { id: scheduleId, cadence, timezone, hour, minute };
    } else {
      if (hour === null || !weekday || !WEEKDAYS.has(weekday)) errors.push({ id: "weekly-schedule-invalid", detail: "WEEKLY schedule requires weekday, hour, and minute" });
      else schedule = { id: scheduleId, cadence, timezone, weekday, hour, minute };
    }
  }

  let notification = null;
  if (!object(value.notification)) errors.push({ id: "notification-invalid", detail: "notification must be an object" });
  else {
    const notificationValue = value.notification;
    rejectUnknown(notificationValue, ["sinks", "onOverall", "onTechnicalFailure", "onRegression", "onRepositoryAdded", "onRepositoryRemoved"], "notification", errors);
    const sinks = ids(notificationValue.sinks, "notification-sinks", errors);
    let onOverall = null;
    if (!Array.isArray(notificationValue.onOverall) || notificationValue.onOverall.length > 2) {
      errors.push({ id: "notification-overall-invalid", detail: "notification.onOverall must be a bounded array" });
    } else {
      const values = notificationValue.onOverall.map((item) => text(item, 16));
      if (values.some((item) => !item || !OVERALL_TRIGGERS.has(item)) || new Set(values).size !== values.length) {
        errors.push({ id: "notification-overall-fields-invalid", detail: "notification.onOverall may contain unique WARN and FAIL values" });
      } else onOverall = /** @type {string[]} */ (values).sort();
    }
    const booleans = ["onTechnicalFailure", "onRegression", "onRepositoryAdded", "onRepositoryRemoved"];
    if (booleans.some((field) => typeof notificationValue[field] !== "boolean")) {
      errors.push({ id: "notification-flags-invalid", detail: "notification trigger flags must be boolean" });
    } else if (sinks && onOverall) {
      notification = {
        sinks,
        onOverall,
        onTechnicalFailure: notificationValue.onTechnicalFailure,
        onRegression: notificationValue.onRegression,
        onRepositoryAdded: notificationValue.onRepositoryAdded,
        onRepositoryRemoved: notificationValue.onRepositoryRemoved,
      };
    }
  }

  if (errors.length > 0 || !schedule || !notification) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, schedule, notification }, errors: [] };
}

/** @param {any} policy @param {any} current @param {any|null} previous @param {string} evaluatedAt */
export function planScheduledReporting(policy, current, previous, evaluatedAt) {
  if (!isAbsoluteIsoTimestamp(evaluatedAt)) throw new Error("evaluatedAt must be an absolute ISO timestamp");
  if (Date.parse(current.generatedAt) > Date.parse(evaluatedAt)) throw new Error("current dashboard cannot be newer than evaluation time");
  let history = null;
  if (previous !== null) history = compareEcosystemHistory(previous, current);

  /** @type {Array<{id:string,detail:string}>} */
  const reasons = [];
  if (policy.notification.onOverall.includes(current.overallStatus)) {
    reasons.push({ id: `current-overall-${current.overallStatus.toLowerCase()}`, detail: `current ecosystem overall status is ${current.overallStatus}` });
  }
  if (policy.notification.onTechnicalFailure && current.technicalStatus === "FAIL") {
    reasons.push({ id: "current-technical-failure", detail: "current ecosystem contains technical failures" });
  }
  if (history && policy.notification.onRegression && history.summary.regressed > 0) {
    reasons.push({ id: "repository-regression", detail: `${history.summary.regressed} repository status regression(s) detected` });
  }
  if (history && policy.notification.onRepositoryAdded && history.summary.added > 0) {
    reasons.push({ id: "repository-added", detail: `${history.summary.added} repository/repositories added` });
  }
  if (history && policy.notification.onRepositoryRemoved && history.summary.removed > 0) {
    reasons.push({ id: "repository-removed", detail: `${history.summary.removed} repository/repositories removed` });
  }
  reasons.sort((a, b) => a.id.localeCompare(b.id));

  const notify = reasons.length > 0;
  const identityInput = JSON.stringify({
    schedule: policy.schedule,
    evaluatedAt,
    currentGeneratedAt: current.generatedAt,
    previousGeneratedAt: history?.previousGeneratedAt ?? null,
    reasons: reasons.map((item) => item.id),
    sinkIds: policy.notification.sinks,
  });
  const eventId = crypto.createHash("sha256").update(identityInput).digest("hex");

  return {
    version: 1,
    schedule: policy.schedule,
    evaluatedAt,
    report: {
      generatedAt: current.generatedAt,
      overallStatus: current.overallStatus,
      technicalStatus: current.technicalStatus,
      repositories: current.repositories.length,
    },
    history: history ? {
      status: "AVAILABLE",
      previousGeneratedAt: history.previousGeneratedAt,
      comparisonStatus: history.comparisonStatus,
      improved: history.summary.improved,
      regressed: history.summary.regressed,
      added: history.summary.added,
      removed: history.summary.removed,
    } : { status: "NOT_CONFIGURED" },
    notification: {
      notify,
      eventId,
      sinkIds: notify ? policy.notification.sinks : [],
      reasons,
    },
    technicalStatus: "PASS",
    semantics: "scheduled reporting plan is declarative only; external schedulers invoke the command and external sink bridges decide delivery using symbolic sink ids; the toolkit sends no notification itself",
  };
}

/** @param {ReturnType<typeof planScheduledReporting>} report */
export function formatScheduledReporting(report) {
  const lines = [
    "Scheduled reporting plan",
    "",
    `Schedule: ${report.schedule.id} (${report.schedule.cadence}, ${report.schedule.timezone})`,
    `Evaluated at: ${report.evaluatedAt}`,
    `Dashboard: ${report.report.generatedAt} (${report.report.overallStatus})`,
    `History: ${report.history.status}`,
    `Notification: ${report.notification.notify ? "YES" : "NO"}`,
    `Event: ${report.notification.eventId}`,
    `Semantics: ${report.semantics}`,
    "",
  ];
  for (const reason of report.notification.reasons) lines.push(`TRIGGER  ${reason.id}  ${reason.detail}`);
  if (report.notification.notify) lines.push(`Sinks: ${report.notification.sinkIds.join(", ")}`);
  lines.push("", `Technical: ${report.technicalStatus}`);
  return lines.join("\n");
}

/** @param {string} filename */
function readJsonBounded(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) return null;
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return null; }
}

/** @param {string[]} argv */
function parse(argv) {
  let policyFile = null, currentFile = null, previousFile = null, evaluatedAt = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--policy", "--current", "--previous", "--evaluated-at"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--policy") { if (policyFile) return null; policyFile = value; }
    else if (argument === "--current") { if (currentFile) return null; currentFile = value; }
    else if (argument === "--previous") { if (previousFile) return null; previousFile = value; }
    else { if (evaluatedAt) return null; evaluatedAt = value; }
  }
  return policyFile && currentFile && evaluatedAt ? { policyFile, currentFile, previousFile, evaluatedAt, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/scheduled-reporting.js --policy <policy.json> --current <dashboard.json> [--previous <dashboard.json>] --evaluated-at <ISO> [--json]"); return 1; }
  const rawPolicy = readJsonBounded(path.resolve(options.policyFile)), rawCurrent = readJsonBounded(path.resolve(options.currentFile)), rawPrevious = options.previousFile ? readJsonBounded(path.resolve(options.previousFile)) : null;
  if (!rawPolicy || !rawCurrent || (options.previousFile && !rawPrevious)) { console.error("Scheduled reporting input cannot be read or parsed"); return 1; }
  const policy = validateScheduledReportingPolicy(rawPolicy), current = validateEcosystemDashboardSnapshot(rawCurrent), previous = rawPrevious ? validateEcosystemDashboardSnapshot(rawPrevious) : null;
  if (!policy.valid || !policy.policy || !current.valid || !current.snapshot || (previous && (!previous.valid || !previous.snapshot))) { console.error("Scheduled reporting input is invalid"); return 1; }
  let report;
  try { report = planScheduledReporting(policy.policy, current.snapshot, previous?.snapshot ?? null, options.evaluatedAt); }
  catch { console.error("Scheduled reporting chronology is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(report) : formatScheduledReporting(report));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
