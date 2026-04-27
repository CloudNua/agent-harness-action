export type PolicyType = "dependency" | "mcp" | "compliance";
export type PolicyAction = "block" | "warn" | "log";

/**
 * Abstract condition schema — matches CloudNua control-plane export and policy API engine format.
 * Either a simple condition (field/operator/values) or a compound (AND/OR) grouping.
 */
export interface SimpleCondition {
  field: string;
  operator: string;
  values: (string | boolean | number)[];
}

export interface CompoundCondition {
  condition: "AND" | "OR";
  rules: PolicyCondition[];
}

export type PolicyCondition = SimpleCondition | CompoundCondition;

export interface Policy {
  id: string;
  name: string;
  description: string | null;
  type: PolicyType;
  action: PolicyAction;
  conditions: PolicyCondition;
  enabled: boolean;
}

export interface PackageSignal {
  type: string;
  score: number;
  detail: string;
}

export interface PackageEntry {
  ecosystem: string;
  package_name: string;
  risk_score: number;
  risk_level: string;
  osv_malware_match: boolean;
  osv_advisory_ids?: string[];
  affected_versions: string[];
  signals: PackageSignal[];
  remediation: string;
  last_analysed?: string;
}

export interface PackageIntelligenceMetadata {
  total_packages: number;
  last_sync?: string;
}

export interface PackageIntelligence {
  packages: PackageEntry[];
  metadata: PackageIntelligenceMetadata;
}

export interface PolicyExportResponse {
  policies: Policy[];
  package_intelligence?: PackageIntelligence;
}

/**
 * Violation returned by the CloudNua policy API's evaluation engine.
 * Mapped to local Violation format in scanner/index.ts.
 */
export interface EvaluationViolation {
  policy_id: string;
  policy_name: string;
  policy_type: PolicyType;
  action: PolicyAction;
  message: string;
  file_path?: string;
  dependency_name?: string;
}

/**
 * Manifest sent to the CloudNua policy API (via the control-plane proxy) for policy evaluation.
 * The CloudNua control plane resolves policies server-side; the client sends only the manifest.
 */
export interface EvaluateManifest {
  dependencies: Array<{
    name: string;
    version: string;
    license: string;
    deprecated: boolean;
  }>;
  mcp_tools: Array<{
    name: string;
    command_args: string[];
    config: Record<string, unknown>;
  }>;
  file_paths: string[];
}

export interface EvaluationSummary {
  total_violations: number;
  block_count: number;
  warn_count: number;
  log_count: number;
  has_mcp_policies: boolean;
}

export interface EvaluationResponse {
  violations: EvaluationViolation[];
  errors?: string[];
  summary?: EvaluationSummary;
}
