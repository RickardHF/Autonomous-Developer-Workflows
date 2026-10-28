import { isRunId, LIVE_STATUSES, observationFromDetail } from "./model.mjs";

export async function logError(session, message) {
  try { await session.log(message, { level: "error" }); }
  catch (error) { process.stderr.write(`${message}\nDashboard error logging also failed: ${error.message}\n`); }
}

export function startObserver(session, store, { intervalMs = 5_000, now = Date.now } = {}) {
  const pending = new Map();
  const known = new Map();
  const errors = new Map();
  let closed = false;
  let draining;
  let refreshing;
  let lastSuccessAt = null;
  const report = (key, error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (errors.get(key) !== message) {
      void logError(session, `Issue delivery dashboard observation failed (${key}): ${message}`);
    }
    errors.set(key, message);
  };
  const drain = () => {
    if (draining) return draining;
    draining = (async () => {
      while (!closed && pending.size) {
        const [runId] = pending.keys();
        pending.delete(runId);
        try {
          const detail = await session.workflow.getRunDetail(runId);
          if (closed || detail.workflowName !== "issue-delivery") continue;
          if (detail.runId !== runId) throw new Error("Runtime returned a different run identity.");
          const previous = known.get(runId);
          if (previous && previous.revision > detail.revision) continue;
          await store.writeObservation(observationFromDetail(detail, session.sessionId, now()));
          known.set(runId, { revision: detail.revision, status: detail.status });
          errors.delete(runId);
          lastSuccessAt = now();
        } catch (error) { report(runId, error); }
      }
    })().finally(() => { draining = undefined; });
    return draining;
  };
  const enqueue = (runId, revision, force = false) => {
    if (closed) return;
    if (!isRunId(runId)) { report("event", new Error("Runtime supplied an invalid run identifier.")); return; }
    const previous = known.get(runId);
    if (!force && previous && revision <= previous.revision) return;
    pending.set(runId, Math.max(pending.get(runId) ?? -1, revision ?? -1));
  };
  const unsubscribe = session.on("workflow.run_updated", (event) => {
    enqueue(event.data.runId, event.data.revision);
    void drain();
  });
  const refresh = () => {
    if (closed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        let beforeSeq;
        do {
          const page = await session.workflow.listRuns({ limit: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
          if (closed) return;
          for (const run of page.runs) {
            if (run.workflowName === "issue-delivery") enqueue(run.runId, run.revision, LIVE_STATUSES.has(run.status));
          }
          if (!page.omittedOlder) break;
          if (!Number.isFinite(page.oldestSeq) || beforeSeq !== undefined && page.oldestSeq >= beforeSeq) {
            throw new Error("Workflow history pagination did not advance.");
          }
          beforeSeq = page.oldestSeq;
        } while (!closed);
        errors.delete("discovery");
        lastSuccessAt = now();
      } catch (error) { report("discovery", error); }
      await drain();
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref?.();
  const ready = refresh();
  return {
    ready, refresh,
    health: () => ({ lastSuccessAt, errors: [...errors].map(([runId, message]) => ({ runId, message })) }),
    async close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
      await refreshing;
      await draining;
    },
  };
}
