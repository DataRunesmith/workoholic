import { describe, expect, it } from "vitest";
import { loadVerifiedReportApplications } from "./report-storage";

describe("activity report storage", () => {
  it("allows a report month with no locally verified applications", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [] };
          },
        };
      },
    } as unknown as D1Database;

    await expect(loadVerifiedReportApplications(db, "2026-09")).resolves.toEqual([]);
  });
});
