#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const [
  ,
  ,
  endpoint,
  expectedEnvironment,
  expectedVersionId,
  evidencePath,
  overrideWorkerName,
] = process.argv;
if (!endpoint || !expectedEnvironment || !expectedVersionId) {
  console.error(
    "Usage: npm run smoke:version -- <https-health-url> <environment> <expected-version-uuid> [evidence.json] [override-worker-name]",
  );
  process.exit(2);
}

let url;
try {
  url = new URL(endpoint);
} catch {
  console.error("Health URL is invalid.");
  process.exit(2);
}
if (url.protocol !== "https:" || !/^[0-9a-f-]{36}$/i.test(expectedVersionId)) {
  console.error("Smoke requires HTTPS and an exact Worker version UUID.");
  process.exit(2);
}
const expectedOrigins = {
  production: "https://cliphutch-api.mra454.workers.dev",
  staging: "https://cliphutch-api-staging.mra454.workers.dev",
};
if (
  url.origin !== expectedOrigins[expectedEnvironment] ||
  url.pathname !== "/" ||
  url.search !== "" ||
  url.hash !== ""
) {
  console.error("Health URL is not the pinned endpoint for this environment.");
  process.exit(2);
}

let response;
try {
  response = await fetch(url, {
    headers: overrideWorkerName
      ? {
          "Cloudflare-Workers-Version-Overrides": `${overrideWorkerName}="${expectedVersionId}"`,
        }
      : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
} catch {
  console.error("Health request failed.");
  process.exit(1);
}

let body;
try {
  body = await response.json();
} catch {
  console.error("Health response was not JSON.");
  process.exit(1);
}

if (
  !response.ok ||
  body?.ok !== true ||
  body?.service !== "cliphutch-api" ||
  body?.environment !== expectedEnvironment ||
  body?.version?.id !== expectedVersionId
) {
  console.error("Health response did not match the exact expected environment/version.");
  process.exit(1);
}

console.log(
  `Verified ${expectedEnvironment} Worker version ${expectedVersionId}.`,
);
if (evidencePath) {
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        environment: expectedEnvironment,
        versionId: expectedVersionId,
        endpointOrigin: url.origin,
        overrideWorkerName: overrideWorkerName ?? null,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(`Wrote smoke evidence to ${evidencePath}.`);
}
