import { describe, expect, it } from "vitest";
import {
  activityExportFileName,
  activityJobType,
  activityScope,
  buildActivityReportText,
} from "./activity-export";
import type { ReportApplicationRow } from "./report-storage";

function row(overrides: Partial<ReportApplicationRow> = {}): ReportApplicationRow {
  return {
    applicationId: "app-1",
    externalId: "87567",
    title: "Kundservicemedarbetare – heltid i Malmö",
    employer: "StudentConsulting",
    location: "Malmö",
    countryCode: "SE",
    isInternational: false,
    appliedAt: "2026-10-02T12:27:23.119Z",
    verifiedAt: "2026-10-02T13:03:40.204Z",
    rawJson: JSON.stringify({ scope: "Heltid" }),
    ...overrides,
  };
}

describe("monthly activity export", () => {
  it("uses stored scope before title inference", () => {
    expect(activityScope(JSON.stringify({ scope: "Deltid/Extra" }), "Heltid i Malmö")).toBe(
      "Deltid/Extra",
    );
  });

  it("falls back to explicit scope wording in the title", () => {
    expect(activityScope(null, "Kundservicemedarbetare – heltid i Malmö")).toBe("Heltid");
    expect(activityScope(null, "Digital marknadsförare på deltid")).toBe("Deltid");
    expect(activityScope(null, "Nattjobb på terminal - flexibelt extrajobb för studenter!")).toBe(
      "Extrajobb",
    );
    expect(activityScope(null, "Terminalarbetare sökes")).toBe("Kontrollera annonsen");
  });

  it("names the kind of job from a specific occupation or the title's role word", () => {
    expect(activityJobType(JSON.stringify({ occupation: "Truckförare" }), "Student sökes")).toBe(
      "Truckförare",
    );
    const category = JSON.stringify({ occupation: "Logistik / Transport" });
    expect(activityJobType(category, "Studerande truckförare sökes till företag i Malmö!")).toBe(
      "Truckförare",
    );
    expect(activityJobType(category, "Lagerarbetare till eftermiddagen sökes!")).toBe(
      "Lagerarbetare",
    );
    expect(activityJobType(null, "Er du vår nye prosessoperatør?")).toBe("Prosessoperatør");
    expect(activityJobType(category, "Nattjobb på terminal")).toBe("Nattjobb på terminal");
  });

  it("names the file after the day the month's tenth application was verified", () => {
    expect(activityExportFileName({ ready_at: "2026-10-11T22:30:00.000Z" })).toBe(
      "jobbansokningar_2026-10-12.txt",
    );
  });

  it("produces the four-field txt without application dates", () => {
    const text = buildActivityReportText([
      row(),
      row({
        applicationId: "app-2",
        externalId: "87551",
        title: "Terminalarbetare sökes till Luleå",
        location: "Luleå",
        rawJson: JSON.stringify({ scope: "Deltid/Extra" }),
      }),
    ]);

    expect(text).toBe(
      "Jobb-ID: 87567\n" +
        "Jobbtyp: Kundservicemedarbetare\n" +
        "Stad: Malmö\n" +
        "Omfattning: Heltid\n\n" +
        "Jobb-ID: 87551\n" +
        "Jobbtyp: Terminalarbetare\n" +
        "Stad: Luleå\n" +
        "Omfattning: Deltid/Extra\n",
    );
    expect(text).not.toContain("2026-10-02");
  });
});
