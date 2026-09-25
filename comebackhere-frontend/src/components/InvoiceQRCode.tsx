import { useRef, useEffect, useCallback, useState } from "react"
import { renderQRToCanvas, downloadQRAsPNG, getQRDataURL } from "../utils/qrcode"
import { useT } from "../i18n"

interface InvoiceQRCodeProps {
  invoiceId: string
  paymentBaseUrl?: string
}

function getPaymentUrl(invoiceId: string, baseUrl?: string): string {
  const base = baseUrl || `${window.location.origin}${window.location.pathname}`
  const url = new URL(base)
  url.searchParams.set("invoiceId", invoiceId)
  return url.toString()
}

/** Convert data URL to Blob for Web Share API */
async function dataURLToBlob(dataURL: string): Promise<Blob> {
  const response = await fetch(dataURL)
  return response.blob()
}

export function InvoiceQRCode({ invoiceId, paymentBaseUrl }: InvoiceQRCodeProps) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [showShareFallback, setShowShareFallback] = useState(false)

  const paymentUrl = getPaymentUrl(invoiceId, paymentBaseUrl)
  // Issue #725: file named invoice-<id>.png
  const filename = `invoice-${invoiceId}.png`

  useEffect(() => {
    if (canvasRef.current) {
      renderQRToCanvas(canvasRef.current, paymentUrl, 6, 4)
    }
  }, [paymentUrl])

  /**
   * Issue #725 — Download the QR code as a PNG named invoice-<id>.png.
   * Uses the canvas already rendered on screen (avoids a second render).
   * Falls back to the util helper which creates its own off-screen canvas.
   */
  const handleDownload = useCallback(() => {
    setShareError(null)

    if (canvasRef.current) {
      // Prefer reading the already-rendered canvas at its current resolution
      canvasRef.current.toBlob((blob) => {
        if (!blob) {
          // Fallback to the util helper
          downloadQRAsPNG(paymentUrl, filename)
          return
        }
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.download = filename
        link.href = url
        link.setAttribute("aria-hidden", "true")
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
      }, "image/png")
    } else {
      downloadQRAsPNG(paymentUrl, filename)
    }
  }, [paymentUrl, filename])

  const handleShare = useCallback(async () => {
    setShareError(null)
    setIsSharing(true)

    if (!navigator.share) {
      setShowShareFallback(true)
      setIsSharing(false)
      return
    }

    try {
      const dataURL = getQRDataURL(paymentUrl, 10, 4)
      const blob = await dataURLToBlob(dataURL)
      const file = new File([blob], filename, { type: "image/png" })

      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: `Invoice ${invoiceId} QR Code`,
          text: `Scan this QR code to pay Invoice #${invoiceId}`,
          url: paymentUrl,
        })
      } else if (navigator.canShare) {
        await navigator.share({
          files: [file],
          title: `Invoice ${invoiceId} QR Code`,
          text: `Scan this QR code to pay Invoice #${invoiceId}`,
        })
      } else {
        await navigator.share({
          title: `Invoice ${invoiceId} QR Code`,
          text: `Scan this QR code to pay Invoice #${invoiceId}`,
          url: paymentUrl,
        })
      }
      setShowShareFallback(false)
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error && error.name !== "AbortError"
          ? error.message
          : t("qrCode.shareError")
      setShareError(errorMessage)
      setShowShareFallback(true)
    } finally {
      setIsSharing(false)
    }
  }, [paymentUrl, filename, invoiceId, t])

  const handleCopyUrl = useCallback(() => {
    navigator.clipboard
      .writeText(paymentUrl)
      .then(() => {
        setShareError(null)
      })
      .catch(() => {
        setShareError(t("qrCode.shareError"))
      })
  }, [paymentUrl, t])

  const supportsWebShare = typeof navigator !== "undefined" && !!navigator.share

  return (
    <div className="qr-code-section">
      <h3 className="qr-code-section__title">{t("qrCode.title")}</h3>
      <p className="qr-code-section__desc">
        {t("qrCode.description", { id: invoiceId })}
      </p>
      <div className="qr-code-section__canvas-wrap">
        <canvas ref={canvasRef} className="qr-code-section__canvas" />
      </div>

      <div className="qr-code-section__actions">
        {/*
          Issue #725 — keyboard-accessible download button with a clear label.
          Named invoice-<id>.png via the `filename` variable above.
        */}
        <button
          className="btn btn--secondary qr-code-section__download"
          onClick={handleDownload}
          type="button"
          aria-label={t("qrCode.downloadAriaLabel")}
          title={t("qrCode.downloadTitle")}
          data-testid="qr-download-btn"
        >
          📥 {t("qrCode.downloadButton")}
        </button>

        {supportsWebShare && (
          <button
            className="btn btn--secondary qr-code-section__share"
            onClick={handleShare}
            disabled={isSharing}
            type="button"
            title={t("qrCode.share")}
          >
            {isSharing ? `⏳ ${t("qrCode.sharing")}` : `📤 ${t("qrCode.share")}`}
          </button>
        )}

        {showShareFallback && (
          <button
            className="btn btn--secondary qr-code-section__copy"
            onClick={handleCopyUrl}
            type="button"
            title={t("qrCode.copyUrl")}
          >
            🔗 {t("qrCode.copyUrl")}
          </button>
        )}
      </div>

      {shareError && (
        <div className="qr-code-section__error" role="alert">
          ⚠️ {shareError}
        </div>
      )}

      <details className="qr-code-section__details">
        <summary className="qr-code-section__summary">
          {t("qrCode.showPaymentUrl")}
        </summary>
        <p className="qr-code-section__url">{paymentUrl}</p>
      </details>
    </div>
  )
}
