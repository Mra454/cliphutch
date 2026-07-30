#!/usr/bin/env node
// Operator tool: send (or re-send) a ClipHutch or ComputedKit license-key email for a
// customer. Use when Resend was unavailable during the original webhook
// fire (the worker swallows email failures and logs them; the license still
// lands in D1).
//
// Usage:
//   RESEND_API_KEY=re_... \
//   RESEND_FROM_EMAIL='ClipHutch <licenses@cliphutch.com>' \
//   node scripts/resend-license.mjs <email> <license-key>
//
// The email content mirrors src/email.ts; if that template changes, update
// this file too.

const [, , toEmail, licenseKey] = process.argv;

if (!toEmail || !licenseKey) {
  console.error("Usage: node scripts/resend-license.mjs <email> <license-key>");
  process.exit(2);
}

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.RESEND_FROM_EMAIL;
const isComputedKit = licenseKey.trim().toUpperCase().startsWith("CK-");
const productName = isComputedKit ? "ComputedKit Pro" : "ClipHutch";
const maxDevices = isComputedKit ? 3 : 5;
const activationSteps = isComputedKit
  ? [
      "Open ComputedKit from Chrome's toolbar.",
      "In the ComputedKit Pro Baselines & Compare card, paste this key.",
      "Select Activate Pro."
    ]
  : [
      "Open ClipHutch's options page from the toolbar icon (right-click → Options).",
      "Paste this key into the License section.",
      "Click Activate."
    ];

if (!apiKey || !fromAddress) {
  console.error("RESEND_API_KEY and RESEND_FROM_EMAIL must be set in env.");
  process.exit(2);
}

const text = [
  `Thanks for purchasing ${productName}.`,
  "",
  `Your license key:  ${licenseKey}`,
  "",
  "To activate:",
  ...activationSteps.map((step, index) => `  ${index + 1}. ${step}`),
  "",
  `The license works on up to ${maxDevices} browser installations. Save this email for reactivation.`,
].join("\n");

const html = `
  <p>Thanks for purchasing ${productName}.</p>
  <p>Your license key:</p>
  <p style="font-family: ui-monospace, Menlo, monospace; font-size: 18px; padding: 12px 14px; background: #f4f4f0; border-radius: 4px; border: 1px solid #ddd; letter-spacing: 0.5px;">
    ${licenseKey}
  </p>
  <p>To activate:</p>
  <ol>
    ${activationSteps.map((step) => `<li>${step}</li>`).join("")}
  </ol>
  <p style="color: #666; font-size: 13px;">
    The license works on up to ${maxDevices} browser installations. Save this email so you can reactivate later.
  </p>
`;

const response = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: fromAddress,
    to: toEmail,
    subject: `Your ${productName} license key`,
    text,
    html,
  }),
});

if (!response.ok) {
  const detail = await response.text().catch(() => "");
  console.error(`Resend ${response.status}: ${detail.slice(0, 500)}`);
  process.exit(1);
}

const result = await response.json();
console.log(`Sent to ${toEmail}. Resend message id: ${result.id}`);
