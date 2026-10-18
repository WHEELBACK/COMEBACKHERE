import "./EmptyState.css"

interface EmptyStateAction {
  label: string
  onClick?: () => void
  href?: string
}

interface EmptyStateProps {
  /** Title shown in the empty state */
  title: string
  /** Optional supporting description */
  description?: string
  /** Optional icon / illustration element */
  icon?: React.ReactNode
  /**
   * Optional CTA. Supply `onClick` for a callback-driven button or `href`
   * for a navigation link.
   */
  action?: EmptyStateAction
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="empty-state" role="status" aria-label={title}>
      {icon && <div className="empty-state__icon">{icon}</div>}
      <h3 className="empty-state__title">{title}</h3>
      {description && <p className="empty-state__description">{description}</p>}
      {action &&
        (action.href ? (
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
            type="button"
            onClick={action.onClick}
            aria-label={action.label}
          >
            {action.label}
          </button>
        ))}
    </div>
  )
}

/** Default SVG icon for empty states */
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
      <path
        d="M24 40 Q32 48 40 40"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
      />
    </svg>
  )
}
