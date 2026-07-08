import postgres from "postgres";

import {
  listAppItems as listJsonAppItems,
  patchAppItemPayload as patchJsonAppItemPayload,
  upsertAppItem as upsertJsonAppItem
} from "./dashboard-store.mjs";

const CODING_AGENT_APP_ID = "coding-agent";

function sqlNullable(value) {
  return value === undefined ? null : value;
}

export function codingAgentStateStoreMode(env = process.env) {
  const configured = String(env.CODING_AGENT_STATE_STORE ?? "")
    .trim()
    .toLowerCase();
  if (configured === "postgres" || configured === "json") {
    return configured;
  }
  return env.DATABASE_URL && !env.DASHBOARD_DATA_FILE ? "postgres" : "json";
}

export function createCodingAgentSql(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for CODING_AGENT_STATE_STORE=postgres");
  }
  return postgres(env.DATABASE_URL, {
    max: Number.parseInt(env.CODING_AGENT_POSTGRES_POOL_SIZE ?? "5", 10),
    idle_timeout: 20,
    connect_timeout: 10
  });
}

function rowToItem(row) {
  return {
    id: row.id,
    app: row.app,
    type: row.type,
    externalId: row.external_id,
    status: row.status,
    title: row.title,
    detail: row.detail,
    payload: row.payload,
    ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts
  };
}

function runRowToItem(row) {
  const payload = row.payload ?? {};
  const lastEventAt =
    row.last_event_at instanceof Date ? row.last_event_at.toISOString() : row.last_event_at;
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  return {
    id: row.run_id,
    app: CODING_AGENT_APP_ID,
    type: "coding-run",
    externalId: row.run_id,
    status: row.status,
    title: payload.title ?? `Hermes run ${row.run_id}`,
    detail: row.task_id,
    payload: {
      ...payload,
      id: row.run_id,
      runId: row.run_id,
      taskId: row.task_id,
      status: row.status,
      lastEventAt
    },
    ts: lastEventAt ?? updatedAt
  };
}

export function createCodingAgentJsonStore(filePath) {
  return {
    mode: "json",
    async listItems({ type } = {}) {
      return listJsonAppItems(filePath, { app: CODING_AGENT_APP_ID, type });
    },
    async upsertItem(item) {
      return upsertJsonAppItem(filePath, item);
    },
    async patchItemPayload(selector, patcher) {
      return patchJsonAppItemPayload(filePath, { app: CODING_AGENT_APP_ID, ...selector }, patcher);
    },
    async appendRunEvent() {
      return undefined;
    },
    async close() {
      return undefined;
    }
  };
}

export function createCodingAgentPostgresStore(sql) {
  let schemaPromise;

  async function ensureSchema() {
    schemaPromise ??= (async () => {
      await sql`
        create table if not exists coding_agent_app_items (
          app text not null default 'coding-agent',
          type text not null,
          id text primary key,
          external_id text,
          status text,
          title text,
          detail text,
          payload jsonb not null,
          ts timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `;
      await sql`
        create unique index if not exists coding_agent_app_items_external_idx
        on coding_agent_app_items (app, type, external_id)
        where external_id is not null
      `;
      await sql`
        create table if not exists coding_agent_tasks (
          task_id text primary key,
          repo text,
          status text,
          title text,
          payload jsonb not null,
          updated_at timestamptz not null default now()
        )
      `;
      await sql`
        create table if not exists coding_agent_runs (
          run_id text primary key,
          task_id text,
          status text,
          payload jsonb not null,
          last_event_at timestamptz,
          updated_at timestamptz not null default now()
        )
      `;
      await sql`
        create table if not exists coding_agent_run_events (
          seq bigserial primary key,
          run_id text not null,
          task_id text,
          event_type text,
          event jsonb not null,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists coding_agent_run_events_run_idx
        on coding_agent_run_events (run_id, seq)
      `;
    })();
    return schemaPromise;
  }

  async function upsertItemInto(db, item) {
    const id = item.id ?? `${item.app}:${item.type}:${item.externalId ?? Date.now()}`;
    const app = item.app ?? CODING_AGENT_APP_ID;
    const payload = item.payload ?? {};
    const ts = item.ts ?? new Date().toISOString();
    await db`
      insert into coding_agent_app_items (
        app, type, id, external_id, status, title, detail, payload, ts, updated_at
      )
      values (
        ${app}, ${item.type}, ${id}, ${sqlNullable(item.externalId ?? item.external_id ?? id)},
        ${sqlNullable(item.status ?? payload.status)}, ${sqlNullable(item.title)}, ${sqlNullable(item.detail)},
        ${sql.json(payload)}, ${ts}, now()
      )
      on conflict (id) do update set
        app = excluded.app,
        type = excluded.type,
        external_id = excluded.external_id,
        status = excluded.status,
        title = excluded.title,
        detail = excluded.detail,
        payload = excluded.payload,
        ts = excluded.ts,
        updated_at = now()
    `;
    if (item.type === "coding-task") {
      await db`
        insert into coding_agent_tasks (task_id, repo, status, title, payload, updated_at)
        values (
          ${id}, ${sqlNullable(payload.repo)}, ${sqlNullable(payload.status)},
          ${sqlNullable(payload.title)}, ${sql.json(payload)}, now()
        )
        on conflict (task_id) do update set
          repo = excluded.repo,
          status = excluded.status,
          title = excluded.title,
          payload = excluded.payload,
          updated_at = now()
      `;
      const runId = payload.latestHermesRunId ?? payload.hermesRunId;
      if (runId) {
        await db`
          insert into coding_agent_runs (run_id, task_id, status, payload, last_event_at, updated_at)
          values (
            ${runId}, ${id}, ${sqlNullable(payload.hermesRunStatus)}, ${sql.json(payload)},
            ${sqlNullable(payload.hermesLastEventAt ?? payload.lastEventAt ?? null)}, now()
          )
          on conflict (run_id) do update set
            task_id = excluded.task_id,
            status = excluded.status,
            payload = excluded.payload,
            last_event_at = excluded.last_event_at,
            updated_at = now()
        `;
      }
    }
    return { ...item, id, app, externalId: item.externalId ?? item.external_id ?? id, ts };
  }

  async function upsertItem(item) {
    await ensureSchema();
    return upsertItemInto(sql, item);
  }

  return {
    mode: "postgres",
    ensureSchema,
    async listItems({ type } = {}) {
      await ensureSchema();
      if (type === "coding-run") {
        const rows = await sql`
          select run_id, task_id, status, payload, last_event_at, updated_at
          from coding_agent_runs
          order by updated_at desc
        `;
        return rows.map(runRowToItem);
      }
      const rows = type
        ? await sql`
            select app, type, id, external_id, status, title, detail, payload, ts
            from coding_agent_app_items
            where app = ${CODING_AGENT_APP_ID} and type = ${type}
            order by updated_at desc
          `
        : await sql`
            select app, type, id, external_id, status, title, detail, payload, ts
            from coding_agent_app_items
            where app = ${CODING_AGENT_APP_ID}
            order by updated_at desc
          `;
      return rows.map(rowToItem);
    },
    upsertItem,
    async patchItemPayload(selector, patcher) {
      await ensureSchema();
      return sql.begin(async (tx) => {
        const rows = await tx`
          select app, type, id, external_id, status, title, detail, payload, ts
          from coding_agent_app_items
          where app = ${CODING_AGENT_APP_ID}
            and (${selector.id ?? null}::text is null or id = ${selector.id ?? null})
            and (${selector.type ?? null}::text is null or type = ${selector.type ?? null})
          order by updated_at desc
          limit 1
          for update
        `;
        const existing = rows[0] ? rowToItem(rows[0]) : undefined;
        if (!existing) {
          return undefined;
        }
        const patch =
          typeof patcher === "function" ? patcher(existing.payload ?? {}, existing) : patcher;
        if (!patch) {
          return existing;
        }
        const next = {
          ...existing,
          payload: {
            ...(existing.payload ?? {}),
            ...patch
          },
          status: patch.status ?? existing.status,
          ts: existing.ts ?? new Date().toISOString()
        };
        await upsertItemInto(tx, next);
        return next;
      });
    },
    async appendRunEvent(runId, event, { taskId, eventType } = {}) {
      await ensureSchema();
      await sql`
        insert into coding_agent_run_events (run_id, task_id, event_type, event)
        values (${runId}, ${sqlNullable(taskId)}, ${sqlNullable(eventType)}, ${sql.json(event)})
      `;
    },
    async close() {
      await sql.end?.();
    }
  };
}

export function createCodingAgentStore({ filePath, env = process.env, sql } = {}) {
  const mode = codingAgentStateStoreMode(env);
  if (mode === "postgres") {
    return createCodingAgentPostgresStore(sql ?? createCodingAgentSql(env));
  }
  return createCodingAgentJsonStore(filePath);
}

export async function migrateCodingAgentJsonToStore({ filePath, store }) {
  const items = await listJsonAppItems(filePath, { app: CODING_AGENT_APP_ID });
  for (const item of items) {
    await store.upsertItem(item);
  }
  return { migrated: items.length, mode: store.mode };
}
