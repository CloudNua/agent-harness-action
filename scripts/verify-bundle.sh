#!/usr/bin/env bash
# Smoke-test the ncc-bundled dist/ output to catch a class of regressions
# where ncc minifies or rewrites code in a way that breaks the action's
# entry-point guard (require.main === module) or strips key strings that
# downstream consumers / log greps depend on.
#
# Failures here mean the dist/ artifact is shipping but won't run as
# expected — must fail loud before tagging.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0

require_grep() {
  local needle="$1" file="$2"
  if ! grep -q -- "$needle" "$file"; then
    echo "FAIL: '$needle' not found in $file" >&2
    fail=1
  fi
}

# Entry-point step labels (passed to runStep) must survive bundling.
require_grep "Agent execution" dist/main/index.js
require_grep "Post-execution" dist/post/index.js
require_grep "Pre-execution" dist/pre/index.js

# runStep wrapper must be present in main + post (entry-point guard).
require_grep "runStep" dist/main/index.js
require_grep "runStep" dist/post/index.js

# Scan-only mode literals must stay bundled — silent stripping would
# regress the v1.1.0 contract.
require_grep "scan-only" dist/main/index.js
require_grep "Scan-only mode" dist/post/index.js
require_grep "walking workspace for manifest files" dist/post/index.js

# State key constants — coupling between main/post survives minification.
require_grep "agent-exit-code" dist/main/index.js
require_grep "agent-exit-code" dist/post/index.js

if [[ $fail -ne 0 ]]; then
  echo "verify-bundle: smoke test failed" >&2
  exit 1
fi

echo "verify-bundle: dist/ smoke test passed"
