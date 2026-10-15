import { afterEach, describe, expect, it } from "vitest";
import { viewerFromHeaders } from "@/lib/auth";

describe("viewer hook", () => {
  const previous = process.env.LONGBOX_USER_EMAIL;

  afterEach(() => {
    if (previous === undefined) delete process.env.LONGBOX_USER_EMAIL;
    else process.env.LONGBOX_USER_EMAIL = previous;
  });

  it("trusts the Cloudflare Access email when the header is present", () => {
    const headers = new Headers({ "Cf-Access-Authenticated-User-Email": "cody@example.com" });
    expect(viewerFromHeaders(headers)).toEqual({ email: "cody@example.com", source: "cloudflare-access" });
  });

  it("falls back to the single configured user", () => {
    process.env.LONGBOX_USER_EMAIL = "cody@localhost";
    expect(viewerFromHeaders(new Headers())).toEqual({ email: "cody@localhost", source: "single-user" });
  });
});
