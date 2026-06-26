import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { SettlementApproval } from './components/SettlementApproval'
import { ToastProvider } from './components/Toast'
import './components/Toast.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/settlements" element={<SettlementApproval />} />
          <Route path="*" element={<Navigate to="/settlements" replace />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  </React.StrictMode>,
)
