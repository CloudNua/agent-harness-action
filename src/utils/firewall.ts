import { validateUrl } from "./url";

/**
 * Validate and normalise the firewall-url input.
 *
 * Returns the validated, canonicalized URL string, or null if the input is empty.
 * Throws if the URL is malformed, uses HTTP without allow-http, or contains userinfo.
 */
export function validateFirewallUrl(
  raw: string,
  allowHttp: boolean,
): string | null {
  return validateUrl(raw, "firewall-url", { allowHttp });
}
