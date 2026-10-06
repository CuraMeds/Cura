export interface ProcessRequest {
  note: string;
  days: number;
  addons: string[];
  user_id: string;
}

export interface IcdCodeSuggestion {
  code: string;
  description: string;
  keyword: string;
}

export interface AuditFlag {
  level: string;
  issue: string;
  fix: string;
}

export interface SafetyResult {
  status: string;
  warnings: string[];
  on_formulary: string[];
  off_formulary: string[];
}

export interface GdrgResult {
  gdrg_code: string;
  gdrg_name: string;
  calculated_amount: number;
  breakdown: string;
}

export interface ClaimResponse {
  claim_id: string;
  diagnosis: string;
  meds: string[];
  discharge: string;
  icd_codes: IcdCodeSuggestion[];
  gdrg: GdrgResult;
  nhia_audit: {
    flags: AuditFlag[];
    estimated_payout: string;
  };
  safety: SafetyResult;
}
