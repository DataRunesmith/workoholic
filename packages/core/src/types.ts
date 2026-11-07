export const MONTHLY_APPLICATION_TARGET = 10 as const;

export type JobProviderId = "studentconsulting";

export interface JobCandidate {
  provider: JobProviderId;
  externalId: string;
  title: string;
  employer?: string;
  location?: string;
  country?: string;
  countryCode?: string;
  isInternational: boolean;
  occupation?: string;
  occupationConceptId?: string;
  scope?: string;
  applicationUrl?: string;
  applicationReference?: string;
  discoverySource?: "studentconsulting_matcha_jobb";
  sourceUrl: string;
}

export interface ProviderCredentials {
  username: string;
  password: string;
}

export interface CredentialsProvider {
  getStudentConsultingCredentials(): Promise<ProviderCredentials>;
}

export type AuthenticationState =
  | { status: "anonymous" }
  | { status: "authenticated"; expiresAt?: string }
  | { status: "user_action_required"; action: "login"; message?: string }
  | { status: "failed"; code: string; message: string };

export interface ApplicationResult {
  status: "submitted" | "failed" | "unknown";
  reference?: string;
  error?: string;
  /** True only after the external submit control has actually been activated. */
  submissionAttempted?: boolean;
}

export interface JobProvider {
  readonly id: JobProviderId;
  authenticate(): Promise<AuthenticationState>;
  discover(): Promise<JobCandidate[]>;
  apply(job: JobCandidate): Promise<ApplicationResult>;
  verify(job: JobCandidate): Promise<boolean>;
}
