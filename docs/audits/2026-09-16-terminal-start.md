# Terminal start during background inventory refresh

## Observed failure

On candidate `fc4679bb`, two native fixture probes and the first explicit
Connect action against an owned real Engine container returned `StaleHandle`.
The fixture trace contained no exec creation for the rejected attempts. A
subsequent explicit Close → Connect worked; the failed attempts remain evidence.

The UI polls observations once per second. Inventory refresh replaces both the
generation and opaque container handles, so a valid displayed container could
become stale before the start IPC reached Core. Reading a newer snapshot alone
would leave the same race between that read and the start.

## Change

Terminal startup uses the existing observation hold to obtain current inventory
and pause automatic inventory replacement for the single start request. It
resolves the original full ID in that inventory and sends the held generation
and handle. A same-name replacement cannot become the target. The hold is
released after startup and when the session is cancelled or replaced.

This hold does not change log collection or observation scope. Core still
validates session, generation, handle and running state. There is no automatic
retry of exec creation or input. A concurrent explicit manual refresh can still
invalidate the handle and be rejected safely.

The native probe also retains a direct start rejection and reports its actual
code and message, instead of waiting for a greeting that cannot arrive.

## Validation boundaries

Focused tests cover held inventory identity, cancellation and release, and
single-attempt error reporting. Required frontend/Rust checks and final native
and installed Engine results are recorded with the exact candidate in the local
installation validation record and PR descriptions.

The earlier native failures are not converted into passes. Native fixture
results, actual Engine interaction, physical IME input, and notarization remain
separate evidence categories.

## Rollback

Revert the terminal-start fix and its probe/test commits to restore the earlier
start path. The Rust generation and full-ID validation is unchanged.
