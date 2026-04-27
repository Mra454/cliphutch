// Resend client for sending license-key emails.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendLicenseEmail(
  to: string,
  licenseKey: string,
  apiKey: string,
  fromAddress: string,
): Promise<void> {
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

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to,
      subject: "Your ClipHutch license key",
      text,
      html,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend ${response.status}: ${detail.slice(0, 300)}`);
  }
}
