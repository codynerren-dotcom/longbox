import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isGcdScanHost } from "@/lib/catalog/match-row";
import {
  REMATCH_MODE_DEFAULT,
  acceptBlocked,
  acceptRequest,
  priorLinkOf,
  priorProposalBlocked,
  proposalAction,
  proposalBlocked,
  proposalHit,
  proposalReason,
  saveProposal,
  setProposalStoreForTests,
  unmatchedPlan,
  visibleProposals,
  type ProposalInput,
  type ProposalStatus,
} from "@/lib/covers/propose-match";

const prior = priorLinkOf({
  metronIssueId: "10",
  metronSeriesId: "2",
  gcdIssueId: null,
  coverFile: "shelf.jpg",
  coverUrl: "/covers/files/shelf.jpg",
  coverStatus: "matched",
  manualLink: null,
});

function draft(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    comicId: "c1",
    provider: "metron",
    issueId: "50",
    seriesId: "9",
    confidence: 82,
    reason: "Proposed Metron 50 (Saga #1), score 82.",
    coverUrl: "https://metron.cloud/media/issue/50.jpg",
    title: "Saga",
    issueNo: "1",
    variant: "Cover A",
    priorLink: prior,
    ...overrides,
  };
}

describe("propose-mode re-match", () => {
  afterEach(() => setProposalStoreForTests(null));

  it("proposes by default and leaves the comic alone until accept", () => {
    expect(REMATCH_MODE_DEFAULT).toBe("propose");
    expect(unmatchedPlan("propose")).toBe("leave");
    expect(unmatchedPlan("apply")).toBe("clear");
  });

  it("does not offer a hand-picked link or an uploaded cover", () => {
    expect(proposalBlocked({ metronIssueId: "10", userCover: false })).toMatch(/chosen by hand/);
    expect(proposalBlocked({ userCover: true })).toMatch(/uploaded/);
    expect(proposalBlocked(null)).toBeNull();
    expect(priorProposalBlocked({ ...prior, manualMetronIssueId: "10" })).toMatch(/chosen by hand/);
    expect(priorProposalBlocked({ ...prior, userCover: true })).toMatch(/uploaded/);
  });

  it("remembers a rejection and an acceptance, and refreshes a pending row", async () => {
    const saved: ProposalInput[] = [];
    const status = new Map<string, ProposalStatus>();
    setProposalStoreForTests({
      find: async (comicId, provider, issueId) => {
        const row = status.get(`${comicId}:${provider}:${issueId}`);
        return row ? { status: row } : null;
      },
      save: async (input) => {
        saved.push(input);
        status.set(`${input.comicId}:${input.provider}:${input.issueId}`, "pending");
      },
    });

    expect(await saveProposal(draft())).toBe("saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.priorLink.coverFile).toBe("shelf.jpg");
    expect(saved[0]?.priorLink.metronIssueId).toBe("10");

    expect(await saveProposal(draft({ reason: "Updated.", confidence: 90 }))).toBe("saved");
    expect(saved[1]?.reason).toBe("Updated.");

    status.set("c1:metron:50", "rejected");
    expect(proposalAction("rejected")).toBe("skip");
    expect(await saveProposal(draft({ reason: "Again." }))).toBe("skipped");
    expect(saved).toHaveLength(2);

    status.set("c1:metron:50", "accepted");
    expect(await saveProposal(draft())).toBe("skipped");
    expect(await saveProposal(draft({ issueId: "10" }))).toBe("unchanged");

    expect(await saveProposal(draft({ priorLink: { ...prior, manualGcdIssueId: "77" } }))).toBe("skipped");
    expect(saved).toHaveLength(2);
  });

  it("accepts through the manual link flags and leaves a photo or a GCD scan", () => {
    const metron = acceptRequest(draft(), false);
    expect(metron.useCover).toBe(true);
    expect(metron.replaceExisting).toBe(false);
    expect(metron.overwrite).toBe(false);
    expect(metron.fillMissing).toBe(true);
    expect(metron.coverImageUrl).toBe("https://metron.cloud/media/issue/50.jpg");

    const photo = acceptRequest(draft(), true);
    expect(photo.useCover).toBe(false);
    expect(photo.coverImageUrl).toBeNull();

    const gcd = acceptRequest(draft({ provider: "gcd", coverUrl: "https://files1.comics.org/scan.jpg" }), false);
    expect(gcd.useCover).toBe(false);
    expect(gcd.hit.coverUrl).toBeNull();
    expect(isGcdScanHost("https://files1.comics.org/scan.jpg")).toBe(true);
    expect(acceptBlocked({ metronIssueId: "99" }, "metron", "50")).toMatch(/chosen by hand/);
    expect(acceptBlocked({ metronIssueId: "50" }, "metron", "50")).toBeNull();
    expect(acceptBlocked(null, "gcd", "1")).toBeNull();
  });

  it("filters the list accept-all would link", () => {
    const rows = [
      { id: "m", provider: "metron", title: "Saga", issueNo: "1", variant: "A", reason: "score 80", shelf: "Saga 1" },
      { id: "g", provider: "gcd", title: "Saga", issueNo: "1", variant: null, reason: "score 70", shelf: "Saga 1" },
    ];
    expect(visibleProposals(rows, { provider: "gcd" }).map((row) => row.id)).toEqual(["g"]);
    expect(visibleProposals(rows, { q: "score 80" }).map((row) => row.id)).toEqual(["m"]);
    expect(visibleProposals(rows, { provider: "all", q: "" })).toHaveLength(2);
    const linked = { ...rows[0], id: "hand", manualLink: { metronIssueId: "10", userCover: false } };
    expect(visibleProposals([...rows, linked], { provider: "all" }).map((row) => row.id)).toEqual(["m", "g"]);
  });

  it("names the proposal and stores the prior link", () => {
    expect(proposalReason("metron", "Saga", "1", "50", 82)).toBe("Proposed Metron 50 (Saga #1), score 82.");
    const hit = proposalHit(draft());
    expect(hit.source).toBe("metron");
    expect(hit.id).toBe("50");
    expect(priorLinkOf({ manualLink: { userCover: true }, coverFile: "photo.jpg" }).userCover).toBe(true);
  });

  it("wires propose mode through re-match, review, and the sidebar", () => {
    const rematch = readFileSync(new URL("../src/lib/covers/facsimile-rematch.ts", import.meta.url), "utf8");
    const review = readFileSync(new URL("../src/app/review/review-list.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../src/app/review/page.tsx", import.meta.url), "utf8");
    const actions = readFileSync(new URL("../src/app/review/actions.ts", import.meta.url), "utf8");
    const shell = readFileSync(new URL("../src/components/shell.tsx", import.meta.url), "utf8");
    const logs = readFileSync(new URL("../src/app/logs/page.tsx", import.meta.url), "utf8");
    expect(rematch).toContain("REMATCH_MODE_DEFAULT");
    expect(rematch).toContain("unmatchedPlan(mode)");
    expect(rematch).toContain("holdProposal");
    expect(review).toContain("Accept all");
    expect(review).toContain("window.confirm");
    expect(review).toContain("Cover on GCD");
    expect(review).toContain("Reject");
    expect(page).toContain("visibleProposals");
    expect(actions).toContain("linkIssueToCatalog");
    expect(actions).toContain("acceptRequest");
    expect(shell).toContain("Review matches");
    expect(shell).toContain("proposalCount");
    expect(logs).toContain('href="/review"');
    expect(logs).toContain("EditionJobControls");
    expect(logs).toContain("editionSummaryText");
    expect(page).toContain("manualLink");
    const controls = readFileSync(new URL("../src/app/logs/edition-controls.tsx", import.meta.url), "utf8");
    expect(controls).toContain("Resume re-match");
    expect(controls).toContain("Clear re-match");
  });
});
