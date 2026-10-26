import type { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies } from "../ports";
import { AppError } from "../../domain/errors";
import { passesReview } from "../../domain/approval";

/** Compared routes, in plan order; seeds are the repeat index 0..2 and outputCount is always 1. */
const routes = ["fal-flux2-edit", "fal-flux2-text"] as const;
const repeats = 3;

function parseId(id: string, label: string): string {
  const parsed = C.Id.safeParse(id);
  if (!parsed.success) throw new AppError("VALIDATION", `Invalid ${label}`);
  return parsed.data;
}
const conflict = (message: string): never => { throw new AppError("CONFLICT", message); };
const slotKey = (run: C.Run) => `${run.snapshot.sceneId}|${run.compiled.adapterId}|${run.compiled.parameters.seed}`;
/** Scene-level task intent (scene copy, versions, edit) — everything except the route-specific compiled request. */
const intentOf = (snapshot: C.Snapshot) => JSON.stringify(C.Snapshot.parse(snapshot));

/** T11: docs/contracts.md#experiments. Preserve signature; implement all listed invariants. */
export async function createExperiment(deps: Dependencies, input: z.infer<typeof C.ExperimentInput>): Promise<C.Experiment> {
  const parsed = C.ExperimentInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "An experiment needs one project and three distinct scenes with repeats=3");
  const { projectId, sceneIds } = parsed.data;
  // Plan only: no preview, run or provider call is created here; each slot is generated later by explicit user action.
  return deps.repo.transaction(tx => {
    if (!tx.get("projects", projectId)) throw new AppError("NOT_FOUND", "Project not found");
    const sceneRevisions: Record<string, number> = {};
    for (const sceneId of sceneIds) {
      const scene = tx.get("scenes", sceneId);
      if (!scene || scene.projectId !== projectId) throw new AppError("NOT_FOUND", "Scene not found");
      sceneRevisions[sceneId] = scene.revision;
    }
    const experiment = C.Experiment.parse({ id: deps.newId(), projectId, revision: 0, createdAt: deps.now(), sceneIds: [...sceneIds], sceneRevisions, runIds: [] });
    tx.insert("experiments", experiment);
    return experiment;
  });
}

/** T11: docs/contracts.md#experiments. Preserve signature; implement all listed invariants. */
export async function reportExperiment(deps: Dependencies, id: string): Promise<{ total: number; accepted: number; acceptanceRate: number | null; costPerAccepted: C.Money; medianLatencyMs: number | null }> {
  const experimentId = parseId(id, "experiment ID");
  const { runs, candidates, reviews } = deps.repo.transaction(tx => {
    const experiment = tx.get("experiments", experimentId);
    if (!experiment) throw new AppError("NOT_FOUND", "Experiment not found");
    const runs = experiment.runIds.map(runId => tx.get("runs", runId)).filter((r): r is C.Run => r !== null);
    const runIds = new Set(runs.map(r => r.id));
    const candidates = tx.list("candidates", experiment.projectId).filter(c => runIds.has(c.runId));
    return { runs, candidates, reviews: tx.list("reviews", experiment.projectId) };
  });
  // Every candidate of an attached run is in the sample; its latest review (createdAt, then id) decides acceptance.
  const accepted = candidates.filter(c => {
    const latest = reviews.filter(r => r.candidateId === c.id).at(-1);
    return latest !== undefined && passesReview(latest.ratings, c.parentCandidateId !== null);
  }).length;
  const total = candidates.length;
  let costPerAccepted: C.Money;
  if (accepted === 0) costPerAccepted = { kind: "unknown", reason: "no-accepted-results" };
  else if (runs.some(r => r.actualCost.kind !== "known")) costPerAccepted = { kind: "unknown", reason: "incomplete-billing" };
  else {
    // Actual billed cost only; estimates are never presented as actual spend.
    const spent = runs.reduce((sum, r) => sum + (r.actualCost.kind === "known" ? r.actualCost.micros : 0), 0);
    costPerAccepted = { kind: "known", micros: Math.round(spent / accepted), currency: "USD", source: "experiment-actual-cost", verifiedAt: deps.now() };
  }
  const latencies = runs.filter(r => r.status === "succeeded").map(r => Date.parse(r.updatedAt) - Date.parse(r.createdAt)).sort((a, b) => a - b);
  const mid = Math.floor(latencies.length / 2);
  const medianLatencyMs = latencies.length === 0 ? null : latencies.length % 2 ? latencies[mid] : (latencies[mid - 1] + latencies[mid]) / 2;
  return { total, accepted, acceptanceRate: total === 0 ? null : accepted / total, costPerAccepted, medianLatencyMs };
}

/** T11: attach completed or pending run to its planned experiment slot; no submit side effect. */
export async function attachExperimentRun(deps: Dependencies, experimentId: string, runId: string): Promise<C.Experiment> {
  const eid = parseId(experimentId, "experiment ID"); const rid = parseId(runId, "run ID");
  return deps.repo.transaction(tx => {
    const experiment = tx.get("experiments", eid);
    if (!experiment) throw new AppError("NOT_FOUND", "Experiment not found");
    const run = tx.get("runs", rid);
    if (!run || run.projectId !== experiment.projectId) throw new AppError("NOT_FOUND", "Run not found");
    if (experiment.runIds.includes(run.id)) return experiment;
    const sceneId = run.snapshot.sceneId; const seed = run.compiled.parameters.seed;
    if (!(routes as readonly string[]).includes(run.compiled.adapterId)) conflict("Only fal edit/text runs belong to the comparison; mock runs are demo practice only");
    if (!experiment.sceneIds.includes(sceneId)) conflict("Run scene is not part of this experiment");
    if (run.snapshot.sceneRevision !== experiment.sceneRevisions[sceneId]) conflict("Scene changed after the experiment was planned; this run cannot be attached");
    if (run.snapshot.edit !== null || run.snapshot.parentCandidateId !== null) conflict("Edit runs are not experiment slots");
    if (run.compiled.parameters.num_images !== 1) conflict("Experiment slots require outputCount 1");
    if (seed === null || !Number.isInteger(seed) || seed < 0 || seed >= repeats) conflict("Experiment slots use seed 0, 1 or 2 (the repeat index)");
    const attached = experiment.runIds.map(id => tx.get("runs", id)).filter((r): r is C.Run => r !== null);
    if (attached.some(r => slotKey(r) === slotKey(run))) conflict("This slot already has a run");
    // Same task intent per scene across both routes; only the compiled request (references vs text) may differ.
    const sameScene = attached.find(r => r.snapshot.sceneId === sceneId);
    if (sameScene && intentOf(sameScene.snapshot) !== intentOf(run.snapshot)) conflict("Run input differs from the scene's first experiment run");
    const next = { ...experiment, revision: experiment.revision + 1, runIds: [...experiment.runIds, run.id] };
    tx.replace("experiments", next, experiment.revision);
    return next;
  });
}
