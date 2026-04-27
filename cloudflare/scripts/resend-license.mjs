#!/usr/bin/env node
// Operator tool: send (or re-send) the ClipHutch license-key email for a
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

if (!apiKey || !fromAddress) {
  console.error("RESEND_API_KEY and RESEND_FROM_EMAIL must be set in env.");
  process.exit(2);
}

const text = [
  "Thanks for purchasing ClipHutch.",
  "",
  `Your license key:  ${licenseKey}`,
  "",
  "To activate:",
  "  1. Open ClipHutch's options page from the toolbar icon",
  "  2. Paste this key into the License section",
  "  3. Click Activate",
  "",
  "The license works on up to 5 devices. Save this email for reactivation.",
].join("\n");

const html = `
  <p>Thanks for purchasing ClipHutch.</p>
  <p>Your license key:</p>
  <p style="font-family: ui-monospace, Menlo, monospace; font-size: 18px; padding: 12px 14px; background: #f4f4f0; border-radius: 4px; border: 1px solid #ddd; letter-spacing: 0.5px;">
    ${licenseKey}
  </p>
  <p>To activate:</p>
  <ol>
    <li>Open ClipHutch's options page from the toolbar icon (right-click &rarr; Options).</li>
    <li>Paste this key into the License section.</li>
    <li>Click Activate.</li>
  </ol>
  <p style="color: #666; font-size: 13px;">
    The license works on up to 5 devices. Save this email so you can reactivate later.
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
    subject: "Your ClipHutch license key",
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
