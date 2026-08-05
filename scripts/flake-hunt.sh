#!/usr/bin/env bash
#
# Runs the full test suite repeatedly and records every failure verbatim.
#
# Four tests in this suite fail intermittently and pass in isolation every time. The cause is
# not yet known; these were ruled out by measurement, not assumption:
#
#   - real network calls in tests        (none: every facilitator is stubbed)
#   - shared module state across files   (vitest forks with isolate, so state is per-file)
#   - CPU load alone                     (5 runs of the 4 files under 6-way contention: clean)
#   - ed25519 keygen cost in fixtures    (measured at ~0.0 ms; not a factor)
#   - running the files together         (20 isolated runs of the worst offender: clean)
#
# What is known: it only appears when the FULL suite runs. That points at something about
# whole-suite scheduling rather than any one test, and diagnosing it needs the actual
# assertion message from a failing run — which is exactly what nobody has captured yet,
# because the failures happen in the middle of long runs and scroll away.
#
# Usage:  ./scripts/flake-hunt.sh [runs]     (default 20)
# Output: .flake-hunt/run-<n>.log for each failure, plus a tally at the end.
set -uo pipefail

RUNS="${1:-20}"
OUT=".flake-hunt"
mkdir -p "$OUT"
rm -f "$OUT"/run-*.log

fails=0
for i in $(seq 1 "$RUNS"); do
  log="$OUT/run-$i.log"
  if npx vitest run --sequence.shuffle 2>&1 | tee "$log" | grep -qE "^ *Tests .*failed"; then
    fails=$((fails + 1))
    printf '  run %-3s FAILED  -> %s\n' "$i" "$log"
    grep -E "FAIL |AssertionError|→ |Error:" "$log" | head -6 | sed 's/^/           /'
  else
    printf '  run %-3s ok\n' "$i"
    rm -f "$log"
  fi
done

echo
echo "  $fails of $RUNS runs failed"
if [ "$fails" -gt 0 ]; then
  echo "  tests that failed, by frequency:"
  grep -h "FAIL " "$OUT"/run-*.log 2>/dev/null | sed 's/.*FAIL *//' | sort | uniq -c | sort -rn | sed 's/^/    /'
fi
