import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceShell } from "../popup/popup";

/**
 * O5 side-panel entry point.
 *
 * The shared workspace shell is mounted here by the UI integration slice. Keep
 * this packaged entry independent of popup lifecycle so Chrome can own the
 * global panel instance for the current browser window.
 */
function SidePanelWorkspace() {
  return (
    <main
      data-cliphutch-sidepanel-root
      data-cliphutch-side-panel-shell="v1"
      style={{
        boxSizing: "border-box",
        minWidth: 0,
      }}
    >
      <WorkspaceShell surface="sidepanel" />
    </main>
  );
}

const root = document.getElementById("sidepanel-root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <SidePanelWorkspace />
    </StrictMode>,
  );
}
