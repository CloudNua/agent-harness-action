import { logger } from "@/utils/logger";
import { VERSION } from "@/version";
import { withRetry, ServerError, type RetryOptions } from "@/utils/retry";
import { validateUrl } from "@/utils/url";
import type {
  PolicyExportResponse,
  PackageIntelligence,
  EvaluationResponse,
  EvaluateManifest,
} from "@/types/policy";

const TIMEOUT_MS = 10_000;

export interface ClientOptions {
  retry?: Partial<RetryOptions>;
  allowHttp?: boolean;
}

export class CloudNuaClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly retryOptions: Partial<RetryOptions>;

  constructor(token: string, baseUrl: string, options?: ClientOptions) {
    this.token = token;
    const validated = validateUrl(baseUrl, "api-url", {
      allowHttp: options?.allowHttp ?? false,
      allowEmpty: false,
    });
    this.baseUrl = validated!;
    this.retryOptions = options?.retry ?? {};
  }

  async fetchPolicies(): Promise<PolicyExportResponse> {
    return withRetry(
      () => this.doFetchPolicies(),
      "fetchPolicies",
      this.retryOptions,
    );
  }

  /**
   * Fetch package intelligence from the CloudNua control plane (Pro tier only).
   * Returns null if the tenant doesn't have Pro or the endpoint is unavailable.
   */
  async fetchPackageIntelligence(): Promise<PackageIntelligence | null> {
    try {
      return await withRetry(
        () => this.doFetchPackageIntelligence(),
        "fetchPackageIntelligence",
        this.retryOptions,
      );
    } catch (error) {
      // 403 = not Pro tier, 404 = endpoint not deployed yet — both are non-fatal
      logger.info(
        `Package intelligence unavailable: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async evaluate(
    manifest: EvaluateManifest,
  ): Promise<EvaluationResponse> {
    return withRetry(
      () => this.doEvaluate(manifest),
      "evaluate",
      this.retryOptions,
    );
  }

  private async doFetchPolicies(): Promise<PolicyExportResponse> {
    const url = `${this.baseUrl}/api/policies/export`;
    logger.debug(`Fetching policies from ${this.baseUrl}`);

    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new Error(
          `Authentication failed (${status}): check your api-token input`,
        );
      }
      throw new ServerError(
        status,
        `Failed to fetch policies: ${status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as PolicyExportResponse;

    if (!data.policies || !Array.isArray(data.policies)) {
      throw new Error("Malformed policy response: missing policies array");
    }

    logger.info(`Fetched ${data.policies.length} policies`);
    return data;
  }

  private async doFetchPackageIntelligence(): Promise<PackageIntelligence | null> {
    const url = `${this.baseUrl}/api/package-intelligence`;
    logger.debug(`Fetching package intelligence from ${this.baseUrl}`);

    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 403 || response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new ServerError(
        response.status,
        `Failed to fetch package intelligence: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    return data.package_intelligence ?? null;
  }

  private async doEvaluate(
    manifest: EvaluateManifest,
  ): Promise<EvaluationResponse> {
    const url = `${this.baseUrl}/api/policies/evaluate`;
    logger.debug(`Delegating evaluation to ${this.baseUrl}`);

    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ manifest }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new Error(
          `Authentication failed (${status}): check your api-token input`,
        );
      }
      throw new ServerError(
        status,
        `Evaluation failed: ${status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as EvaluationResponse;

    if (!data.violations || !Array.isArray(data.violations)) {
      throw new Error(
        "Malformed evaluation response: missing violations array",
      );
    }

    logger.info(
      `Evaluation complete: ${data.violations.length} violations`,
    );
    return data;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "User-Agent": `cloudnua-agent-harness/${VERSION}`,
    };
  }
}
