import type {
  ApplicationResult,
  AuthenticationState,
  CredentialsProvider,
  JobCandidate,
  JobProvider,
} from "../../core/src/types";
import { isHostOrSubdomain } from "../../core/src/url";
import type { BrowserLocator, BrowserPage } from "./browser";

const DEFAULT_BASE_URL = "https://www.studentconsulting.com";
const PROFILE_URL = `${DEFAULT_BASE_URL}/sv/profil/`;
const STUDENTCONSULTING_DOMAIN = "studentconsulting.com";
const STUDENTCONSULTING_IDP = "id.studentconsulting.com";
const SUBMISSION_SETTLE_MS = 15_000;
const MATCHED_LISTING_WAIT_MS = 15_000;
const JOB_OPENINGS_API = `${DEFAULT_BASE_URL}/api/v1/jobopenings`;
const COUNTRY_PAGE_SIZE = 200;

const STUDENTCONSULTING_COUNTRIES = [
  { id: 1, country: "Sverige", countryCode: "SE", isInternational: false },
  { id: 2, country: "Norge", countryCode: "NO", isInternational: true },
  { id: 3, country: "Danmark", countryCode: "DK", isInternational: true },
] as const;

export interface StudentConsultingCountry {
  country: string;
  countryCode: string;
  isInternational: boolean;
}

export interface StudentConsultingProviderOptions {
  page: BrowserPage;
  credentials: CredentialsProvider;
  maxJobs?: number;
  maxPagesPerSource?: number;
  autoSubmit?: boolean;
  fetcher?: typeof fetch;
}

export interface ParsedStudentConsultingJob {
  externalId?: string;
  location?: string;
  occupation?: string;
  scope?: string;
  country?: string;
  countryCode?: string;
  isInternational: boolean;
}

export interface StudentConsultingApplicationHistoryEntry {
  externalId: string;
  sourceUrl: string;
  linkText: string;
  dateHints: string[];
}

export interface StudentConsultingApplicationHistoryProbe {
  applicationsUrl: string;
  entries: StudentConsultingApplicationHistoryEntry[];
  apiResourcePaths: string[];
  jobIdSnippets: string[];
  bodyLength: number;
}

export interface StudentConsultingHistoricalApplication {
  externalId: string;
  title: string;
  applicationTime: string;
  status: string;
  isPublished: boolean;
  location?: string;
  country?: string;
  countryCode?: string;
  scope?: string;
  occupation?: string;
}

export class StudentConsultingProvider implements JobProvider {
  readonly id = "studentconsulting" as const;

  private readonly page: BrowserPage;
  private readonly credentials: CredentialsProvider;
  private readonly maxJobs: number;
  private readonly maxPagesPerSource: number;
  private readonly autoSubmit: boolean;
  private readonly fetcher: typeof fetch;

  constructor(options: StudentConsultingProviderOptions) {
    this.page = options.page;
    this.credentials = options.credentials;
    this.maxJobs = options.maxJobs ?? 30;
    this.maxPagesPerSource = options.maxPagesPerSource ?? 3;
    this.autoSubmit = options.autoSubmit ?? false;
    this.fetcher = options.fetcher ?? fetch;
  }

  async authenticate(): Promise<AuthenticationState> {
    try {
      const redirectUrl = PROFILE_URL;
      const loginUrl = `${DEFAULT_BASE_URL}/signin?language=sv-SE&redirectUrl=${encodeURIComponent(redirectUrl)}`;

      await this.page.goto(loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      if (
        normalizeStudentConsultingProfileAreaUrl(this.page.url()) &&
        !(await hasVisibleStudentConsultingLoginControls(this.page))
      ) {
        return { status: "authenticated" };
      }

      const { username, password } = await this.credentials.getStudentConsultingCredentials();

      const email = await firstVisible(this.page, [
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[name="Email"]',
        'input[name="email"]',
      ]);
      const passwordInput = await firstVisible(this.page, [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
      ]);

      if (!email || !passwordInput) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_LOGIN_FORM_NOT_FOUND",
          message: "StudentConsulting login form could not be identified.",
        };
      }

      await email.fill(username);
      await passwordInput.fill(password);

      const submit = await firstVisible(this.page, [
        'button[type="submit"]',
        'input[type="submit"]',
      ]);
      if (!submit) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_LOGIN_SUBMIT_NOT_FOUND",
          message: "StudentConsulting login submit control could not be identified.",
        };
      }

      await submit.click({ timeout: 10_000 });
      await settleAfterAuthentication(this.page, 20_000);

      const host = safeHostname(this.page.url());
      if (!host || host === STUDENTCONSULTING_IDP) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_LOGIN_FAILED",
          message: "StudentConsulting did not establish an authenticated session.",
        };
      }
      if (!isHostOrSubdomain(host, STUDENTCONSULTING_DOMAIN)) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_UNEXPECTED_REDIRECT",
          message: `Unexpected login redirect host: ${host}`,
        };
      }
      if (!normalizeStudentConsultingProfileAreaUrl(this.page.url())) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_PROFILE_NOT_REACHED",
          message:
            "StudentConsulting authentication did not reach the authenticated /sv/profil/ area.",
        };
      }

      if (await hasVisibleStudentConsultingLoginControls(this.page)) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_LOGIN_FAILED",
          message: "StudentConsulting remained on a visible login form after authentication.",
        };
      }

      return { status: "authenticated" };
    } catch (error) {
      return {
        status: "failed",
        code: "STUDENTCONSULTING_AUTH_ERROR",
        message: errorMessage(error),
      };
    }
  }

  async discover(): Promise<JobCandidate[]> {
    await this.page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!normalizeStudentConsultingProfileAreaUrl(this.page.url())) {
      throw new Error(
        "STUDENTCONSULTING_PROFILE_REDIRECTED: den autentiserade profilentryn lämnade /sv/profil/.",
      );
    }
    if (await hasVisibleStudentConsultingLoginControls(this.page)) {
      throw new Error(
        "STUDENTCONSULTING_PROFILE_AUTH_REQUIRED: profilsessionen är inte autentiserad.",
      );
    }

    const matchedNavigation = await findMatchedJobsNavigation(this.page);
    if (matchedNavigation.status === "invalid") {
      throw new Error(
        `STUDENTCONSULTING_MATCHED_PROFILE_ROUTE_INVALID: synlig Matcha jobb-navigation kunde inte valideras (${matchedNavigation.reason}${matchedNavigation.path ? `, path=${matchedNavigation.path}` : ""}).`,
      );
    }
    if (matchedNavigation.status === "absent") {
      const profilePaths =
        matchedNavigation.profilePaths.length > 0
          ? matchedNavigation.profilePaths.join(",")
          : "(none)";
      const diagnostics = matchedNavigation.diagnostics;
      throw new Error(
        `STUDENTCONSULTING_MATCHED_PROFILE_NAVIGATION_NOT_FOUND: ingen verifierad jobbmatchningsnavigation hittades; profilePaths=${profilePaths}; anchors=${diagnostics.anchors}; visibleAnchors=${diagnostics.visibleAnchors}; controls=${diagnostics.controls}; visibleControls=${diagnostics.visibleControls}; semanticMatches=${diagnostics.semanticMatches}; visibleSemanticMatches=${diagnostics.visibleSemanticMatches}; dataHref=${diagnostics.dataHref}; dataUrl=${diagnostics.dataUrl}; onclick=${diagnostics.onclick}.`,
      );
    }

    const matchedJobsUrl = matchedNavigation.url;
    const inPlaceListing =
      matchedNavigation.status === "in_place" ? matchedNavigation.listing : undefined;
    const matchedRouteSource =
      matchedNavigation.status === "in_place"
        ? "visible_navigation_in_place"
        : "visible_navigation";

    if (!inPlaceListing) {
      await this.page.goto(matchedJobsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (!isSameMatchedJobsRoute(this.page.url(), matchedJobsUrl)) {
        throw new Error(
          "STUDENTCONSULTING_MATCHED_PROFILE_REDIRECTED: Matcha jobb omdirigerades utanför den verifierade profilvyn.",
        );
      }
    }
    if (await hasVisibleStudentConsultingLoginControls(this.page)) {
      throw new Error(
        "STUDENTCONSULTING_PROFILE_AUTH_REQUIRED: Matcha jobb kräver en autentiserad profilsession.",
      );
    }

    const countryByExternalId = await loadStudentConsultingCountryIndex(this.fetcher).catch(
      (error) => {
        console.warn("StudentConsulting country index unavailable", {
          error: errorMessage(error),
        });
        return new Map<string, StudentConsultingCountry>();
      },
    );
    const candidates = new Map<string, JobCandidate>();
    for (let pageNumber = 1; pageNumber <= this.maxPagesPerSource; pageNumber += 1) {
      if (candidates.size >= this.maxJobs) break;

      if (inPlaceListing && pageNumber > 1) break;

      let listing: MatchedListingObservation;
      if (inPlaceListing) {
        listing = inPlaceListing;
      } else {
        const listingUrl = withPage(matchedJobsUrl, pageNumber);
        await this.page.goto(listingUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        if (!isSameMatchedJobsRoute(this.page.url(), matchedJobsUrl)) {
          throw new Error(
            "STUDENTCONSULTING_MATCHED_PROFILE_REDIRECTED: Matcha jobb omdirigerades utanför den verifierade profilvyn.",
          );
        }
        if (await hasVisibleStudentConsultingLoginControls(this.page)) {
          throw new Error(
            "STUDENTCONSULTING_PROFILE_AUTH_REQUIRED: Matcha jobb-listningen kräver en autentiserad profilsession.",
          );
        }

        listing = await collectJobLinks(this.page);
      }
      if (listing.links.length === 0) {
        if (pageNumber === 1 && listing.explicitEmpty) {
          throw new Error(
            "STUDENTCONSULTING_NO_MATCHED_JOBS: Matcha jobb rapporterade inga matchande jobb.",
          );
        }
        if (pageNumber === 1) {
          const diagnostics = listing.diagnostics ?? {
            anchors: 0,
            dataHref: 0,
            dataUrl: 0,
            onclick: 0,
            iframes: 0,
            jobLike: 0,
          };
          throw new Error(
            `STUDENTCONSULTING_MATCHED_PROFILE_UNRECOGNIZED: source=${matchedRouteSource}, route=${new URL(matchedJobsUrl).pathname}, anchors=${diagnostics.anchors}, dataHref=${diagnostics.dataHref}, dataUrl=${diagnostics.dataUrl}, onclick=${diagnostics.onclick}, iframes=${diagnostics.iframes}, jobLike=${diagnostics.jobLike}.`,
          );
        }
        break;
      }

      let addedOnPage = 0;
      for (const sourceUrl of listing.links) {
        if (candidates.size >= this.maxJobs) break;
        if (candidates.has(sourceUrl)) continue;

        const candidate = await this.readJob(sourceUrl, countryByExternalId);
        if (!candidate) continue;
        candidates.set(sourceUrl, candidate);
        addedOnPage += 1;
      }

      if (addedOnPage === 0) break;
    }

    return [...candidates.values()].slice(0, this.maxJobs);
  }

  async apply(job: JobCandidate): Promise<ApplicationResult> {
    if (job.provider !== this.id) {
      return {
        status: "failed",
        error: "StudentConsulting provider received a job from another provider.",
        submissionAttempted: false,
      };
    }

    const safeJobUrl = normalizeStudentConsultingJobUrl(job.sourceUrl);
    if (!safeJobUrl) {
      return {
        status: "failed",
        error:
          "INVALID_JOB_URL: the job URL is outside StudentConsulting or has an unexpected path.",
        submissionAttempted: false,
      };
    }

    let submissionAttempted = false;

    try {
      const auth = await this.authenticate();
      if (auth.status !== "authenticated") {
        return {
          status: "failed",
          error:
            auth.status === "failed" ? `${auth.code}: ${auth.message}` : "Authentication required.",
          submissionAttempted: false,
        };
      }

      await this.page.goto(safeJobUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      const bodyText = await safeInnerText(this.page.locator("body").first());
      if (alreadyApplied(bodyText)) {
        return {
          status: "submitted",
          reference: job.externalId,
          submissionAttempted: false,
        };
      }

      if (!this.autoSubmit) {
        return {
          status: "failed",
          error:
            "AUTOSUBMIT_DISABLED: set STUDENTCONSULTING_AUTOSUBMIT=true after validating the authenticated application form.",
          submissionAttempted: false,
        };
      }

      await fillKnownSafeRequiredControls(this.page, job);

      const requiredState = await validateRequiredControls(this.page);
      if (!requiredState.ok) {
        return {
          status: "failed",
          error: requiredState.error,
          submissionAttempted: false,
        };
      }

      const submit = await findApplicationSubmit(this.page);
      if (!submit) {
        return {
          status: "failed",
          error:
            "APPLICATION_SUBMIT_NOT_FOUND: no unambiguous StudentConsulting application submit button was found.",
          submissionAttempted: false,
        };
      }

      // Use a real locator click. Synthetic dispatchEvent("click") does not
      // reliably execute the browser's default form-submit activation.
      // Fail closed once activation begins: if the click throws after a submit
      // side effect, reconciliation must prove the exact Jobb-ID before retrying.
      submissionAttempted = true;
      await submit.click({ timeout: 10_000 });
      await waitForSubmissionToSettle(this.page, SUBMISSION_SETTLE_MS);

      if (await this.verify(job)) {
        return {
          status: "submitted",
          reference: job.externalId,
          submissionAttempted: true,
        };
      }

      return {
        status: "unknown",
        reference: job.externalId,
        error:
          "Submission was attempted but the exact Jobb-ID could not be verified in StudentConsulting applications.",
        submissionAttempted: true,
      };
    } catch (error) {
      return {
        status: submissionAttempted ? "unknown" : "failed",
        reference: submissionAttempted ? job.externalId : undefined,
        error: errorMessage(error),
        submissionAttempted,
      };
    }
  }

  async inspectApplicationStatus(
    job: JobCandidate,
  ): Promise<"applied" | "not_applied" | "unknown"> {
    try {
      await this.page.goto(PROFILE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (!normalizeStudentConsultingProfileAreaUrl(this.page.url())) {
        return "unknown";
      }

      const authenticatedStatus = await readAuthenticatedApplicationStatus(
        this.page,
        job.externalId,
        job.countryCode,
      );
      const authenticatedNotApplied =
        authenticatedStatus?.found === true && authenticatedStatus.applied === false;
      if (authenticatedStatus) {
        console.info("StudentConsulting authenticated application status", {
          externalId: job.externalId,
          found: authenticatedStatus.found,
          applied: authenticatedStatus.applied,
        });
        if (authenticatedStatus.found && authenticatedStatus.applied) {
          return "applied";
        }
      }

      const applicationsNavigation = await findApplicationsNavigation(this.page, job.externalId);
      if (applicationsNavigation) {
        if (applicationsNavigation.status === "found") {
          await this.page.goto(applicationsNavigation.url, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          const current = normalizeStudentConsultingVisibleMatchedJobsUrl(this.page.url());
          if (
            !current ||
            new URL(current).pathname !== new URL(applicationsNavigation.url).pathname
          ) {
            return "unknown";
          }
        }

        const applicationsEvidence = await pageContainsExactJobReference(this.page, job.externalId);
        console.info("StudentConsulting applications verification", {
          externalId: job.externalId,
          verified: applicationsEvidence,
        });
        if (applicationsEvidence) return "applied";
      }

      return authenticatedNotApplied ? "not_applied" : "unknown";
    } catch {
      return "unknown";
    }
  }

  async verify(job: JobCandidate): Promise<boolean> {
    return (await this.inspectApplicationStatus(job)) === "applied";
  }

  async probeApplicationHistory(
    referenceExternalId: string,
  ): Promise<StudentConsultingApplicationHistoryProbe> {
    await this.page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!normalizeStudentConsultingProfileAreaUrl(this.page.url())) {
      throw new Error("STUDENTCONSULTING_PROFILE_NOT_REACHED");
    }

    const navigation = await findApplicationsNavigation(this.page, referenceExternalId);
    if (!navigation) {
      throw new Error("STUDENTCONSULTING_APPLICATIONS_NAV_NOT_FOUND");
    }
    if (navigation.status === "found") {
      await this.page.goto(navigation.url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    await this.page.waitForTimeout(5_000);

    if (!normalizeStudentConsultingProfileAreaUrl(this.page.url())) {
      throw new Error("STUDENTCONSULTING_APPLICATIONS_LEFT_PROFILE_AREA");
    }
    if (!this.page.evaluate) {
      throw new Error("STUDENTCONSULTING_HISTORY_EVALUATE_UNAVAILABLE");
    }

    const raw = await this.page.evaluate((_unused) => {
      const browser = globalThis as unknown as {
        document: {
          querySelectorAll(selector: string): ArrayLike<unknown>;
          body?: { innerText?: string | null } | null;
        };
        performance: { getEntriesByType(type: string): Array<{ name: string }> };
        location: { href: string; origin: string };
      };
      const datePatterns = [
        /\b\d{4}-\d{2}-\d{2}\b/g,
        /\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/g,
        /\b\d{1,2}\s+(?:jan(?:uari)?|feb(?:ruari)?|mar(?:s)?|apr(?:il)?|maj|jun(?:i)?|jul(?:i)?|aug(?:usti)?|sep(?:tember)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/gi,
      ];
      const rows = Array.from(browser.document.querySelectorAll("a[href]"))
        .map((value) => {
          const anchor = value as {
            href?: string;
            textContent?: string | null;
            parentElement?: { textContent?: string | null } | null;
            closest?(selector: string): { textContent?: string | null } | null;
          };
          const href = anchor.href || "";
          const match = href.match(/\/(\d+)\/?(?:[?#].*)?$/);
          if (!match) return null;
          const container =
            anchor.closest?.(
              "article,li,tr,[class*='card'],[class*='application'],[class*='job']",
            ) ?? anchor.parentElement;
          const context = (container?.textContent ?? anchor.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 1600);
          const dateHints = Array.from(
            new Set(datePatterns.flatMap((pattern) => context.match(pattern) ?? [])),
          ).slice(0, 8);
          return {
            externalId: match[1],
            href,
            linkText: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
            dateHints,
          };
        })
        .filter((row) => Boolean(row)) as Array<{
        externalId: string;
        href: string;
        linkText: string;
        dateHints: string[];
      }>;

      const resources = browser.performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => {
          try {
            const url = new URL(name, browser.location.href);
            return /(^|\.)studentconsulting\.com$/i.test(url.hostname);
          } catch {
            return false;
          }
        })
        .map((name) => {
          try {
            const url = new URL(name, browser.location.href);
            return `${url.origin}${url.pathname}`;
          } catch {
            return "";
          }
        })
        .filter(Boolean);

      const bodyText = (browser.document.body?.innerText ?? "")
        .replace(/\r/g, "")
        .slice(0, 200_000);
      const snippets: string[] = [];
      const seen = new Set<string>();
      for (const match of bodyText.matchAll(/\b\d{5}\b/g)) {
        const start = Math.max(0, (match.index ?? 0) - 140);
        const end = Math.min(bodyText.length, (match.index ?? 0) + 260);
        const snippet = bodyText.slice(start, end).replace(/\s+/g, " ").trim();
        if (snippet && !seen.has(snippet)) {
          seen.add(snippet);
          snippets.push(snippet);
        }
        if (snippets.length >= 40) break;
      }

      return {
        rows,
        resources,
        snippets,
        bodyLength: bodyText.length,
      };
    }, null);

    const deduped = new Map<string, StudentConsultingApplicationHistoryEntry>();
    for (const row of raw.rows) {
      const safeUrl = normalizeStudentConsultingJobUrl(row.href);
      if (!safeUrl) continue;
      const externalId = safeUrl.match(/\/(\d+)\/?(?:\?.*)?$/)?.[1];
      if (!externalId || externalId !== row.externalId) continue;
      const current = deduped.get(externalId);
      if (!current || current.dateHints.length < row.dateHints.length) {
        deduped.set(externalId, {
          externalId,
          sourceUrl: safeUrl,
          linkText: row.linkText,
          dateHints: row.dateHints,
        });
      }
    }

    return {
      applicationsUrl: this.page.url(),
      entries: [...deduped.values()],
      apiResourcePaths: [...new Set(raw.resources)].slice(0, 100),
      jobIdSnippets: raw.snippets,
      bodyLength: raw.bodyLength,
    };
  }

  async loadApplicationHistory(month: string): Promise<StudentConsultingHistoricalApplication[]> {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new Error("STUDENTCONSULTING_HISTORY_MONTH_INVALID");
    }

    await this.page.goto(`${PROFILE_URL}#!/applications`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await this.page.waitForTimeout(5_000);
    if (!normalizeStudentConsultingProfileAreaUrl(this.page.url())) {
      throw new Error("STUDENTCONSULTING_APPLICATIONS_LEFT_PROFILE_AREA");
    }
    if (!this.page.evaluate) {
      throw new Error("STUDENTCONSULTING_HISTORY_EVALUATE_UNAVAILABLE");
    }

    return this.page.evaluate(
      async (input) => {
        const browser = globalThis as unknown as {
          document: { body: unknown };
          fetch: typeof fetch;
          angular?: {
            element(value: unknown): {
              injector(): {
                get(name: string): unknown;
              };
            };
          };
        };
        const angular = browser.angular;
        if (!angular) throw new Error("ANGULAR_NOT_AVAILABLE");
        const injector = angular.element(browser.document.body).injector();
        const config = injector.get("configSettings") as {
          apiUrl?: string;
          accessToken?: string;
          language?: string;
        };
        const apiUrl = String(config.apiUrl ?? "");
        const accessToken = String(config.accessToken ?? "");
        if (!apiUrl || !accessToken) throw new Error("PROFILE_API_CONFIG_MISSING");
        const headers = {
          accept: "application/json",
          "accept-language": String(config.language ?? "sv-SE"),
          authorization: `Bearer ${accessToken}`,
          "cache-control": "no-cache",
          pragma: "no-cache",
        };
        const response = await browser.fetch(`${apiUrl}user/application`, {
          method: "GET",
          headers,
        });
        if (!response.ok) {
          throw new Error(`APPLICATION_HISTORY_HTTP_${response.status}`);
        }
        const payload = (await response.json()) as {
          data?: Array<{
            id?: number | string;
            title?: string;
            applicationTime?: string;
            status?: string;
            isPublished?: boolean;
          }>;
        };
        const applications = Array.isArray(payload.data) ? payload.data : [];
        const selected = applications
          .map((application) => ({
            externalId: String(application.id ?? "").trim(),
            title: String(application.title ?? "").trim(),
            applicationTime: String(application.applicationTime ?? "").trim(),
            status: String(application.status ?? "").trim(),
            isPublished: application.isPublished === true,
          }))
          .filter((application) => {
            if (!/^\d+$/.test(application.externalId)) return false;
            if (!application.title || !application.applicationTime) return false;
            if (application.applicationTime.startsWith(input.month)) return true;
            const parsed = new Date(application.applicationTime);
            if (Number.isNaN(parsed.valueOf())) return false;
            return (
              `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}` ===
              input.month
            );
          });

        const detailed = await Promise.all(
          selected.slice(0, 50).map(async (application) => {
            type JobDetails = {
              location?: {
                city?: { name?: string };
                country?: { name?: string; code?: string };
              };
              schema?: string;
              type?: { name?: string };
              profession?: { freeText?: string; name?: string };
            };
            let job: JobDetails | null = null;
            try {
              const jobResponse = await browser.fetch(
                `${apiUrl}jobopening/${encodeURIComponent(application.externalId)}`,
                { method: "GET", headers },
              );
              if (jobResponse.ok) {
                const jobPayload = (await jobResponse.json()) as { data?: JobDetails | null };
                job = jobPayload.data ?? null;
              }
            } catch {
              job = null;
            }
            const schema = String(job?.schema ?? "").trim();
            const type = String(job?.type?.name ?? "").trim();
            return {
              ...application,
              location: String(job?.location?.city?.name ?? "").trim() || undefined,
              country: String(job?.location?.country?.name ?? "").trim() || undefined,
              countryCode: String(job?.location?.country?.code ?? "").trim() || undefined,
              scope: schema || type || undefined,
              occupation:
                String(job?.profession?.freeText ?? job?.profession?.name ?? "").trim() ||
                undefined,
            };
          }),
        );
        return detailed;
      },
      { month },
    );
  }

  private async readJob(
    sourceUrl: string,
    countryByExternalId: Map<string, StudentConsultingCountry>,
  ): Promise<JobCandidate | null> {
    const safeJobUrl = normalizeStudentConsultingJobUrl(sourceUrl);
    if (!safeJobUrl) return null;

    await this.page.goto(safeJobUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const title = (await safeInnerText(this.page.locator("h1").first())).trim();
    const bodyText = await safeInnerText(this.page.locator("body").first());
    const parsed = parseStudentConsultingJobText(bodyText);
    if (!title || !parsed.externalId) return null;
    const indexedCountry = countryByExternalId.get(parsed.externalId);

    return {
      provider: this.id,
      externalId: parsed.externalId,
      title,
      employer: "StudentConsulting",
      location: parsed.location,
      country: parsed.country ?? indexedCountry?.country,
      countryCode: parsed.countryCode ?? indexedCountry?.countryCode,
      isInternational:
        parsed.countryCode !== undefined
          ? parsed.isInternational
          : (indexedCountry?.isInternational ?? parsed.isInternational),
      occupation: parsed.occupation,
      scope: parsed.scope,
      applicationUrl: safeJobUrl,
      discoverySource: "studentconsulting_matcha_jobb",
      sourceUrl: safeJobUrl,
    };
  }
}

export function parseStudentConsultingJobText(bodyText: string): ParsedStudentConsultingJob {
  const factsStart = bodyText.search(/Fakta om jobbet/i);
  const facts = factsStart >= 0 ? bodyText.slice(factsStart) : bodyText;
  const externalId = facts.match(/Jobb-ID\s*([0-9]+)/i)?.[1];

  const country = classifyCountry(readFact(facts, "Land"));

  return {
    externalId,
    location: readFact(facts, "Ort"),
    occupation: readFact(facts, "Yrkeskategori"),
    scope: readFact(facts, "Omfattning"),
    ...country,
  };
}

export function containsExactJobId(text: string, externalId: string): boolean {
  const escaped = escapeRegExp(externalId.trim());
  if (!escaped) return false;
  return new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`).test(text);
}

export function normalizeStudentConsultingUrl(value: string): string | null {
  try {
    const parsed = new URL(value, DEFAULT_BASE_URL);
    if (parsed.protocol !== "https:") return null;
    if (!isHostOrSubdomain(parsed.hostname, STUDENTCONSULTING_DOMAIN)) return null;

    return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, DEFAULT_BASE_URL).toString();
  } catch {
    return null;
  }
}

export function normalizeStudentConsultingJobUrl(value: string): string | null {
  const safe = normalizeStudentConsultingUrl(value);
  if (!safe) return null;

  const parsed = new URL(safe);
  if (!/\/sv\/lediga-jobb\/[^/]+\/[^/]+\/\d+\/?$/i.test(parsed.pathname)) {
    return null;
  }
  return safe;
}

function extractStudentConsultingJobUrlCandidates(value: string): string[] {
  const candidates = new Set<string>([value.trim()]);
  const absoluteUrlPattern = /https:\/\/[^\s"'<>]+/gi;
  const absoluteMatches = [...value.matchAll(absoluteUrlPattern)];
  let relativeSource = value;

  for (const match of absoluteMatches) {
    candidates.add(match[0]);
    const start = match.index ?? 0;
    relativeSource =
      relativeSource.slice(0, start) +
      " ".repeat(match[0].length) +
      relativeSource.slice(start + match[0].length);
  }

  const relativeMatches = relativeSource.match(
    /\/sv\/lediga-jobb\/[^\s"'<>]+\/[^\s"'<>]+\/\d+\/?/gi,
  );
  for (const match of relativeMatches ?? []) candidates.add(match);
  return [...candidates].filter(Boolean);
}

export function isStudentConsultingMatchedJobsLabel(label: string): boolean {
  const normalized = normalize(label);
  if (/^(matcha jobb|matchade jobb|matchande jobb)(?:\s|$)/i.test(normalized)) {
    return true;
  }
  return (
    /(?:^|\s)jobbmatchning(?:ar)?(?:\s|$)/i.test(normalized) ||
    /\bmatchning(?:ar)?\s+mot\s+jobb(?:\s|$)/i.test(normalized)
  );
}

function normalizeStudentConsultingMainOriginUrl(value: string): string | null {
  try {
    const parsed = new URL(value, DEFAULT_BASE_URL);
    const expected = new URL(DEFAULT_BASE_URL);
    if (parsed.protocol !== "https:") return null;
    if (parsed.origin !== expected.origin) return null;
    if (parsed.username || parsed.password) return null;

    return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, DEFAULT_BASE_URL).toString();
  } catch {
    return null;
  }
}

function normalizeStudentConsultingProfileAreaUrl(value: string): string | null {
  const safe = normalizeStudentConsultingMainOriginUrl(value);
  if (!safe) return null;

  const pathname = new URL(safe).pathname;
  if (!/^\/sv\/profil(?:\/|$)/i.test(pathname)) return null;
  return safe;
}

export function normalizeStudentConsultingMatchedJobsUrl(value: string): string | null {
  const safe = normalizeStudentConsultingMainOriginUrl(value);
  if (!safe) return null;

  const pathname = new URL(safe).pathname;
  if (!/^\/sv\/(?:min-profil|profil)\/(?:matcha|matchade|matchande)-jobb\/?$/i.test(pathname)) {
    return null;
  }
  return safe;
}

interface LandingNavigationDiagnostics {
  anchors: number;
  visibleAnchors: number;
  controls: number;
  visibleControls: number;
  semanticMatches: number;
  visibleSemanticMatches: number;
  dataHref: number;
  dataUrl: number;
  onclick: number;
}

type MatchedJobsNavigation =
  | {
      status: "absent";
      profilePaths: string[];
      diagnostics: LandingNavigationDiagnostics;
    }
  | { status: "found"; url: string }
  | {
      status: "in_place";
      url: string;
      listing: MatchedListingObservation;
    }
  | {
      status: "invalid";
      reason: "missing_href" | "untrusted_href" | "ambiguous";
      path?: string;
    };

function normalizeStudentConsultingVisibleMatchedJobsUrl(value: string): string | null {
  const safe = normalizeStudentConsultingMainOriginUrl(value);
  if (!safe) return null;

  const pathname = new URL(safe).pathname;
  if (!/^\/sv\/(?:min-profil|profil)\/.+/i.test(pathname)) return null;
  return safe;
}

function safeStudentConsultingPath(value: string): string | undefined {
  try {
    const parsed = new URL(value, DEFAULT_BASE_URL);
    const expected = new URL(DEFAULT_BASE_URL);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== expected.origin ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.pathname;
  } catch {
    return undefined;
  }
}

function isStudentConsultingNavigationPlaceholder(value: string): boolean {
  try {
    const parsed = new URL(value, DEFAULT_BASE_URL);
    const expected = new URL(DEFAULT_BASE_URL);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === expected.origin &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      parsed.search === ""
    );
  } catch {
    return false;
  }
}

async function findMatchedJobsNavigation(
  page: BrowserPage,
  allowPlaceholderClick = true,
): Promise<MatchedJobsNavigation> {
  const anchors = page.locator("a");
  const count = await anchors.count();
  const validUrls = new Set<string>();
  const profilePaths = new Set<string>();
  let visibleAnchors = 0;
  let anchorSemanticMatches = 0;
  let visibleAnchorSemanticMatches = 0;
  const placeholderAnchors: BrowserLocator[] = [];
  let invalidReason: "missing_href" | "untrusted_href" | undefined;
  let invalidPath: string | undefined;

  for (let index = 0; index < count; index += 1) {
    const anchor = anchors.nth(index);
    const href = await anchor.getAttribute("href");
    const dataHref = await anchor.getAttribute("data-href");
    const dataUrl = await anchor.getAttribute("data-url");
    const navigationValues = [href, dataHref, dataUrl].filter((value): value is string =>
      Boolean(value),
    );

    for (const value of navigationValues) {
      const profileUrl = normalizeStudentConsultingVisibleMatchedJobsUrl(value);
      if (profileUrl) profilePaths.add(new URL(profileUrl).pathname);
    }

    const label = await safeInnerText(anchor);
    const semanticMatch = isStudentConsultingMatchedJobsLabel(label);
    if (semanticMatch) anchorSemanticMatches += 1;

    const visible = await anchor.isVisible();
    if (visible) visibleAnchors += 1;
    if (!visible || !semanticMatch) continue;
    visibleAnchorSemanticMatches += 1;

    const safeUrls = new Set(
      navigationValues
        .map((value) => normalizeStudentConsultingVisibleMatchedJobsUrl(value))
        .filter((value): value is string => Boolean(value)),
    );
    if (safeUrls.size > 1) {
      return { status: "invalid", reason: "ambiguous" };
    }
    if (safeUrls.size === 1) {
      const unsafeValue = navigationValues.find(
        (value) =>
          !normalizeStudentConsultingVisibleMatchedJobsUrl(value) &&
          !isStudentConsultingNavigationPlaceholder(value),
      );
      if (unsafeValue) {
        invalidReason = "untrusted_href";
        invalidPath = safeStudentConsultingPath(unsafeValue);
        continue;
      }
      validUrls.add([...safeUrls][0]);
      continue;
    }

    if (navigationValues.length === 0) {
      invalidReason = "missing_href";
      continue;
    }

    if (navigationValues.every((value) => isStudentConsultingNavigationPlaceholder(value))) {
      placeholderAnchors.push(anchor);
      continue;
    }

    invalidReason = "untrusted_href";
    invalidPath = navigationValues.map(safeStudentConsultingPath).find(Boolean) ?? undefined;
  }

  if (invalidReason) {
    return { status: "invalid", reason: invalidReason, path: invalidPath };
  }
  if (validUrls.size > 1) {
    return { status: "invalid", reason: "ambiguous" };
  }
  if (validUrls.size === 1) {
    return { status: "found", url: [...validUrls][0] };
  }

  if (placeholderAnchors.length > 0 && allowPlaceholderClick) {
    if (
      placeholderAnchors.length !== 1 ||
      visibleAnchorSemanticMatches !== placeholderAnchors.length
    ) {
      return { status: "invalid", reason: "ambiguous" };
    }

    try {
      await placeholderAnchors[0].click({ timeout: 10_000 });
      await page.waitForTimeout(400);
    } catch {
      return { status: "invalid", reason: "missing_href" };
    }

    const clickedUrl = normalizeStudentConsultingVisibleMatchedJobsUrl(page.url());
    if (clickedUrl) {
      return { status: "found", url: clickedUrl };
    }

    const rescanned = await findMatchedJobsNavigation(page, false);
    if (rescanned.status !== "absent") return rescanned;

    const inPlaceUrl = normalizeStudentConsultingProfileAreaUrl(page.url());
    if (inPlaceUrl) {
      const listing = await collectJobLinks(page);
      if (listing.links.length > 0 || listing.explicitEmpty) {
        return { status: "in_place", url: inPlaceUrl, listing };
      }
    }

    const safeCurrent = normalizeStudentConsultingMainOriginUrl(page.url());
    return {
      status: "invalid",
      reason: "untrusted_href",
      path: safeCurrent ? new URL(safeCurrent).pathname : undefined,
    };
  }

  if (visibleAnchorSemanticMatches === placeholderAnchors.length) {
    const controls = page.locator('button,[role="link"],[data-href],[data-url],[onclick]');
    const controlCount = await controls.count();
    const matchingControls: BrowserLocator[] = [];
    let visibleControls = 0;
    let controlSemanticMatches = 0;
    let visibleControlSemanticMatches = 0;

    for (let index = 0; index < controlCount; index += 1) {
      const control = controls.nth(index);

      for (const attribute of ["data-href", "data-url"] as const) {
        const value = await control.getAttribute(attribute);
        if (!value) continue;
        const profileUrl = normalizeStudentConsultingVisibleMatchedJobsUrl(value);
        if (profileUrl) profilePaths.add(new URL(profileUrl).pathname);
      }

      const label = await safeInnerText(control);
      const semanticMatch = isStudentConsultingMatchedJobsLabel(label);
      if (semanticMatch) controlSemanticMatches += 1;

      const visible = await control.isVisible();
      if (visible) visibleControls += 1;
      if (!visible || !semanticMatch) continue;

      visibleControlSemanticMatches += 1;
      matchingControls.push(control);
    }

    if (matchingControls.length > 1) {
      return { status: "invalid", reason: "ambiguous" };
    }

    if (matchingControls.length === 1) {
      try {
        await matchingControls[0].click({ timeout: 10_000 });
        await page.waitForTimeout(400);
      } catch {
        return { status: "invalid", reason: "missing_href" };
      }

      const clickedUrl = normalizeStudentConsultingVisibleMatchedJobsUrl(page.url());
      if (clickedUrl) {
        return { status: "found", url: clickedUrl };
      }

      const safeCurrent = normalizeStudentConsultingMainOriginUrl(page.url());
      return {
        status: "invalid",
        reason: "untrusted_href",
        path: safeCurrent ? new URL(safeCurrent).pathname : undefined,
      };
    }

    const [dataHref, dataUrl, onclick] = await Promise.all([
      page.locator("[data-href]").count(),
      page.locator("[data-url]").count(),
      page.locator("[onclick]").count(),
    ]);

    return {
      status: "absent",
      profilePaths: [...profilePaths].sort().slice(0, 20),
      diagnostics: {
        anchors: count,
        visibleAnchors,
        controls: controlCount,
        visibleControls,
        semanticMatches: anchorSemanticMatches + controlSemanticMatches,
        visibleSemanticMatches: visibleAnchorSemanticMatches + visibleControlSemanticMatches,
        dataHref,
        dataUrl,
        onclick,
      },
    };
  }
  if (invalidReason) {
    return { status: "invalid", reason: invalidReason, path: invalidPath };
  }
  if (validUrls.size !== 1) {
    return { status: "invalid", reason: "ambiguous" };
  }
  return { status: "found", url: [...validUrls][0] };
}

async function hasVisibleStudentConsultingLoginControls(page: BrowserPage): Promise<boolean> {
  const password = await firstVisible(page, [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ]);
  if (!password) return false;

  const username = await firstVisible(page, [
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[name="Email"]',
    'input[name="email"]',
  ]);
  return Boolean(username);
}

export async function loadStudentConsultingCountryIndex(
  fetcher: typeof fetch = fetch,
): Promise<Map<string, StudentConsultingCountry>> {
  const result = new Map<string, StudentConsultingCountry>();
  const ambiguous = new Set<string>();

  for (const country of STUDENTCONSULTING_COUNTRIES) {
    let page = 1;
    let totalHits = Number.POSITIVE_INFINITY;

    while ((page - 1) * COUNTRY_PAGE_SIZE < totalHits && page <= 10) {
      const response = await fetcher(JOB_OPENINGS_API, {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-language": "sv-SE",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          locations: [{ type: "country", id: country.id, name: country.country }],
          professions: [],
          schemas: [],
          types: [],
          keywords: [],
          onlySummer: false,
          onlyInternal: false,
          sortOrder: 0,
          page,
          pageSize: COUNTRY_PAGE_SIZE,
        }),
      });
      if (!response.ok) {
        throw new Error(`STUDENTCONSULTING_COUNTRY_INDEX_FAILED: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        data?: Array<{ url?: string }>;
        meta?: { totalHits?: number };
      };
      const rows = Array.isArray(payload.data) ? payload.data : [];
      totalHits = Number(payload.meta?.totalHits ?? rows.length);

      for (const row of rows) {
        const externalId = row.url?.match(/\/([0-9]+)\/?(?:\?.*)?$/)?.[1];
        if (!externalId || ambiguous.has(externalId)) continue;

        const value: StudentConsultingCountry = {
          country: country.country,
          countryCode: country.countryCode,
          isInternational: country.isInternational,
        };
        const existing = result.get(externalId);
        if (existing && existing.countryCode !== value.countryCode) {
          result.delete(externalId);
          ambiguous.add(externalId);
          continue;
        }
        result.set(externalId, value);
      }

      if (rows.length === 0) break;
      page += 1;
    }
  }

  return result;
}

function isSameMatchedJobsRoute(current: string, expected: string): boolean {
  const currentSafe = normalizeStudentConsultingMainOriginUrl(current);
  const expectedSafe =
    normalizeStudentConsultingVisibleMatchedJobsUrl(expected) ??
    normalizeStudentConsultingMatchedJobsUrl(expected);
  if (!currentSafe || !expectedSafe) return false;

  return new URL(currentSafe).pathname === new URL(expectedSafe).pathname;
}

interface MatchedListingDiagnostics {
  anchors: number;
  dataHref: number;
  dataUrl: number;
  onclick: number;
  iframes: number;
  jobLike: number;
}

interface MatchedListingObservation {
  links: string[];
  explicitEmpty: boolean;
  diagnostics?: MatchedListingDiagnostics;
}

async function collectJobLinks(page: BrowserPage): Promise<MatchedListingObservation> {
  const started = Date.now();

  while (Date.now() - started < MATCHED_LISTING_WAIT_MS) {
    const links = new Set<string>();
    const sources = [
      { selector: "a[href]", attribute: "href" },
      { selector: "[data-href]", attribute: "data-href" },
      { selector: "[data-url]", attribute: "data-url" },
      { selector: "[onclick]", attribute: "onclick" },
    ] as const;

    for (const source of sources) {
      const elements = page.locator(source.selector);
      const count = await elements.count();
      for (let index = 0; index < count; index += 1) {
        const value = await elements.nth(index).getAttribute(source.attribute);
        if (!value) continue;
        for (const candidate of extractStudentConsultingJobUrlCandidates(value)) {
          const safeJobUrl = normalizeStudentConsultingJobUrl(candidate);
          if (safeJobUrl) links.add(safeJobUrl);
        }
      }
    }

    if (links.size > 0) {
      return { links: [...links], explicitEmpty: false };
    }

    const bodyText = await safeInnerText(page.locator("body").first());
    if (matchedListingExplicitlyEmpty(bodyText)) {
      return { links: [], explicitEmpty: true };
    }

    await page.waitForTimeout(400);
  }

  const bodyText = await safeInnerText(page.locator("body").first());
  const explicitEmpty = matchedListingExplicitlyEmpty(bodyText);
  return {
    links: [],
    explicitEmpty,
    diagnostics: explicitEmpty ? undefined : await describeMatchedListingStructure(page),
  };
}

async function describeMatchedListingStructure(
  page: BrowserPage,
): Promise<MatchedListingDiagnostics> {
  const [anchors, dataHref, dataUrl, onclick, iframes, jobLike] = await Promise.all([
    page.locator("a[href]").count(),
    page.locator("[data-href]").count(),
    page.locator("[data-url]").count(),
    page.locator("[onclick]").count(),
    page.locator("iframe").count(),
    page.locator('[class*="job"], [id*="job"]').count(),
  ]);
  return { anchors, dataHref, dataUrl, onclick, iframes, jobLike };
}

function matchedListingExplicitlyEmpty(text: string): boolean {
  return /(?:^|\n)\s*(?:0\s+(?:matchande|matchade)?\s*jobb|inga\s+(?:matchande|matchade)?\s*jobb|inget\s+jobb\s+matchar)[^\n]*(?:$|\n)/im.test(
    text,
  );
}

async function firstVisible(
  page: BrowserPage,
  selectors: string[],
): Promise<BrowserLocator | null> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count(), 10);
    for (let index = 0; index < count; index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  return null;
}

export function buildStudentConsultingPitch(_job: JobCandidate): string {
  return "Behöver jobb.";
}

async function expandExperienceQuestion(page: BrowserPage): Promise<void> {
  const controls = page.locator(
    'button[aria-expanded],[role="button"][aria-expanded],summary,[data-toggle="collapse"],[data-bs-toggle="collapse"]',
  );
  const count = Math.min(await controls.count(), 100);
  let clicked = false;

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    const label = normalize(await safeInnerText(control));
    if (!/(erfarenhet|experience)/i.test(label)) continue;
    if ((await control.getAttribute("aria-expanded")) === "true") continue;
    await control.click({ timeout: 5_000 });
    clicked = true;
  }

  if (clicked) await page.waitForTimeout(250);
}

function isNoExperienceAnswer(label: string): boolean {
  const normalized = normalize(label);
  return /^(ingen.*erfarenhet|saknar.*erfarenhet|0\s*(års?|år|year|years)?\s*(erfarenhet|experience)?|none|no experience)$/.test(
    normalized,
  );
}

async function selectNoExperienceAnswer(page: BrowserPage): Promise<void> {
  const candidates = page.locator('label,button,[role="radio"]');
  const count = Math.min(await candidates.count(), 150);
  const matches: BrowserLocator[] = [];

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    if (isNoExperienceAnswer(await safeInnerText(candidate))) {
      matches.push(candidate);
    }
  }

  if (matches.length === 1) {
    await matches[0].click({ timeout: 5_000 });
  }
}

async function fillKnownSafeRequiredControls(page: BrowserPage, job: JobCandidate): Promise<void> {
  await expandExperienceQuestion(page);
  await selectNoExperienceAnswer(page);

  const pitchFields = page.locator('textarea#Pitch, textarea[name="Pitch"]');
  const count = Math.min(await pitchFields.count(), 2);
  if (count !== 1) return;

  const pitch = pitchFields.first();
  if (!(await pitch.isVisible())) return;
  if ((await pitch.inputValue()).trim() !== "") return;

  await pitch.fill(buildStudentConsultingPitch(job));
}

async function validateRequiredControls(
  page: BrowserPage,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const controls = page.locator(
    [
      "input[required]",
      "textarea[required]",
      "select[required]",
      "input[data-val-required]",
      "textarea[data-val-required]",
      "select[data-val-required]",
      'input[aria-required="true"]',
      'textarea[aria-required="true"]',
      'select[aria-required="true"]',
    ].join(", "),
  );
  const count = Math.min(await controls.count(), 100);
  const checkedRadioGroups = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;

    const type = ((await control.getAttribute("type")) ?? "").toLowerCase();
    if (type === "radio") {
      const name = (await control.getAttribute("name"))?.trim();
      if (!name) {
        if (!(await control.isChecked())) {
          return {
            ok: false,
            error: "APPLICATION_REQUIRES_INPUT: a required radio option is unresolved.",
          };
        }
        continue;
      }

      if (checkedRadioGroups.has(name)) continue;
      if (!(await anyRadioChecked(page, name))) {
        return {
          ok: false,
          error: "APPLICATION_REQUIRES_INPUT: a required radio group is unresolved.",
        };
      }
      checkedRadioGroups.add(name);
      continue;
    }

    if (type === "checkbox") {
      if (!(await control.isChecked())) {
        return {
          ok: false,
          error: "APPLICATION_REQUIRES_INPUT: a required checkbox is unresolved.",
        };
      }
      continue;
    }

    if (type === "file") {
      return {
        ok: false,
        error: "APPLICATION_REQUIRES_INPUT: a required file upload is unresolved.",
      };
    }

    if ((await control.inputValue()).trim() === "") {
      return {
        ok: false,
        error: "APPLICATION_REQUIRES_INPUT: a required application field is empty.",
      };
    }
  }

  return { ok: true };
}

async function anyRadioChecked(page: BrowserPage, name: string): Promise<boolean> {
  const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const radios = page.locator(`input[type="radio"][name="${escapedName}"]`);
  const count = Math.min(await radios.count(), 100);
  for (let index = 0; index < count; index += 1) {
    if (await radios.nth(index).isChecked()) return true;
  }
  return false;
}

async function findApplicationSubmit(page: BrowserPage): Promise<BrowserLocator | null> {
  const controls = page.locator('button, input[type="submit"]');
  const count = Math.min(await controls.count(), 100);
  const matches: BrowserLocator[] = [];
  const accepted = /^(skicka( in)? ansökan|sök tjänsten|sök jobbet|ansök)$/i;

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    const label = (
      (await safeInnerText(control)) ||
      (await control.getAttribute("value")) ||
      ""
    ).trim();
    if (accepted.test(label)) matches.push(control);
  }
  return matches.length === 1 ? matches[0] : null;
}

interface AuthenticatedApplicationStatus {
  found: boolean;
  applied: boolean;
}

async function readAuthenticatedApplicationStatus(
  page: BrowserPage,
  externalId: string,
  countryCode?: string,
): Promise<AuthenticatedApplicationStatus | null> {
  if (!page.evaluate) return null;

  const countries = STUDENTCONSULTING_COUNTRIES.filter(
    (country) => !countryCode || country.countryCode === countryCode,
  ).map((country) => ({ id: country.id, name: country.country }));
  const targets =
    countries.length > 0
      ? countries
      : STUDENTCONSULTING_COUNTRIES.map((country) => ({
          id: country.id,
          name: country.country,
        }));

  try {
    return await page.evaluate(
      async (input) => {
        for (const country of input.countries) {
          const response = await fetch("/api/v1/jobopenings", {
            method: "POST",
            credentials: "include",
            headers: {
              accept: "application/json",
              "accept-language": "sv-SE",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              locations: [
                {
                  type: "country",
                  id: country.id,
                  name: country.name,
                },
              ],
              professions: [],
              schemas: [],
              types: [],
              keywords: [],
              onlySummer: false,
              onlyInternal: false,
              sortOrder: 0,
              page: 1,
              pageSize: 200,
            }),
          });
          if (!response.ok) continue;

          const payload = (await response.json()) as {
            data?: Array<{ url?: string; is_applied?: boolean }>;
          };
          const rows = Array.isArray(payload.data) ? payload.data : [];
          const row = rows.find(
            (candidate) => candidate.url?.match(/\/(\d+)\/?(?:\?.*)?$/)?.[1] === input.externalId,
          );
          if (row) {
            return { found: true, applied: row.is_applied === true };
          }
        }

        return { found: false, applied: false };
      },
      { externalId, countries: targets },
    );
  } catch {
    return null;
  }
}

type ApplicationsNavigation = { status: "found"; url: string } | { status: "in_place" };

function isApplicationsLabel(label: string): boolean {
  return /^(ansökningar|applications|søknader|ansøgninger)$/i.test(label.trim());
}

async function findApplicationsNavigation(
  page: BrowserPage,
  externalId: string,
  allowPlaceholderClick = true,
): Promise<ApplicationsNavigation | null> {
  const anchors = page.locator("a");
  const count = Math.min(await anchors.count(), 300);
  const safeUrls = new Set<string>();
  const placeholderAnchors: BrowserLocator[] = [];

  for (let index = 0; index < count; index += 1) {
    const anchor = anchors.nth(index);
    if (!(await anchor.isVisible())) continue;
    const label = await safeInnerText(anchor);
    if (!isApplicationsLabel(label)) continue;

    const navigationValues = (
      await Promise.all([
        anchor.getAttribute("href"),
        anchor.getAttribute("data-href"),
        anchor.getAttribute("data-url"),
      ])
    ).filter((value): value is string => Boolean(value));

    const trusted = new Set(
      navigationValues
        .map((value) => normalizeStudentConsultingVisibleMatchedJobsUrl(value))
        .filter((value): value is string => Boolean(value)),
    );
    if (trusted.size > 1) return null;
    if (trusted.size === 1) {
      const hasUnsafeAlternative = navigationValues.some(
        (value) =>
          !normalizeStudentConsultingVisibleMatchedJobsUrl(value) &&
          !isStudentConsultingNavigationPlaceholder(value),
      );
      if (hasUnsafeAlternative) return null;
      safeUrls.add([...trusted][0]);
      continue;
    }

    if (
      navigationValues.length > 0 &&
      navigationValues.every((value) => isStudentConsultingNavigationPlaceholder(value))
    ) {
      placeholderAnchors.push(anchor);
      continue;
    }

    return null;
  }

  if (safeUrls.size > 1) return null;
  if (safeUrls.size === 1) return { status: "found", url: [...safeUrls][0] };

  if (placeholderAnchors.length === 1 && allowPlaceholderClick) {
    const hadReferenceBeforeClick = await pageContainsExactJobReference(page, externalId);
    try {
      await placeholderAnchors[0].click({ timeout: 10_000 });
      await page.waitForTimeout(400);
    } catch {
      return null;
    }

    const clickedUrl = normalizeStudentConsultingVisibleMatchedJobsUrl(page.url());
    if (clickedUrl && new URL(clickedUrl).pathname !== new URL(PROFILE_URL).pathname) {
      return { status: "found", url: clickedUrl };
    }

    const rescanned = await findApplicationsNavigation(page, externalId, false);
    if (rescanned) return rescanned;

    if (
      normalizeStudentConsultingProfileAreaUrl(page.url()) &&
      !hadReferenceBeforeClick &&
      (await pageContainsExactJobReference(page, externalId))
    ) {
      return { status: "in_place" };
    }
    return null;
  }

  const controls = page.locator('button,[role="link"],[data-href],[data-url],[onclick]');
  const controlCount = Math.min(await controls.count(), 300);
  const matchingControls: BrowserLocator[] = [];

  for (let index = 0; index < controlCount; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    const label = await safeInnerText(control);
    if (!isApplicationsLabel(label)) continue;
    matchingControls.push(control);
  }

  if (matchingControls.length !== 1) return null;

  const hadReferenceBeforeClick = await pageContainsExactJobReference(page, externalId);
  try {
    await matchingControls[0].click({ timeout: 10_000 });
    await page.waitForTimeout(400);
  } catch {
    return null;
  }

  const clickedUrl = normalizeStudentConsultingVisibleMatchedJobsUrl(page.url());
  if (clickedUrl && new URL(clickedUrl).pathname !== new URL(PROFILE_URL).pathname) {
    return { status: "found", url: clickedUrl };
  }
  if (
    normalizeStudentConsultingProfileAreaUrl(page.url()) &&
    !hadReferenceBeforeClick &&
    (await pageContainsExactJobReference(page, externalId))
  ) {
    return { status: "in_place" };
  }
  return null;
}

async function pageContainsExactJobReference(
  page: BrowserPage,
  externalId: string,
): Promise<boolean> {
  const bodyText = await safeInnerText(page.locator("body").first());
  if (containsExactJobId(bodyText, externalId)) return true;

  const selectors = [
    { selector: "a[href]", attribute: "href" },
    { selector: "[data-href]", attribute: "data-href" },
    { selector: "[data-url]", attribute: "data-url" },
    { selector: "[onclick]", attribute: "onclick" },
  ] as const;

  for (const source of selectors) {
    const elements = page.locator(source.selector);
    const count = await elements.count();
    for (let index = 0; index < count; index += 1) {
      const value = await elements.nth(index).getAttribute(source.attribute);
      if (!value) continue;
      for (const candidate of extractStudentConsultingJobUrlCandidates(value)) {
        const safeJobUrl = normalizeStudentConsultingJobUrl(candidate);
        if (!safeJobUrl) continue;
        const match = new URL(safeJobUrl).pathname.match(/\/(\d+)\/?$/);
        if (match?.[1] === externalId.trim()) return true;
      }
    }
  }

  return false;
}

async function waitForSubmissionToSettle(page: BrowserPage, timeout: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const body = await safeInnerText(page.locator("body").first());
    if (submissionConfirmationVisible(body)) return;

    try {
      await page.waitForLoadState("networkidle", { timeout: 750 });
    } catch {
      // Same-page submissions may never trigger a navigation event.
    }
    await page.waitForTimeout(250);
  }
}

function submissionConfirmationVisible(text: string): boolean {
  return /tack för din ansökan|ansökan (?:har )?skickats|application (?:has been )?submitted|søknad(?:en)? (?:er )?sendt|ansøgning(?:en)? (?:er )?sendt|redan sökt|already applied|allerede søkt|allerede søgt/i.test(
    text,
  );
}

async function settleAfterAuthentication(page: BrowserPage, timeout: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 2_000 });
    } catch {
      // Authentication redirects may still be in progress.
    }

    const host = safeHostname(page.url());
    if (
      host &&
      host !== STUDENTCONSULTING_IDP &&
      isHostOrSubdomain(host, STUDENTCONSULTING_DOMAIN)
    ) {
      return;
    }
    await page.waitForTimeout(300);
  }
}

function readFact(text: string, label: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLabel = normalize(label);

  const inlinePattern = new RegExp(`^${escapeRegExp(label)}(?:\\s*[:–-]\\s*|\\s+)(.+)$`, "i");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = normalize(line);
    if (normalizedLine === normalizedLabel) return lines[index + 1];

    const inlineMatch = line.match(inlinePattern);
    const value = inlineMatch?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function classifyCountry(value?: string): {
  country?: string;
  countryCode?: string;
  isInternational: boolean;
} {
  const normalized = normalize(value ?? "");
  if (!normalized) {
    return { isInternational: false };
  }
  if (/^(sverige|sweden)$/.test(normalized)) {
    return { country: value, countryCode: "SE", isInternational: false };
  }
  if (/^(norge|norway)$/.test(normalized)) {
    return { country: value, countryCode: "NO", isInternational: true };
  }
  if (/^(danmark|denmark)$/.test(normalized)) {
    return { country: value, countryCode: "DK", isInternational: true };
  }
  return { country: value, isInternational: true };
}

function withPage(url: string, page: number): string {
  const safe = normalizeStudentConsultingUrl(url);
  if (!safe) throw new Error("Unsafe StudentConsulting listing URL");
  if (page <= 1) return safe;

  const parsed = new URL(safe);
  parsed.searchParams.set("page", String(page));
  return parsed.toString();
}

function alreadyApplied(text: string): boolean {
  return /redan sökt|already applied|allerede søkt|allerede søgt/i.test(text);
}

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

async function safeInnerText(locator: BrowserLocator): Promise<string> {
  try {
    return await locator.innerText();
  } catch {
    return "";
  }
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("sv-SE").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
