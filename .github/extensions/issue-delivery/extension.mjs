import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { meta, run } from "./workflow.mjs";

await joinSession({ workflows: [defineWorkflow({ meta, run })] });
