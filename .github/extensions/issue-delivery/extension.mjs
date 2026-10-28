import { createCanvas, defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { meta, run } from "./workflow.mjs";
import { createStore, resolveArtifactRoot } from "./storage.mjs";
import { logError, startObserver } from "./observer.mjs";
import { createDashboardCanvas } from "./dashboard.mjs";

const store = createStore(await resolveArtifactRoot());
let session;
let observer;
const dashboard = createDashboardCanvas(createCanvas, store, {
  health: () => observer?.health() ?? { errors: [] },
  reportError: (error) => { void logError(session, `Issue delivery dashboard failed: ${error.message}`); },
});
let cleanupTask;
const cleanup = () => cleanupTask ??= Promise.all([observer?.close(), dashboard.close()]).then(() => {});
session = await joinSession({
  workflows: [defineWorkflow({ meta, run })],
  canvases: [dashboard.canvas],
  hooks: { onSessionEnd: cleanup },
});
observer = startObserver(session, store);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(0), async (error) => {
      await logError(session, `Issue delivery dashboard cleanup failed: ${error.message}`);
      process.exit(1);
    });
  });
}
