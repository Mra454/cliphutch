import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CAPTURE_PACK_MAX_HEIGHT_OPTIONS,
  DEFAULT_SETTINGS,
  getSettings,
  resetSettings,
  setSettings,
  type CapturePackMaxHeight,
  type CapturePackQualityMode,
  type FilenameTemplate,
  type UserSettings,
} from "../lib/storage-local";
import { CHECKOUT_URL, HARD_HLS_SIZE_CAP_BYTES, PRICE_USD } from "../lib/constants";
import {
  dismissLicenseNotice,
  getLicense,
  getLicenseNotice,
  LICENSE_FORMAT_HINT,
  type LicenseNotice,
  type LicenseState,
} from "../lib/license";
import {
  activateLicense,
  deactivateLicense,
  removeLicenseLocally,
} from "../lib/license-client";
import { claimPendingIntent, clearPendingIntent } from "../lib/download-intent";

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
  const [activating, setActivating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deactivateConfirming, setDeactivateConfirming] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivationError, setDeactivationError] = useState<string | null>(null);
  const [deactivationStatus, setDeactivationStatus] = useState<string | null>(null);
  const [canRemoveLocally, setCanRemoveLocally] = useState(false);
  const [localRemovalConfirming, setLocalRemovalConfirming] = useState(false);
  const [licenseNotice, setLicenseNotice] = useState<LicenseNotice | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const licenseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activationPendingRef = useRef(false);

  useEffect(() => {
    void Promise.all([getSettings(), getLicense(), getLicenseNotice()])
      .then(([s, l, notice]) => {
        setLocal(s);
        setCapInputMB(String(bytesToMB(s.hlsSizeCapBytes)));
        setLicenseState(l);
        setLicenseNotice(notice);
      })
      .catch(() => {
        setLoadError("ClipHutch could not load these settings. Close and reopen the Options page to try again.");
      });
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local") return;
      if (changes.license) void getLicense().then(setLicenseState);
      if (changes["license-notice"]) {
        void getLicenseNotice().then(setLicenseNotice);
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      if (licenseTimer.current) clearTimeout(licenseTimer.current);
    };
  }, []);

  if (!settings) {
    return (
      <div
        role={loadError ? "alert" : "status"}
        aria-live={loadError ? "assertive" : "polite"}
        style={{ padding: 16 }}
      >
        {loadError ?? "Loading options…"}
      </div>
    );
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

  async function changeCapturePackQualityMode(value: CapturePackQualityMode) {
    const next = { ...settings!, capturePackQualityMode: value };
    setLocal(next);
    await setSettings({ capturePackQualityMode: value });
    flashSaved();
  }

  async function changeCapturePackMaxHeight(value: CapturePackMaxHeight | undefined) {
    const next = { ...settings! };
    if (value === undefined) {
      delete next.capturePackMaxHeight;
    } else {
      next.capturePackMaxHeight = value;
    }
    setLocal(next);
    await setSettings({ capturePackMaxHeight: value });
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
    if (!claimPendingIntent(activationPendingRef)) return;
    setActivating(true);
    setLicenseError(null);
    setLicenseFlashOk(false);
    try {
      const r = await activateLicense(licenseInput);
      if (!r.ok) {
        setLicenseError(r.error);
        return;
      }
      setLicenseState(await getLicense());
      setLicenseInput("");
      setLicenseNotice(null);
      setLicenseFlashOk(true);
      if (licenseTimer.current) clearTimeout(licenseTimer.current);
      licenseTimer.current = setTimeout(() => {
        setLicenseFlashOk(false);
        licenseTimer.current = null;
      }, 2000);
    } catch {
      setLicenseError("ClipHutch could not finish activation. Check your connection and try again.");
    } finally {
      clearPendingIntent(activationPendingRef);
      setActivating(false);
    }
  }

  async function deactivate() {
    // Two-stage confirm: first click reveals persistent explicit actions.
    // window.confirm() is silently blocked in extension Options pages opened
    // via options_ui with open_in_tab:false, so we render the confirmation
    // inline instead.
    if (!deactivateConfirming) {
      setDeactivationError(null);
      setCanRemoveLocally(false);
      setDeactivateConfirming(true);
      return;
    }
    setDeactivating(true);
    setDeactivationError(null);
    setCanRemoveLocally(false);
    try {
      const result = await deactivateLicense();
      if (!result.ok) {
        setDeactivationError(result.error);
        setCanRemoveLocally(result.canRemoveLocally);
        return;
      }
      setLicenseState({});
      setLicenseNotice(null);
      setDeactivationStatus("Device slot freed. This browser is now on the free tier.");
    } catch {
      setDeactivationError(
        "ClipHutch could not confirm that this device slot was freed. Try again while online.",
      );
      setCanRemoveLocally(true);
    } finally {
      setDeactivateConfirming(false);
      setDeactivating(false);
    }
  }

  async function removeLocalLicenseOnly() {
    if (!localRemovalConfirming) {
      setLocalRemovalConfirming(true);
      return;
    }
    try {
      await removeLicenseLocally();
      setLicenseState({});
      setLicenseNotice(null);
      setCanRemoveLocally(false);
      setDeactivationError(null);
      setDeactivationStatus(
        "Local key removed. The server slot was not freed. Re-enter the key and retry while online, or contact support.",
      );
    } catch {
      setDeactivationError("ClipHutch could not remove the local key. Try again.");
    } finally {
      setLocalRemovalConfirming(false);
    }
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
          <span role="status" aria-live="polite" style={{ color: "#2c5e2c", fontSize: 12 }}>Saved.</span>
        )}
      </header>

      <fieldset style={{ ...sectionStyle, minWidth: 0 }}>
        <legend style={labelStyle}>Filename template</legend>
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
      </fieldset>

      <fieldset style={{ ...sectionStyle, minWidth: 0 }}>
        <legend style={labelStyle}>Capture Pack stream quality</legend>
        <label style={{ display: "block", marginTop: 6, cursor: "pointer" }}>
          <input
            type="radio"
            name="capturePackQualityMode"
            value="best_under_cap"
            checked={settings.capturePackQualityMode === "best_under_cap"}
            onChange={() => void changeCapturePackQualityMode("best_under_cap")}
            style={{ marginRight: 6 }}
          />
          Best under saved cap
        </label>
        <div style={helpStyle}>
          Automatically selects the best supported stream using 10% headroom below the saved
          cap. An Unknown size requires your choice and is never assumed to fit. The saved cap
          remains the hard runtime download limit.
        </div>
        <label style={{ display: "block", marginTop: 10, cursor: "pointer" }}>
          <input
            type="radio"
            name="capturePackQualityMode"
            value="manual"
            checked={settings.capturePackQualityMode === "manual"}
            onChange={() => void changeCapturePackQualityMode("manual")}
            style={{ marginRight: 6 }}
          />
          Choose during Review
        </label>
        <div style={helpStyle}>Always ask you to choose the stream rendition.</div>
        <label htmlFor="capture-pack-max-height" style={{ ...labelStyle, marginTop: 12 }}>
          Maximum automatic height
        </label>
        <select
          id="capture-pack-max-height"
          value={settings.capturePackMaxHeight === undefined ? "" : String(settings.capturePackMaxHeight)}
          disabled={settings.capturePackQualityMode === "manual"}
          aria-describedby="capture-pack-max-height-help"
          onChange={(event) => {
            const raw = event.target.value;
            const value = CAPTURE_PACK_MAX_HEIGHT_OPTIONS.find(
              (height) => String(height) === raw,
            );
            if (raw === "" || value !== undefined) {
              void changeCapturePackMaxHeight(value);
            }
          }}
          style={{ padding: 4, fontSize: 14 }}
        >
          <option value="">Any</option>
          {CAPTURE_PACK_MAX_HEIGHT_OPTIONS.map((height) => (
            <option key={height} value={height}>{height}p</option>
          ))}
        </select>
        <div id="capture-pack-max-height-help" style={helpStyle}>
          Limits automatic choices only; manual Review choices remain available.
        </div>
      </fieldset>

      <section style={sectionStyle}>
        <label htmlFor="cap" style={labelStyle}>
          Stream download cap (MB)
        </label>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            id="cap"
            type="number"
            min={MIN_CAP_MB}
            max={MAX_CAP_MB}
            value={capInputMB}
            aria-invalid={capError ? true : undefined}
            aria-describedby={capError ? "cap-help cap-error" : "cap-help"}
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
          <div id="cap-error" role="alert" style={{ color: "#a02a1f", fontSize: 12, marginTop: 4 }}>{capError}</div>
        )}
        <div id="cap-help" style={helpStyle}>
          Capture Pack automatic selection keeps 10% headroom below this saved cap; the full
          saved cap remains the hard runtime download limit. Existing HLS downloads continue to
          use the same setting. Pre-flight estimates and running byte totals are checked against
          it. Hard ceiling enforced at {MAX_CAP_MB} MB.
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
          When off, ClipHutch hides query strings behind a "show full URL" toggle on each card.
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={headingStyle}>License</h2>
        {licenseNotice && (
          <div
            role="alert"
            style={{ color: "#8a251c", fontSize: 13, marginBottom: 10 }}
          >
            {licenseNotice.message}{" "}
            <button
              type="button"
              onClick={() => {
                void dismissLicenseNotice().then(() => setLicenseNotice(null));
              }}
              style={{ fontSize: "inherit" }}
            >
              Dismiss
            </button>
          </div>
        )}
        {deactivationStatus && (
          <div role="status" aria-live="polite" style={{ fontSize: 13, marginBottom: 10 }}>
            {deactivationStatus}{" "}
            <a href="mailto:licenses@cliphutch.com">Contact support</a>
          </div>
        )}
        {license.key ? (
          <div>
            <div role="status" aria-live="polite" style={{ fontSize: 13, color: "#2c5e2c", marginBottom: 6 }}>
              <strong>Licensed</strong> - unlimited video downloads.
              {licenseFlashOk ? " License activated." : ""}
            </div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
              Key: <code>{license.key}</code>
              {license.activatedAt && (
                <span> - activated {new Date(license.activatedAt).toLocaleDateString()}</span>
              )}
            </div>
            <button
              onClick={() => void deactivate()}
              disabled={deactivating}
              aria-describedby={deactivationError ? "deactivation-error" : undefined}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                cursor: deactivating ? "default" : "pointer",
                ...(deactivateConfirming
                  ? { borderColor: "#c00", color: "#c00", fontWeight: 600 }
                  : {}),
              }}
            >
              {deactivating
                ? "Freeing device slot…"
                : deactivateConfirming
                  ? "Free this device slot"
                  : "Deactivate"}
            </button>
            {deactivateConfirming && !deactivating && (
              <button
                type="button"
                onClick={() => setDeactivateConfirming(false)}
                style={{ marginLeft: 8, padding: "4px 10px", fontSize: 12 }}
              >
                Cancel
              </button>
            )}
            {deactivationError && (
              <div
                id="deactivation-error"
                role="alert"
                style={{ color: "#a02a1f", fontSize: 12, marginTop: 8 }}
              >
                {deactivationError} Your license remains on this browser.
              </div>
            )}
            {canRemoveLocally && (
              <button
                onClick={() => void removeLocalLicenseOnly()}
                aria-describedby="local-removal-warning"
                style={{ display: "block", marginTop: 8, fontSize: 12 }}
              >
                {localRemovalConfirming
                  ? "Confirm local removal"
                  : "Remove local key; server slot stays occupied"}
              </button>
            )}
            {canRemoveLocally && (
              <div id="local-removal-warning" style={{ ...helpStyle, color: "#8a251c" }}>
                This recovery removes the local key but does not free the server device slot.
                {localRemovalConfirming && (
                  <>{" "}<button type="button" onClick={() => setLocalRemovalConfirming(false)}>Cancel</button></>
                )}
              </div>
            )}
          </div>
        ) : (
          <div aria-busy={activating}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <strong>Free tier</strong> - 4 video downloads per 24 hours. Still-image downloads do not count against this limit. Get unlimited video downloads with a one-time payment of ${PRICE_USD} (no subscription).
            </div>
            <label htmlFor="license-key" style={labelStyle}>License key</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <input
                id="license-key"
                type="text"
                placeholder={LICENSE_FORMAT_HINT}
                value={licenseInput}
                disabled={activating}
                aria-invalid={licenseError ? true : undefined}
                aria-describedby={licenseError ? "license-format-hint license-error" : "license-format-hint"}
                onChange={(e) => setLicenseInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void activate();
                }}
                style={{ flex: 1, padding: 5, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace" }}
              />
              <button
                onClick={() => void activate()}
                disabled={activating}
                style={{ padding: "5px 10px", fontSize: 12, cursor: activating ? "not-allowed" : "pointer" }}
              >
                {activating ? "Activating…" : "Activate"}
              </button>
            </div>
            <div id="license-format-hint" style={{ ...helpStyle, marginBottom: 6 }}>
              Enter the key in this format: {LICENSE_FORMAT_HINT}
            </div>
            {activating ? (
              <div role="status" aria-live="polite" style={{ color: "#555", fontSize: 12, marginTop: 6 }}>
                Checking this license key. The activation controls are temporarily disabled.
              </div>
            ) : null}
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
              <div id="license-error" role="alert" style={{ color: "#a02a1f", fontSize: 12, marginTop: 6 }}>{licenseError}</div>
            )}
            {licenseFlashOk && (
              <div role="status" aria-live="polite" style={{ color: "#2c5e2c", fontSize: 12, marginTop: 6 }}>License activated.</div>
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
          Sources and sites hidden from ClipHutch shelves. Use these for ad/CDN
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
