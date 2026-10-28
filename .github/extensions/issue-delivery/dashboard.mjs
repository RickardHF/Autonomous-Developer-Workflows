import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReadError } from "./storage.mjs";

const assets = new Map([
  ["", ["dashboard.html", "text/html; charset=utf-8"]],
  ["dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["dashboard.css", ["dashboard.css", "text/css; charset=utf-8"]],
  ["renderer.mjs", ["renderer.mjs", "text/javascript; charset=utf-8"]],
  ["diff.mjs", ["diff.mjs", "text/javascript; charset=utf-8"]],
]);
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

export async function startDashboardServer(store, { health = () => ({ errors: [] }), reportError = () => {} } = {}) {
  const prefix = `/${randomBytes(24).toString("hex")}/`;
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", policy);
    const send = (status, data, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
    };
    try {
      if (req.headers.host !== new URL(origin).host ||
          req.headers.origin && req.headers.origin !== origin) throw new ReadError("Request origin is not allowed.", 403);
      if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw new ReadError("Dashboard is read-only.", 405); }
      const url = new URL(req.url, origin);
      if (!url.pathname.startsWith(prefix)) throw new ReadError("Dashboard capability not found.", 404);
      const route = url.pathname.slice(prefix.length);
      if (assets.has(route)) {
        const [name, type] = assets.get(route);
        send(200, await readFile(new URL(name, import.meta.url)), type);
      } else {
        if (req.headers["sec-fetch-site"] === "cross-site") throw new ReadError("Cross-site data requests are not allowed.", 403);
        const runId = url.searchParams.get("runId");
        if (route === "api/runs") send(200, { runs: await store.listRuns(), observer: health() });
        else if (route === "api/run") send(200, await store.getRun(runId));
        else if (route === "api/artifact") send(200, await store.readArtifact(runId, url.searchParams.get("name")));
        else throw new ReadError("Endpoint not found.", 404);
      }
    } catch (error) {
      const status = error instanceof ReadError ? error.status : error.code === "ENOENT" ? 404 : ["ELOOP", "EACCES"].includes(error.code) ? 403 : 500;
      if (status === 500) reportError(error);
      send(status, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", reportError);
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin + prefix,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

export function createDashboardCanvas(createCanvas, store, options) {
  const instances = new Map();
  const close = async (instanceId) => {
    const entry = instances.get(instanceId);
    instances.delete(instanceId);
    if (entry) await (await entry).close();
  };
  return {
    canvas: createCanvas({
      id: "issue-delivery-runs",
      displayName: "Issue delivery runs",
      description: "Read-only issue-delivery run progress and local artifact inspection across sessions for this checkout.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      actions: [{
        name: "list_runs",
        description: "Read the recorded issue-delivery runs for this checkout.",
        handler: () => store.listRuns(),
      }],
      open: async ({ instanceId }) => {
        if (!instances.has(instanceId)) {
          const entry = startDashboardServer(store, options).catch((error) => {
            instances.delete(instanceId);
            throw error;
          });
          instances.set(instanceId, entry);
        }
        return { title: "Issue delivery runs", url: (await instances.get(instanceId)).url };
      },
      onClose: ({ instanceId }) => close(instanceId),
    }),
    close: () => Promise.all([...instances.keys()].map(close)),
  };
}
