import { useState, useEffect, useCallback } from "react"
import {
  listMerchantApiKeys,
  createMerchantApiKey,
  rotateMerchantApiKey,
  revokeMerchantApiKey,
  type MerchantApiKeyMetadata,
  type CreateApiKeyResponse,
  ApiError,
} from "../utils/api"
import { CopyableText } from "./CopyableText"
import "./ApiKeyManagement.css"

export interface ApiKeyManagementProps {
  /** Connected merchant wallet address. */
  merchantAddress: string | null
}

function formatDate(isoString?: string | null): string {
  if (!isoString) return "—"
  try {
    const d = new Date(isoString)
    return isNaN(d.getTime()) ? isoString : `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
  } catch {
    return isoString
  }
}

function shortenKeyId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}...${id.slice(-6)}`
}

export function ApiKeyManagement({ merchantAddress }: ApiKeyManagementProps) {
  const [keys, setKeys] = useState<MerchantApiKeyMetadata[]>([])
  const [loading, setLoading] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Secret is shown strictly only at creation/rotation, then cleared
  const [newKeySecret, setNewKeySecret] = useState<{
    keyId: string
    apiKey: string
    isRotation: boolean
  } | null>(null)
  const [copiedSecret, setCopiedSecret] = useState(false)

  // Confirmation modals
  const [showRotateConfirm, setShowRotateConfirm] = useState(false)
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null)

  // Optional admin key for administrator actions
  const [adminKey, setAdminKey] = useState<string>("")
  const [showAdminInput, setShowAdminInput] = useState(false)

  const activeMerchant = merchantAddress?.trim() || null

  const loadKeys = useCallback(async () => {
    if (!activeMerchant) {
      setKeys([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await listMerchantApiKeys(activeMerchant, adminKey.trim() || undefined)
      setKeys(data)
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : "Failed to load merchant API keys")
      }
    } finally {
      setLoading(false)
    }
  }, [activeMerchant, adminKey])

  useEffect(() => {
    if (activeMerchant) {
      void loadKeys()
    } else {
      setKeys([])
      setError(null)
    }
  }, [activeMerchant, loadKeys])

  const handleCreate = async () => {
    if (!activeMerchant || actionPending) return
    setActionPending(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const res: CreateApiKeyResponse = await createMerchantApiKey(
        activeMerchant,
        adminKey.trim() || undefined
      )
      setNewKeySecret({
        keyId: res.key_id,
        apiKey: res.api_key,
        isRotation: false,
      })
      setSuccessMessage("API key generated successfully. Save your secret key immediately.")
      await loadKeys()
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : "Failed to create API key")
      }
    } finally {
      setActionPending(false)
    }
  }

  const handleRotateConfirm = async () => {
    if (!activeMerchant || actionPending) return
    setActionPending(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const res: CreateApiKeyResponse = await rotateMerchantApiKey(
        activeMerchant,
        adminKey.trim() || undefined
      )
      setNewKeySecret({
        keyId: res.key_id,
        apiKey: res.api_key,
        isRotation: true,
      })
      setShowRotateConfirm(false)
      setSuccessMessage("API key rotated. All previous active keys have been revoked.")
      await loadKeys()
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : "Failed to rotate API key")
      }
    } finally {
      setActionPending(false)
    }
  }

  const handleRevokeConfirm = async () => {
    if (!activeMerchant || !revokeTargetId || actionPending) return
    setActionPending(true)
    setError(null)
    setSuccessMessage(null)
    try {
      await revokeMerchantApiKey(
        revokeTargetId,
        activeMerchant,
        adminKey.trim() || undefined
      )
      setSuccessMessage(`API key ${shortenKeyId(revokeTargetId)} was revoked.`)
      setRevokeTargetId(null)
      await loadKeys()
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : "Failed to revoke API key")
      }
    } finally {
      setActionPending(false)
    }
  }

  const handleCopySecret = async () => {
    if (!newKeySecret) return
    try {
      await navigator.clipboard.writeText(newKeySecret.apiKey)
      setCopiedSecret(true)
      setTimeout(() => setCopiedSecret(false), 2500)
    } catch {
      // Fallback
      setCopiedSecret(false)
    }
  }

  const handleDismissSecret = () => {
    // Clear secret key from memory
    setNewKeySecret(null)
    setCopiedSecret(false)
  }

  const hasActiveKey = keys.some((k) => k.is_active)

  return (
    <div className="api-key-management" role="region" aria-label="Merchant API Keys">
      <div className="api-key-header">
        <div>
          <h2 className="api-key-header__title">Merchant API Keys</h2>
          <p className="text-secondary" style={{ fontSize: "0.85rem", marginTop: 4 }}>
            Manage authentication keys for programmatically issuing invoices and listening to webhooks.
          </p>
        </div>
        <div className="api-key-header__actions">
          <button
            className="btn btn--secondary btn--sm"
            onClick={() => setShowAdminInput((prev) => !prev)}
            aria-expanded={showAdminInput}
            title="Configure Admin Key for administrative overrides"
          >
            {showAdminInput ? "Hide Admin Config" : "Admin Config"}
          </button>
          <button
            className="btn btn--secondary btn--sm"
            onClick={loadKeys}
            disabled={loading || !activeMerchant}
            aria-label="Refresh API keys"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          {hasActiveKey ? (
            <button
              className="btn btn--primary btn--sm"
              onClick={() => setShowRotateConfirm(true)}
              disabled={actionPending || !activeMerchant}
              aria-label="Rotate API key"
            >
              Rotate Key
            </button>
          ) : (
            <button
              className="btn btn--primary btn--sm"
              onClick={handleCreate}
              disabled={actionPending || !activeMerchant}
              aria-label="Generate new API key"
            >
              {actionPending ? "Generating..." : "Generate API Key"}
            </button>
          )}
        </div>
      </div>

      {showAdminInput && (
        <div className="api-key-auth-box">
          <span className="api-key-auth-box__title">Admin Authorization (Optional)</span>
          <div className="api-key-auth-box__input-row">
            <input
              type="password"
              className="api-key-auth-box__input"
              placeholder="Enter X-Admin-Key if acting as administrator"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              aria-label="Admin Key"
            />
            <button className="btn btn--secondary btn--sm" onClick={loadKeys} disabled={!activeMerchant}>
              Apply
            </button>
          </div>
        </div>
      )}

      {!activeMerchant && (
        <div className="message message--warning" role="alert" data-testid="auth-required-warning">
          <strong>Authorization Required:</strong> Connect your merchant wallet to inspect and manage your API keys.
          Your connected Stellar public key verifies merchant authorization.
        </div>
      )}

      {error && (
        <div className="message message--error" role="alert" data-testid="api-key-error">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{error}</span>
            <button
              className="btn btn--sm btn--text"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              style={{ color: "inherit", fontWeight: "bold" }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {successMessage && (
        <div className="message message--success" role="status" data-testid="api-key-success">
          {successMessage}
        </div>
      )}

      {/* Secret shown ONLY at creation/rotation */}
      {newKeySecret && (
        <div className="secret-banner" role="alert" data-testid="secret-key-banner">
          <div className="secret-banner__header">
            <span>
              {newKeySecret.isRotation ? "New API Key Generated via Rotation" : "New API Key Generated"}
            </span>
            <button
              className="btn btn--secondary btn--sm"
              onClick={handleDismissSecret}
              aria-label="Dismiss and hide secret key"
            >
              Done & Hide Secret
            </button>
          </div>
          <p className="secret-banner__warning">
            ⚠️ <strong>Make sure to copy your API secret key now.</strong> For security purposes, this secret is never
            stored in plaintext and will <strong>NEVER</strong> be displayed again.
          </p>
          <div className="secret-banner__key-container">
            <code className="secret-banner__key" data-testid="plaintext-api-key">
              {newKeySecret.apiKey}
            </code>
            <button
              className="btn btn--primary btn--sm"
              onClick={handleCopySecret}
              aria-label="Copy API key secret"
              data-testid="copy-secret-button"
            >
              {copiedSecret ? "Copied!" : "Copy Secret"}
            </button>
          </div>
        </div>
      )}

      {/* API Key Metadata Table */}
      <div className="api-key-table-wrapper">
        {loading && keys.length === 0 ? (
          <p className="text-secondary" style={{ padding: "16px 0", textAlign: "center" }}>
            Loading merchant API keys...
          </p>
        ) : keys.length === 0 ? (
          <p className="text-secondary" style={{ padding: "16px 0", textAlign: "center" }}>
            {activeMerchant
              ? "No API keys found for this merchant. Generate one to get started."
              : "Wallet not connected. Connect your wallet to view keys."}
          </p>
        ) : (
          <table className="api-key-table" aria-label="API Keys List">
            <thead>
              <tr>
                <th scope="col">Key ID</th>
                <th scope="col">Status</th>
                <th scope="col">Created At</th>
                <th scope="col">Last Used Metadata</th>
                <th scope="col">Revoked At</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.key_id} data-testid={`key-row-${k.key_id}`}>
                  <td>
                    <span title={k.key_id}>
                      {shortenKeyId(k.key_id)}
                      <CopyableText text={k.key_id} label="Copy Key ID" />
                    </span>
                  </td>
                  <td>
                    <span
                      className={`status-badge ${k.is_active ? "status-badge--active" : "status-badge--revoked"}`}
                    >
                      {k.is_active ? "Active" : "Revoked"}
                    </span>
                  </td>
                  <td>{formatDate(k.created_at)}</td>
                  <td>
                    <div className="last-used-meta">
                      {k.last_used_at ? (
                        <span className="last-used-meta__date" data-testid={`last-used-${k.key_id}`}>
                          {formatDate(k.last_used_at)}
                        </span>
                      ) : (
                        <span className="last-used-meta__never" data-testid={`last-used-${k.key_id}`}>
                          Never used
                        </span>
                      )}
                    </div>
                  </td>
                  <td>{formatDate(k.revoked_at)}</td>
                  <td>
                    <div className="api-key-actions">
                      {k.is_active && (
                        <>
                          <button
                            className="btn btn--secondary btn--sm"
                            onClick={() => setShowRotateConfirm(true)}
                            disabled={actionPending}
                            aria-label={`Rotate key ${k.key_id}`}
                          >
                            Rotate
                          </button>
                          <button
                            className="btn btn--danger btn--sm"
                            onClick={() => setRevokeTargetId(k.key_id)}
                            disabled={actionPending}
                            aria-label={`Revoke key ${k.key_id}`}
                            data-testid={`revoke-btn-${k.key_id}`}
                          >
                            Revoke
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Rotate Confirmation Modal */}
      {showRotateConfirm && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rotate-modal-title">
          <div className="modal">
            <h3 id="rotate-modal-title" className="modal__title">
              Rotate Merchant API Key
            </h3>
            <p className="modal__message">
              Rotating your API key will immediately revoke your active API key and generate a brand new one.
              Any existing servers or applications using the old key will be rejected until updated with the new secret.
              Do you wish to proceed?
            </p>
            <div className="modal__actions">
              <button
                className="btn btn--secondary"
                onClick={() => setShowRotateConfirm(false)}
                disabled={actionPending}
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={handleRotateConfirm}
                disabled={actionPending}
                data-testid="confirm-rotate-button"
              >
                {actionPending ? "Rotating..." : "Confirm Rotation"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revoke Confirmation Modal */}
      {revokeTargetId && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="revoke-modal-title">
          <div className="modal">
            <h3 id="revoke-modal-title" className="modal__title">
              Revoke API Key
            </h3>
            <p className="modal__message">
              Are you sure you want to revoke API key <strong>{shortenKeyId(revokeTargetId)}</strong>?
              This key will immediately lose access to the protocol API and cannot be restored.
            </p>
            <div className="modal__actions">
              <button
                className="btn btn--secondary"
                onClick={() => setRevokeTargetId(null)}
                disabled={actionPending}
              >
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={handleRevokeConfirm}
                disabled={actionPending}
                data-testid="confirm-revoke-button"
              >
                {actionPending ? "Revoking..." : "Revoke Key"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ApiKeyManagement
