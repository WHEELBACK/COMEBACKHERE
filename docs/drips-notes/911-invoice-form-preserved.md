# Note to maintainers: invoice form after recoverable API error (#911)

`CreateInvoice` (`comebackhere-frontend/src/components/CreateInvoice.tsx`)
only swaps to the success view after `createInvoice` resolves. In the `catch`
branch of `handleSubmit` it sets `serverError` and per-field `serverFieldErrors`
and leaves `values` untouched, so the entered form data is kept and the user
can correct and resubmit. `values` is only cleared by `handleReset`. No code
change was needed.
