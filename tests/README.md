# Tests

Plain Node scripts (no dependencies, no network) that validate the logic in
`../index.html`. Most extract the relevant functions straight out of
`index.html` and exercise them, so they test the code that actually ships.

## Run everything
```bash
node tests/run-all.js
```

## Run one suite
```bash
node tests/sync_merge_tests.js        # concurrency merge: reproduces the "disappearing tickets" race + fix, and merge unit cases
node tests/sync_shipped_tests.js      # re-runs the race/merge checks against the merge code extracted from index.html
node tests/feature_tests.js           # @mention parsing, attachment filename/ext, 7-day auto-close, notification merge
node tests/requester_notify_tests.js  # looping the ticket Requester into @mention notifications
```

Exit code is non-zero if any assertion fails.
