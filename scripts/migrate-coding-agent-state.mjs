import { join } from "node:path";

import { dashboardStorePath } from "../packages/storage/dashboard-store.mjs";
import {
  createCodingAgentStore,
  migrateCodingAgentJsonToStore
} from "../packages/storage/coding-agent-store.mjs";

const root = join(import.meta.dirname, "..");
const filePath = dashboardStorePath(root);
const store = createCodingAgentStore({
  filePath,
  env: {
    ...process.env,
    CODING_AGENT_STATE_STORE: process.env.CODING_AGENT_STATE_STORE ?? "postgres"
  }
});

try {
  const result = await migrateCodingAgentJsonToStore({ filePath, store });
  console.log(JSON.stringify(result));
} finally {
  await store.close?.();
}
