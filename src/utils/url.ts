/**
 * Shared URL validation for action inputs (api-url, firewall-url).
 *
 * Returns the canonicalized URL string, or null if the input is empty.
 * Throws if the URL is malformed, uses a disallowed protocol, or contains userinfo.
 */
export function validateUrl(
  raw: string,
  label: string,
  opts: { allowHttp: boolean; allowEmpty?: boolean },
): string | null {
  if (!raw || !raw.trim()) {
    if (opts.allowEmpty !== false) return null;
    throw new Error(`${label} must not be empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw}`);
  }

  // Reject non-HTTP protocols first (more specific error)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `${label} must use HTTP or HTTPS, got: ${parsed.protocol}`,
    );
  }

  // Enforce HTTPS unless explicitly opted out
  if (parsed.protocol !== "https:" && !opts.allowHttp) {
    throw new Error(
      `${label} must use HTTPS (set allow-http: true for internal testing)`,
    );
  }

  // Reject URLs with embedded credentials
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials in the URL`);
  }

  // Return the canonicalized form to prevent parser-differential attacks
  return parsed.toString().replace(/\/$/, "");
}
