import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_SETTINGS,
  getSettings,
  resetSettings,
  setSettings,
  type FilenameTemplate,
  type UserSettings,
} from "../lib/storage-local";
import { CHECKOUT_URL, HARD_HLS_SIZE_CAP_BYTES, PRICE_USD } from "../lib/constants";
import {
  activateLicense,
  deactivateLicense,
  getLicense,
  LICENSE_FORMAT_HINT,
  type LicenseState,
} from "../lib/license";

console.log("[cliphutch] options page loaded");

const MIN_CAP_MB = 50;
const MAX_CAP_MB = Math.round(HARD_HLS_SIZE_CAP_BYTES / (1024 * 1024));

function bytesToMB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function mbToBytes(mb: number): number {
  return mb * 1024 * 1024;
}

const FILENAME_OPTIONS: { value: FilenameTemplate; label: string; help: string }[] = [
  {
    value: "urlBasename",
    label: "URL basename",
    help: "Use the last path segment of the video URL (e.g., movie.mp4).",
  },
  {
    value: "pageTitle",
    label: "Page title",
    help: "Use the title of the page that the video was detected on.",
  },
  {
    value: "timestamp",
    label: "Timestamp",
    help: "Use the date and time the video was detected.",
  },
];

const sectionStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e0e0e0",
  borderRadius: 8,
  padding: "1em 1.25em",
  marginTop: "1em",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 600,
  marginBottom: 4,
};

const helpStyle: React.CSSProperties = {
  color: "#666",
  fontSize: 13,
  marginTop: 4,
};

function Options() {
  const [settings, setLocal] = useState<UserSettings | null>(null);
  const [capInputMB, setCapInputMB] = useState<string>("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [capError, setCapError] = useState<string | null>(null);
  const [license, setLicenseState] = useState<LicenseState>({});
  const [licenseInput, setLicenseInput] = useState("");
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [licenseFlashOk, setLicenseFlashOk] = useState(false);

  useEffect(() => {
    void Promise.all([getSettings(), getLicense()]).then(([s, l]) => {
      setLocal(s);
      setCapInputMB(String(bytesToMB(s.hlsSizeCapBytes)));
      setLicenseState(l);
    });
  }, []);

  if (!settings) {
    return <div style={{ padding: 16 }}>Loading…</div>;
  }

  function flashSaved() {
    setSavedAt(Date.now());
  }

  async function changeTemplate(value: FilenameTemplate) {
    const next = { ...settings!, filenameTemplate: value };
    setLocal(next);
    await setSettings({ filenameTemplate: value });
    flashSaved();
  }

  async function changeShowFull(value: boolean) {
    const next = { ...settings!, showFullUrlsByDefault: value };
    setLocal(next);
    await setSettings({ showFullUrlsByDefault: value });
    flashSaved();
  }

  async function commitCap() {
    const mb = Number.parseInt(capInputMB, 10);
    if (!Number.isFinite(mb) || mb < MIN_CAP_MB || mb > MAX_CAP_MB) {
      setCapError(`Enter a value between ${MIN_CAP_MB} and ${MAX_CAP_MB} MB.`);
      return;
    }
    setCapError(null);
    const bytes = mbToBytes(mb);
    const next = { ...settings!, hlsSizeCapBytes: bytes };
    setLocal(next);
    await setSettings({ hlsSizeCapBytes: bytes });
    flashSaved();
  }

  async function resetAll() {
    await resetSettings();
    setLocal(DEFAULT_SETTINGS);
    setCapInputMB(String(bytesToMB(DEFAULT_SETTINGS.hlsSizeCapBytes)));
    setCapError(null);
    flashSaved();
  }

  async function activate() {
    setLicenseError(null);
    setLicenseFlashOk(false);
    const r = await activateLicense(licenseInput);
    if (!r.ok) {
      setLicenseError(r.error);
      return;
    }
    setLicenseState(await getLicense());
    setLicenseInput("");
    setLicenseFlashOk(true);
    setTimeout(() => setLicenseFlashOk(false), 2000);
  }

  async function deactivate() {
    if (!window.confirm("Deactivate this license? You will return to the free tier.")) return;
    await deactivateLicense();
    setLicenseState({});
  }

  function openCheckout() {
    if (CHECKOUT_URL.startsWith("http")) {
      window.open(CHECKOUT_URL, "_blank");
    } else {
      window.alert(
        "Checkout link not configured yet. Set CHECKOUT_URL in extension/src/lib/constants.ts to your Stripe checkout URL.",
      );
    }
  }

  const showSaved = savedAt !== null && Date.now() - savedAt < 2000;

  return (
    <div style={{ padding: "1.25em 1.5em", maxWidth: 560 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>ClipHutch — Options</h1>
        {showSaved && (
          <span style={{ color: "#2c5e2c", fontSize: 12 }}>Saved.</span>
        )}
      </header>

      <section style={sectionStyle}>
        <span style={labelStyle}>Filename template</span>
        {FILENAME_OPTIONS.map((opt) => (
          <label key={opt.value} style={{ display: "block", marginTop: 6, cursor: "pointer" }}>
            <input
              type="radio"
              name="filenameTemplate"
              value={opt.value}
              checked={settings.filenameTemplate === opt.value}
              onChange={() => void changeTemplate(opt.value)}
              style={{ marginRight: 6 }}
            />
            {opt.label}
            <div style={helpStyle}>{opt.help}</div>
          </label>
        ))}
      </section>

      <section style={sectionStyle}>
        <label htmlFor="cap" style={labelStyle}>
          HLS size cap (MB)
        </label>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            id="cap"
            type="number"
            min={MIN_CAP_MB}
            max={MAX_CAP_MB}
            value={capInputMB}
            onChange={(e) => setCapInputMB(e.target.value)}
            onBlur={() => void commitCap()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitCap();
            }}
            style={{ width: 100, padding: 4, fontSize: 14 }}
          />
          <span style={{ color: "#666", fontSize: 13 }}>
            (range {MIN_CAP_MB}–{MAX_CAP_MB} MB, default {bytesToMB(DEFAULT_SETTINGS.hlsSizeCapBytes)})
          </span>
        </div>
        {capError && (
          <div style={{ color: "#a02a1f", fontSize: 12, marginTop: 4 }}>{capError}</div>
        )}
        <div style={helpStyle}>
          Pre-flight estimate and running byte total are both checked against this cap. Hard
          ceiling enforced at {MAX_CAP_MB} MB.
        </div>
      </section>

      <section style={sectionStyle}>
        <label style={{ display: "block", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={settings.showFullUrlsByDefault}
            onChange={(e) => void changeShowFull(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Show full URLs by default
        </label>
        <div style={helpStyle}>
          When off, the popup hides query strings behind a "show full URL" toggle on each card.
        </div>
      </section>

      <section style={sectionStyle}>
        <span style={labelStyle}>License</span>
        {license.key ? (
          <div>
            <div style={{ fontSize: 13, color: "#2c5e2c", marginBottom: 6 }}>
              <strong>Licensed</strong> — unlimited downloads.
            </div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
              Key: <code>{license.key}</code>
              {license.activatedAt && (
                <span> — activated {new Date(license.activatedAt).toLocaleDateString()}</span>
              )}
            </div>
            <button
              onClick={() => void deactivate()}
              style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
            >
              Deactivate
            </button>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <strong>Free tier</strong> — 4 downloads per 24 hours. Unlock unlimited downloads with a one-time payment of ${PRICE_USD} (no subscription).
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <input
                type="text"
                placeholder={LICENSE_FORMAT_HINT}
                value={licenseInput}
                onChange={(e) => setLicenseInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void activate();
                }}
                style={{ flex: 1, padding: 5, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace" }}
              />
              <button
                onClick={() => void activate()}
                style={{ padding: "5px 10px", fontSize: 12, cursor: "pointer" }}
              >
                Activate
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
              <button
                onClick={openCheckout}
                title="One-time payment — no subscription"
                style={{
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  background: "#2c5e2c",
                  color: "#fff",
                  border: "1px solid #2c5e2c",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Buy license — ${PRICE_USD} one-time
              </button>
              <span style={helpStyle}>License is emailed after purchase. No subscription.</span>
            </div>
            {licenseError && (
              <div style={{ color: "#a02a1f", fontSize: 12, marginTop: 6 }}>{licenseError}</div>
            )}
            {licenseFlashOk && (
              <div style={{ color: "#2c5e2c", fontSize: 12, marginTop: 6 }}>License activated.</div>
            )}
          </div>
        )}
      </section>

      <section style={{ ...sectionStyle, background: "#f6f6f0", borderColor: "#dcd6b8" }}>
        <p style={{ margin: 0, fontSize: 13, color: "#444" }}>
          Default download folder is controlled by Chrome at{" "}
          <code>chrome://settings/downloads</code>.
        </p>
      </section>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1em" }}>
        <button
          onClick={() => void resetAll()}
          style={{ padding: "6px 12px", fontSize: 13, cursor: "pointer" }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Options />
    </StrictMode>,
  );
}
