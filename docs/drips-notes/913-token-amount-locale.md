# Note to maintainers: token amount locale formatting (#913)

`formatAmount` in `comebackhere-frontend/src/utils/format.ts` already formats
raw token amounts with an explicit locale (default `en-US`) through
`Intl.NumberFormat`, using bigint arithmetic. It never reads the browser
locale, so grouping and decimal separators are stable. Callers that want a
different locale must pass `options.locale`. A regression test was added in
`src/tests/formatLocale.test.ts`.
