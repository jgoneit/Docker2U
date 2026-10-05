# Standalone native fixture flow

This scenario uses synthetic Docker CLI/HTTP responses and actual Rust IPC and
WKWebView rendering. It does not discover or execute Docker. Lifecycle controls
only replace JSON files in the exact owned fixture run.

## Run

Use the candidate's recorded native smoke bundle. Keep the app and page session
open throughout these three stages:

1. `pnpm native:smoke launch --fixture-mode standalone`
   - Compose IDs 1/2 remain present; standalone IDs 3/4 emit logs and Health events.
   - Click **Run standalone incident roundtrip**.
   - It checks both standalone log sources, an exact-ID incident, ±1/5/2 minute
     windows, explicit refresh, current diagnostics, current terminal without
     connecting, and return with the same event/window/focus.
2. `pnpm native:smoke standalone-recreate`
   - Removes synthetic ID 3 and creates ID 5 with the same `native-smoke-3` name.
   - Click **Verify standalone archived ID**.
   - It queries ID 3 again, retains its event/logs, and checks all current-detail
     buttons are disabled. ID 5 is never substituted for ID 3.
3. `pnpm native:smoke standalone-remove-all`
   - Removes remaining standalone IDs 4/5; Compose IDs 1/2 remain present.
   - Click **Verify empty standalone group**.
   - It verifies the empty standalone group still opens the old ID's incident.

Hide the harness controls while checking the product at 1024×680 in Korean and
English, light and dark. The probe records viewport visibility, but direct native
screenshots and keyboard checks remain separate evidence. No physical IME or real
Docker lifecycle result is implied by these synthetic checks.

Read the **Native smoke JSON report** through Computer Use, save it, then run:

```sh
pnpm native:smoke report --ui-results /absolute/path/to/ui-report.json
pnpm native:smoke stop
```

The validator requires matching launch identity, both native log stream bindings,
the native event timestamp, resource/diagnostics traces, exact-ID/time-bounded
query metadata, unchanged collection counters, and both owned lifecycle
transitions. It rejects raw log/input payloads in the new metadata steps.

A failed attempt stays in the report. Relaunch for a new full run; do not remove
failure steps or combine different sessions to manufacture a passing report.

## Coverage profiles

New launches use `group-observation-v2`. In standalone mode,
`requiredCoverageComplete` requires all three standalone probes. In default mode
it requires observation baseline, minimized restore, and terminal roundtrip.
`standaloneCoverageComplete` and `terminalCoverageComplete` remain separate flags.

The active harness no longer offers CLI LogPanel/Worker probes because native
standalone logs use the retained group collector. Historical reports without the
new coverage profile still use their original validator and coverage requirements.
Default fixture IDs, terminal commands, Compose behavior, and archived terminal
evidence remain supported.

## Automated fixture checks

```sh
python3 -B -m unittest discover -s tests/native-smoke -p 'test_*.py'
pnpm typecheck
pnpm exec vite build --config vite.native-smoke.config.ts
```

These commands do not launch a native app or access a real Engine.
