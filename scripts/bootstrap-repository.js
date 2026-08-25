import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [, , targetArg, modeArg] = process.argv;

if (!targetArg) {
  console.error("Usage: node scripts/bootstrap-repository.js <repository-path> [--dry-run]");
  process.exit(1);
}

const target = path.resolve(targetArg);
const dryRun = modeArg === "--dry-run";

/** @param {string} repositoryPath */
function assertSupportedRepository(repositoryPath) {
  if (!fs.existsSync(repositoryPath)) {
    console.error(`Target does not exist: ${repositoryPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(repositoryPath, "package.json"))) {
    console.error("STOP: target is missing package.json");
    process.exit(1);
  }

  try {
    execFileSync(
      "git",
      ["-C", repositoryPath, "rev-parse", "--is-inside-work-tree"],
      { stdio: "ignore" },
    );
  } catch {
    console.error("STOP: target is not a git repository");
    process.exit(1);
  }
}

assertSupportedRepository(target);

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const configPath = path.join(root, "config", "bootstrap-standard.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

/** @param {string} message */
function action(message) {
  console.log(`${dryRun ? "[dry-run]" : "[write]"} ${message}`);
}

for (const file of config.files) {
  const source = path.join(root, "templates", file.template);
  const destination = path.join(target, file.destination);

  if (!fs.existsSync(source)) {
    console.error(`Missing template: ${source}`);
    process.exit(1);
  }

  if (fs.existsSync(destination)) {
    action(`skip existing ${file.destination}`);
    continue;
  }

  action(`create ${file.destination}`);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

const workflowSource = path.join(
  root,
  "templates",
  "github-actions",
  config.github.workflow,
);

const workflowDestination = path.join(
  target,
  ".github",
  "workflows",
  config.github.workflow,
);

if (fs.existsSync(workflowSource)) {
  if (fs.existsSync(workflowDestination)) {
    action(`skip existing ${workflowDestination}`);
  } else {
    action(`create .github/workflows/${config.github.workflow}`);

    if (!dryRun) {
      fs.mkdirSync(path.dirname(workflowDestination), { recursive: true });
      fs.copyFileSync(workflowSource, workflowDestination);
    }
  }
}

console.log("Bootstrap complete.");
