// src/main.jsx (override console at the absolute top)

// ─────────────────────────────────────────────
// Global reference to the log container (DOM query once available)
// ─────────────────────────────────────────────
let logContainer = null;

// Level-specific colors (customize as needed)
const levelColors = {
  log: "#e0e0e0",
  info: "#a5d6ff",
  debug: "#a5d6ff",
  warn: "#ffcc66",
  error: "#ff6b6b",
};

// Core logging function (appends to panel + optional browser console fallback)
function appendToPanel(level, ...args) {
  // Lazy-init the container reference (safe for early logs before DOM ready)
  if (!logContainer) {
    logContainer = document.getElementById("log-panel");
    if (!logContainer) return; // Exit early if panel not yet in DOM
  }

  const time = new Date().toLocaleTimeString([], { hour12: false });
  const lvl = level.toUpperCase().padEnd(5);
  const color = levelColors[level] || "#e0e0e0";

  // Format arguments (handle objects)
  const message = args
    .map((arg) =>
      typeof arg === "object" && arg !== null ? JSON.stringify(arg, null, 2) : String(arg),
    )
    .join(" ");

  //window.alert(message);

  // HTML line with <br> for multi-line
  const line =
    `<span style="color:#777;">${time}</span> ` +
    `<span style="color:${color}; font-weight:600;">${lvl}</span> ` +
    `<span style="color:${color};">${message.replace(/\n/g, "<br>")}</span><br>`;

  // Append and auto-scroll
  logContainer.insertAdjacentHTML("beforeend", line);
  logContainer.scrollTop = logContainer.scrollHeight;

  // Optional: Forward to real browser console (remove if unwanted, e.g., for production)
  const originalConsole = window.originalConsole || console;
  originalConsole[level](...args);
}

// Custom console object
const overriddenConsole = {
  log: (...args) => appendToPanel("log", ...args),
  info: (...args) => appendToPanel("info", ...args),
  debug: (...args) => appendToPanel("debug", ...args),
  warn: (...args) => appendToPanel("warn", ...args),
  error: (...args) => appendToPanel("error", ...args),

  // Stubs for other methods (expand if you use them)
  group: () => {},
  groupEnd: () => {},
  time: () => {},
  timeEnd: () => {},
  table: () => {},
  clear: () => {
    if (logContainer) logContainer.innerHTML = "";
  },
};

// ─────────────────────────────────────────────
// Replace global console (save original if needed)
// ─────────────────────────────────────────────
window.originalConsole = window.console; // Backup for optional forwarding
window.console = overriddenConsole;

//window.alert("main.jsx: window console overriden");

// ─────────────────────────────────────────────
// Rest of your original main.jsx (unchanged)
// ─────────────────────────────────────────────
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
