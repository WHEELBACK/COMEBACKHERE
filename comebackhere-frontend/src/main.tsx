import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { ToastProvider } from "./components/Toast"
import { configErrors } from "./config"
import "./components/Toast.css"

/**
 * Configuration error screen rendered when one or more required VITE_
 * environment variables are missing or malformed. This replaces the whole app
 * so users see a clear, actionable message instead of a blank page or cryptic
 * Soroban RPC error.
 */
function ConfigErrorScreen() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: "640px",
        margin: "64px auto",
        padding: "0 24px",
      }}
    >
      <h1 style={{ color: "#c0392b", marginBottom: "8px" }}>Configuration Error</h1>
      <p style={{ marginBottom: "16px", color: "#555" }}>
        The application cannot start because one or more required environment
        variables are missing or invalid. Fix the issues listed below and restart
        the dev server (or rebuild).
      </p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
        aria-label="Configuration errors"
      >
        {configErrors.map((err) => (
          <li
            key={err.variable}
            style={{
              background: "#fef2f2",
              border: "1px solid #fca5a5",
              borderRadius: "6px",
              padding: "10px 14px",
            }}
          >
            <code style={{ fontWeight: 700, color: "#991b1b" }}>{err.variable}</code>
            <span style={{ color: "#7f1d1d", marginLeft: "8px" }}>{err.message}</span>
          </li>
        ))}
      </ul>
      <p style={{ marginTop: "24px", fontSize: "0.875rem", color: "#888" }}>
        Copy <code>.env.local.example</code> to <code>.env.local</code> and fill
        in the missing values, then restart the server.
      </p>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {configErrors.length > 0 ? (
      <ConfigErrorScreen />
    ) : (
      <ToastProvider>
        <App />
      </ToastProvider>
    )}
  </React.StrictMode>
)
