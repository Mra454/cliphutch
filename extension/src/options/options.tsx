import { StrictMode, useEffect, useRef, useState } from "react";
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
    value: "auto",
    label: "Automatic",
    help: "Pick the most readable name available: a real filename when the URL has one, otherwise the page title. Skips random CDN ids and hashes.",
  },
  {
    value: "urlBasename",
    label: "URL basename",
    help: "Always use the last path segment of the video URL (e.g., movie.mp4).",
  },
  {
    value: "pageTitle",
    label: "Page title",
    help: "Use the title of the page that the video was detected on.",
  },
  {
    value: "timestamp",
    label: "Site and date",
    help: "Use the source site host and the download date (e.g., example-com-2026-07-03.mp4).",
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

const headingStyle: React.CSSProperties = {
  margin: "0 0 0.6em",
  fontSize: 16,
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
  const [deactivateConfirming, setDeactivateConfirming] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void Promise.all([getSettings(), getLicense()]).then(([s, l]) => {
      setLocal(s);
      setCapInputMB(String(bytesToMB(s.hlsSizeCapBytes)));
      setLicenseState(l);
    });
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  if (!settings) {
    return <div style={{ padding: 16 }}>Loading…</div>;
  }

  function flashSaved() {
    setSavedAt(Date.now());
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => {
      setSavedAt(null);
      savedTimer.current = null;
    }, 2000);
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

  async function removeIgnoredSource(host: string) {
    const ignoredSourceHosts = settings!.ignoredSourceHosts.filter((h) => h !== host);
    const next = { ...settings!, ignoredSourceHosts };
    setLocal(next);
    await setSettings({ ignoredSourceHosts });
    flashSaved();
  }

  async function removeIgnoredPage(host: string) {
    const ignoredPageHosts = settings!.ignoredPageHosts.filter((h) => h !== host);
    const next = { ...settings!, ignoredPageHosts };
    setLocal(next);
    await setSettings({ ignoredPageHosts });
    flashSaved();
  }

  async function clearIgnoredDomains() {
    const next = { ...settings!, ignoredSourceHosts: [], ignoredPageHosts: [] };
    setLocal(next);
    await setSettings({ ignoredSourceHosts: [], ignoredPageHosts: [] });
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
    // Two-stage confirm: first click arms, second click within 3s commits.
    // window.confirm() is silently blocked in extension Options pages opened
    // via options_ui with open_in_tab:false, so we render the confirmation
    // inline instead.
    if (!deactivateConfirming) {
      setDeactivateConfirming(true);
      setTimeout(() => setDeactivateConfirming(false), 3000);
      return;
    }
    await deactivateLicense();
    setLicenseState({});
    setDeactivateConfirming(false);
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

  function openExtensionFile(path: string) {
    window.open(chrome.runtime.getURL(path), "_blank");
  }

  const showSaved = savedAt !== null && Date.now() - savedAt < 2000;

  return (
    <div style={{ padding: "1.25em 1.5em", maxWidth: 560 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>ClipHutch - Options</h1>
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
              <strong>Licensed</strong> - unlimited video downloads.
            </div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
              Key: <code>{license.key}</code>
              {license.activatedAt && (
                <span> - activated {new Date(license.activatedAt).toLocaleDateString()}</span>
              )}
            </div>
            <button
              onClick={() => void deactivate()}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                cursor: "pointer",
                ...(deactivateConfirming
                  ? { borderColor: "#c00", color: "#c00", fontWeight: 600 }
                  : {}),
              }}
            >
              {deactivateConfirming ? "Click again to confirm" : "Deactivate"}
            </button>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <strong>Free tier</strong> - 4 video downloads per 24 hours. Still-image downloads do not count against this limit. Get unlimited video downloads with a one-time payment of ${PRICE_USD} (no subscription).
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
                title="One-time payment, no subscription"
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
                Buy license - ${PRICE_USD} one-time
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

      <section style={sectionStyle}>
        <h2 style={headingStyle}>Domain filters</h2>
        <p style={{ marginTop: 0, fontSize: 13, color: "#555" }}>
          Sources and sites hidden from the popup shelf. Use these for ad/CDN
          noise or pages you do not want ClipHutch to list.
        </p>
        {settings.ignoredSourceHosts.length === 0 && settings.ignoredPageHosts.length === 0 ? (
          <p style={{ ...helpStyle, marginBottom: 0 }}>No domain filters yet.</p>
        ) : (
          <>
            {settings.ignoredSourceHosts.length > 0 ? (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Hidden sources</div>
                {settings.ignoredSourceHosts.map((host) => (
                  <button
                    key={`source:${host}`}
                    onClick={() => void removeIgnoredSource(host)}
                    title={`Remove ${host}`}
                    style={{ margin: "0 6px 6px 0", padding: "3px 7px", fontSize: 12, cursor: "pointer" }}
                  >
                    {host} x
                  </button>
                ))}
              </div>
            ) : null}
            {settings.ignoredPageHosts.length > 0 ? (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Ignored sites</div>
                {settings.ignoredPageHosts.map((host) => (
                  <button
                    key={`page:${host}`}
                    onClick={() => void removeIgnoredPage(host)}
                    title={`Remove ${host}`}
                    style={{ margin: "0 6px 6px 0", padding: "3px 7px", fontSize: 12, cursor: "pointer" }}
                  >
                    {host} x
                  </button>
                ))}
              </div>
            ) : null}
            <button onClick={() => void clearIgnoredDomains()} style={{ padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
              Clear domain filters
            </button>
          </>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={headingStyle}>Licenses and source</h2>
        <p style={{ marginTop: 0, fontSize: 13, color: "#555" }}>
          ClipHutch bundles @ffmpeg/core for local WebM conversion.
          Third-party notices, license text, and the source-code offer are
          included with the extension.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => openExtensionFile("THIRD_PARTY_NOTICES.txt")}
            style={{ padding: "5px 10px", fontSize: 12, cursor: "pointer" }}
          >
            Third-party notices
          </button>
          <button
            onClick={() => openExtensionFile("SOURCE_OFFER.txt")}
            style={{ padding: "5px 10px", fontSize: 12, cursor: "pointer" }}
          >
            Source-code offer
          </button>
        </div>
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
