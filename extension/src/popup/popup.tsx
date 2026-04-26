import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function Popup() {
  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>Video Archive</h2>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "#666" }}>
        Detection layer arrives in Session 3.
      </p>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
