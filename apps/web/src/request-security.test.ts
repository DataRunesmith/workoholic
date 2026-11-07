import { describe, expect, it } from "vitest";
import { requireSameOriginMutation } from "./request-security";

describe("requireSameOriginMutation", () => {
  it("allows safe methods without an Origin header", () => {
    expect(
      requireSameOriginMutation(new Request("https://workoholic.example.com/api/dashboard")),
    ).toBeNull();
  });

  it("allows a same-origin mutation", () => {
    const request = new Request("https://workoholic.example.com/api/runs/manual", {
      method: "POST",
      headers: {
        Origin: "https://workoholic.example.com",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(requireSameOriginMutation(request)).toBeNull();
  });

  it.each([undefined, "https://evil.example", "not a valid origin"])(
    "rejects missing or invalid origin %s",
    (origin) => {
      const headers = origin ? { Origin: origin } : undefined;
      const request = new Request("https://workoholic.example.com/api/runs/manual", {
        method: "POST",
        headers,
      });
      expect(requireSameOriginMutation(request)?.status).toBe(403);
    },
  );

  it("rejects cross-site fetch metadata even when Origin is forged", () => {
    const request = new Request("https://workoholic.example.com/api/runs/manual", {
      method: "POST",
      headers: {
        Origin: "https://workoholic.example.com",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(requireSameOriginMutation(request)?.status).toBe(403);
  });
});
