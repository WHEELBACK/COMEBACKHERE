# #916: Redirect after authentication expires

Note to maintainers: the frontend has no separate session/login route. When the
wallet session ends (disconnect, locked or expired Freighter authorization),
`handleDisconnect` in `comebackhere-frontend/src/App.tsx` calls `setTab("payment")`,
and `useHashTab` (`parseTabHash`) maps any empty, malformed or unknown hash to
`DEFAULT_TAB` ("payment"). The app therefore always lands on a valid route, so
no behavior change was needed. A regression test in
`src/tests/useHashTab.test.ts` pins the fallback for stale/unknown routes.
