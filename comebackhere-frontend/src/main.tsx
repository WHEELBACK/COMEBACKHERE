import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { ToastProvider } from "./components/Toast"
import { I18nProvider } from "./i18n"
import "./components/Toast.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </I18nProvider>
  </React.StrictMode>
)
