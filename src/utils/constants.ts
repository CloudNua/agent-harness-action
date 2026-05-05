/** State keys shared between main and post action steps. */
export const STATE_FIREWALL_URL = "firewall-url";
export const STATE_AGENT_EXIT_CODE = "agent-exit-code";
// STATE_SCAN_ONLY is set explicitly in main when agent-command is empty.
// We do NOT infer scan-only from absence of `workspace-snapshot-path` because
// that conflates two failure modes — an intentional scan-only run and a
// genuine pre-step failure (e.g. snapshot write failed) — which would silently
// fail open. The explicit handshake makes the mode contractual.
export const STATE_SCAN_ONLY = "scan-only";
