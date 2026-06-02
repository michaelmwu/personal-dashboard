import { openClawTask } from "../contracts/index.mjs";

export function openClawSnapshot() {
  return {
    status: "3 actions",
    tasks: [
      openClawTask({
        id: "oc_001",
        title: "Investigate duplicate Momoshop charge",
        state: "queued",
        priority: "high"
      }),
      openClawTask({
        id: "oc_002",
        title: "Generate June reward optimization summary",
        state: "ready",
        priority: "med"
      }),
      openClawTask({
        id: "oc_003",
        title: "Backfill merchant category aliases",
        state: "waiting",
        priority: "low"
      })
    ]
  };
}
