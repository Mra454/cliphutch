// Resend client for sending license-key emails.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

type LicenseEmailProduct = "cliphutch" | "computedkit";

function emailCopy(product: LicenseEmailProduct): {
  productName: string;
  activationSteps: readonly string[];
  maxDevices: number;
} {
  if (product === "computedkit") {
    return {
      productName: "ComputedKit Pro",
      activationSteps: [
        "Open ComputedKit from Chrome's toolbar.",
        "In the ComputedKit Pro Baselines & Compare card, paste this key.",
        "Select Activate Pro."
      ],
      maxDevices: 3
    };
  }
  return {
    productName: "ClipHutch",
    activationSteps: [
      "Open ClipHutch's options page from the toolbar icon (right-click → Options).",
      "Paste this key into the License section.",
      "Click Activate."
    ],
    maxDevices: 5
  };
}

export async function sendLicenseEmail(
  to: string,
  licenseKey: string,
  apiKey: string,
  fromAddress: string,
  product: LicenseEmailProduct = "cliphutch",
): Promise<void> {
  const copy = emailCopy(product);
  const text = [
    `Thanks for purchasing ${copy.productName}.`,
    "",
    `Your license key:  ${licenseKey}`,
    "",
    "To activate:",
    ...copy.activationSteps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    `The license works on up to ${copy.maxDevices} browser installations. Save this email for reactivation.`,
  ].join("\n");

  const html = `
    <p>Thanks for purchasing ${copy.productName}.</p>
    <p>Your license key:</p>
    <p style="font-family: ui-monospace, Menlo, monospace; font-size: 18px; padding: 12px 14px; background: #f4f4f0; border-radius: 4px; border: 1px solid #ddd; letter-spacing: 0.5px;">
      ${licenseKey}
    </p>
    <p>To activate:</p>
    <ol>
      ${copy.activationSteps.map((step) => `<li>${step}</li>`).join("")}
    </ol>
    <p style="color: #666; font-size: 13px;">
      The license works on up to ${copy.maxDevices} browser installations. Save this email so you can reactivate later.
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
      subject: `Your ${copy.productName} license key`,
      text,
      html,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend ${response.status}: ${detail.slice(0, 300)}`);
  }
}
