#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , operation, environment, ...flags] = process.argv;
const allowedOperations = new Set([
  "bootstrap",
  "deploy",
  "migrations-apply",
  "migrations-list",
  "versions-promote",
  "versions-stage",
  "versions-upload",
]);
const allowedEnvironments = new Set(["local", "staging", "production"]);
const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function flagValue(name) {
  const prefix = `--${name}=`;
  return flags.find((flag) => flag.startsWith(prefix))?.slice(prefix.length);
}

if (!allowedOperations.has(operation) || !allowedEnvironments.has(environment)) {
  console.error(
    "Usage: run-wrangler-operation.mjs <bootstrap|deploy|migrations-apply|migrations-list|versions-upload|versions-stage|versions-promote> <local|staging|production>",
  );
  process.exit(2);
}

if (environment === "local" && operation !== "bootstrap") {
  console.error("Only baseline-plus-migrations bootstrap is supported for local D1.");
  process.exit(2);
}

if (operation === "deploy" && environment !== "staging") {
  console.error("Direct deployment is permitted only for the isolated staging Worker.");
  process.exit(2);
}
if (operation.startsWith("versions-") && environment !== "production") {
  console.error("Version staging/promotion operations are production-only.");
  process.exit(2);
}
if (operation === "bootstrap" && environment === "production") {
  console.error("Production bootstrap is forbidden; apply reviewed numbered migrations only.");
  process.exit(2);
}

const mutating = operation !== "migrations-list";
let expectedVersion;
let changeTicket;
if (environment === "production" && mutating) {
  const confirmed = flags.includes("--confirm-production");
  changeTicket = flagValue("change-ticket");
  expectedVersion = flagValue("expected-current-version");
  if (
    !confirmed ||
    !changeTicket ||
    changeTicket.length > 100 ||
    !/^[0-9a-f-]{36}$/i.test(expectedVersion ?? "")
  ) {
    console.error(
      "Production mutation refused. Supply --confirm-production, --change-ticket=<id>, and --expected-current-version=<uuid> after reconciliation and exact-version smoke.",
    );
    process.exit(2);
  }
}

const database =
  environment === "staging"
    ? "cliphutch-licenses-staging"
    : "cliphutch-licenses";

function run(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function assertProductionVersion(expected) {
  let deployment;
  try {
    deployment = JSON.parse(
      capture(["deployments", "status", "--env", "production", "--json"]),
    );
  } catch {
    console.error("Could not parse the current production deployment state.");
    process.exit(1);
  }
  const active = Array.isArray(deployment.versions)
    ? deployment.versions.filter((version) => Number(version.percentage) > 0)
    : [];
  if (
    active.length !== 1 ||
    active[0]?.version_id !== expected ||
    Number(active[0]?.percentage) !== 100
  ) {
    console.error("Production changed or is already split; refusing mutation.");
    process.exit(1);
  }
}

function candidateVersion() {
  const candidate = flagValue("candidate-version");
  if (!/^[0-9a-f-]{36}$/i.test(candidate ?? "")) {
    console.error("A valid --candidate-version=<uuid> is required.");
    process.exit(2);
  }
  return candidate;
}

function assertSmokeEvidence(candidate) {
  const evidencePath = flagValue("smoke-evidence");
  if (!evidencePath) {
    console.error("Promotion requires --smoke-evidence=<JSON file>.");
    process.exit(2);
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch {
    console.error("Smoke evidence could not be read.");
    process.exit(2);
  }
  const verifiedAt = Date.parse(evidence.verifiedAt);
  if (
    evidence.environment !== "production" ||
    evidence.versionId !== candidate ||
    evidence.overrideWorkerName !== "cliphutch-api" ||
    evidence.endpointOrigin !== "https://cliphutch-api.mra454.workers.dev" ||
    !Number.isFinite(verifiedAt) ||
    Date.now() - verifiedAt < 0 ||
    Date.now() - verifiedAt > 2 * 60 * 60 * 1000
  ) {
    console.error("Smoke evidence is stale or does not identify this production candidate.");
    process.exit(2);
  }
}

const envArgs = environment === "local" ? [] : ["--env", environment];
const localityArgs = environment === "local" ? ["--local"] : ["--remote"];

switch (operation) {
  case "deploy":
    run(["deploy", ...envArgs]);
    break;
  case "migrations-list":
    run(["d1", "migrations", "list", database, ...localityArgs, ...envArgs]);
    break;
  case "migrations-apply":
    if (environment === "production") assertProductionVersion(expectedVersion);
    run(["d1", "migrations", "apply", database, ...localityArgs, ...envArgs]);
    break;
  case "bootstrap":
    run([
      "d1",
      "execute",
      database,
      ...localityArgs,
      ...envArgs,
      "--file=schema.base.sql",
    ]);
    run(["d1", "migrations", "apply", database, ...localityArgs, ...envArgs]);
    break;
  case "versions-upload": {
    assertProductionVersion(expectedVersion);
    const previewAlias = flagValue("preview-alias") ?? "release-candidate";
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(previewAlias)) {
      console.error("Preview alias must be 1-32 lowercase letters, digits, or hyphens.");
      process.exit(2);
    }
    run([
      "versions",
      "upload",
      "--env",
      "production",
      "--strict",
      "--preview-alias",
      previewAlias,
      "--message",
      `Candidate ${changeTicket}`,
    ]);
    break;
  }
  case "versions-stage": {
    assertProductionVersion(expectedVersion);
    const candidate = candidateVersion();
    capture(["versions", "view", candidate, "--env", "production", "--json"]);
    run([
      "versions",
      "deploy",
      `${expectedVersion}@100`,
      `${candidate}@0`,
      "--env",
      "production",
      "--message",
      `Stage 0% ${changeTicket}`,
      "--yes",
    ]);
    break;
  }
  case "versions-promote": {
    assertProductionVersion(expectedVersion);
    const candidate = candidateVersion();
    assertSmokeEvidence(candidate);
    run([
      "versions",
      "deploy",
      `${expectedVersion}@0`,
      `${candidate}@100`,
      "--env",
      "production",
      "--message",
      `Promote ${changeTicket}`,
      "--yes",
    ]);
    break;
  }
}
