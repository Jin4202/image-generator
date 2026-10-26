import { expect, it } from "vitest";
import { transition } from "../../src/domain/run-state";
import { passesReview } from "../../src/domain/approval";
it("handles fast completion, download recovery and ambiguous submission", () => { expect(transition("queued","downloading")).toBe("downloading"); expect(transition("download_failed","downloading")).toBe("downloading"); expect(transition("submitting","submission_unknown")).toBe("submission_unknown"); });
it.each(["succeeded","failed","submission_unknown","download_failed"] as const)("never resubmits %s", state => expect(() => transition(state,"submitting")).toThrow());
it("requires human approval and edit preservation", () => { const r={identity:4,style:4,composition:4,anatomy:3,preservation:null,approved:true,notes:""}; expect(passesReview(r,false)).toBe(true); expect(passesReview(r,true)).toBe(false); expect(passesReview({...r,approved:false},false)).toBe(false); });

it("submission errors preserve certainty and fail closed on unknown exceptions",async()=>{const {SubmissionError}=await import("../../src/domain/errors");const {submissionFailureState}=await import("../../src/domain/run-state");expect(submissionFailureState(new SubmissionError("rejected","rejected"))).toBe("failed");expect(submissionFailureState(new SubmissionError("unknown","timeout"))).toBe("submission_unknown");expect(submissionFailureState(new Error("unclassified"))).toBe("submission_unknown");});
