import './EmptyState.css'

interface EmptyStateAction {
  label: string
  /** Called when the action button is clicked (mutually exclusive with href). */
  onClick?: () => void
  /** Navigate to this path instead of using an onClick handler. */
  href?: string
}

interface EmptyStateProps {
  /**
   * Title shown in the empty state
   */
  title: string
  /**
   * Description or message to display
   */
  description?: string
  /**
   * Optional icon/illustration element
   */
  icon?: React.ReactNode
  /**
   * Optional action button/link configuration.
   * Supply `onClick` for a callback-driven CTA or `href` for a navigation link.
   */
  action?: EmptyStateAction
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: EmptyStateProps) {
  return (
    <div className="empty-state" role="status" aria-label={title}>
      {icon && <div className="empty-state__icon">{icon}</div>}
      <h3 className="empty-state__title">{title}</h3>
      {description && <p className="empty-state__description">{description}</p>}
      {action && (
        action.href ? (
          <a
            className="empty-state__action"
            href={action.href}
            aria-label={action.label}
          >
            {action.label}
          </a>
        ) : (
          <button
            className="empty-state__action"
            onClick={action.onClick}
            type="button"
            aria-label={action.label}
          >
            {action.label}
          </button>
        )
      )}
    </div>
  )
}

/**
 * Default icon component for empty states
 */
export function EmptyStateIcon() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="empty-state-icon"
      aria-hidden="true"
    >
      <circle cx="32" cy="32" r="30" stroke="currentColor" strokeWidth="2" />
      <circle cx="24" cy="28" r="3" fill="currentColor" />
      <circle cx="40" cy="28" r="3" fill="currentColor" />
      <path d="M24 40 Q32 48 40 40" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  )
}
