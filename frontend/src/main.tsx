import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { celebrateIfUpdated } from "./lib/update";
import { fitViewport } from "./lib/feel";

fitViewport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

celebrateIfUpdated();

// The service worker is needed for push too, so register it everywhere but the dev server.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
