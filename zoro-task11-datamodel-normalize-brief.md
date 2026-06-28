# Task 11 — database dept reliability fix (R7)

The `database` department (in src/agents.ts ROLE map, around line 35) is the #2 hotspot after R3 fixed content. a94d539a autopsy showed:
- "app db provision failed: appdb: no tables in the data model / schema output" — model emitted JSON that didn't have `entities[]`
- "integer out of range" — model emitted a number too big for PG INT (probably a seed id)

Same pattern as R3: model emits JSON that doesn't match the documented schema, naive json verify fails. Fix: normalizeDataModel + tighten ROLE.

Tight scope. 4 files. ~40 lines. ONE commit.

## Step 1: Investigate

- Read src/agents.ts ROLE.database (around line 35) — schema for `{entities:[{name, fields[], seed[]}]}`
- Read src/spec.ts (extractFirstJson)
- Read src/runner.ts (where database task output flows)
- Query postgres for database failures:
  ```
  psql $DATABASE_URL -c "select detail from run_events where type in ('verify_failed','agent_error') and detail ilike '%database%' order by at desc limit 10;"
  psql $DATABASE_URL -c "select detail from run_events where type='verify_failed' and detail ilike '%integer%' order by at desc limit 5;"
  psql $DATABASE_URL -c "select detail from run_events where type='verify_failed' and detail ilike '%no tables%' order by at desc limit 5;"
  ```
- Identify the failure pattern (multiple JSON blocks? wrapper missing? integer too big?)

## Step 2: Fix in 4 files

### File 1: src/agents.ts (rewrite ROLE.database)
Current text (line 35):
```
'You are the Database department. DESIGN the app\'s data model and output ONLY a JSON object (no prose, no SQL, no fences): {"entities":[{"name":"products","public":true,"display":"name","fields":[{"name":"title","type":"text","required":true},{"name":"price","type":"money","required":true},{"name":"category","type":"ref:categories"},{"name":"in_stock","type":"bool","default":true},{"name":"description","type":"longtext"}],"seed":[{"title":"...","price":12.5,"category":1,"in_stock":true,"description":"..."}]}]}. ' + 'Field types: text, longtext, int, money, bool, date, datetime, email, url, slug, image, json. Relations: "type":"ref:<entity>". Rules: model the REAL entities for this brief (3-6 tables, proper relations); mark the main public-facing entity "public":true with "display" set to its title field and SEED it with 4-8 realistic rows; required/unique where it matters. The system COMPILES this into a correct, indexed Postgres schema (serial PKs, FK constraints + indexes, created_at) — you only describe the model. JSON only.'
```

Add explicit rules:
- Self-check: count { and } — must match. Output EXACTLY one JSON object.
- All integer values (seed PKs, counts) MUST fit in PostgreSQL INT4 (max 2,147,483,647). Use small realistic seed PKs (1-100 range).
- The "entities" key MUST be present and be a non-empty array.
- No trailing commas. No fences. No prose before/after.

### File 2: src/spec.ts — add normalizeDataModel(raw)
```ts
export type DataModelResult = { ok: true; model: any; repairs: string[] } | { ok: false; errors: string[] };
export function normalizeDataModel(raw: string): DataModelResult {
  const repairs: string[] = []; const errors: string[] = [];
  if (!raw) { errors.push('empty database output'); return { ok: false, errors }; }
  // first pass: extractFirstJson
  const first = extractFirstJson(raw);
  if (first !== undefined && first !== null && Array.isArray(first.entities)) {
    // also clamp seed PKs to int4-safe range
    return { ok: true, model: clampSeedPks(first), repairs };
  }
  // second pass: try to extract entities from concatenated blocks
  const blocks: any[] = [];
  const re = /\{[^{}]*\}/g;
  let m; while ((m = re.exec(raw)) !== null) { try { blocks.push(JSON.parse(m[0])); } catch {} }
  const withEntities = blocks.find(b => b && Array.isArray(b.entities));
  if (withEntities) {
    repairs.push('merged: extracted entities from concatenated blocks');
    return { ok: true, model: clampSeedPks(withEntities), repairs };
  }
  // third pass: maybe the model emitted `tables: [...]` instead of `entities: [...]`
  const withTables = blocks.find(b => b && Array.isArray(b.tables));
  if (withTables) {
    repairs.push('coerced: tables → entities');
    return { ok: true, model: clampSeedPks({ ...withTables, entities: withTables.tables }), repairs };
  }
  errors.push('database output has no entities[] or coercible tables[]');
  return { ok: false, errors };
}

function clampSeedPks(model: any): any {
  const INT4_MAX = 2_147_483_647;
  for (const e of model.entities || []) {
    for (const s of e.seed || []) {
      for (const k of Object.keys(s)) {
        if (typeof s[k] === 'number' && !Number.isInteger(s[k])) continue;
        if (typeof s[k] === 'number' && s[k] > INT4_MAX) {
          s[k] = Math.floor(s[k] % INT4_MAX);
          // record repair in callers via console
        }
      }
    }
  }
  return model;
}
```

### File 3: src/spec-test.ts — add 5 cases for normalizeDataModel
- valid single object with entities → passes
- 2 concatenated objects, one with entities → extracted
- object with `tables: [...]` instead of `entities: [...]` → coerced
- truncated JSON → rejected
- integer overflow in seed → clamped + repair log

### File 4: src/runner.ts — wire normalizeDataModel
In processTask where database dept output is validated, BEFORE normalizeSpec:
```ts
if (task.department === 'database') {
  const r = normalizeDataModel(content);
  if (!r.ok) throw new Error('database rejected: ' + r.errors.join('; '));
  for (const rep of r.repairs) console.error(`[datamodel] ${task.project_id}: ${rep}`);
  content = JSON.stringify(r.model);
}
```

## Acceptance

- [ ] npm test -- src/spec-test.ts passes (5 new cases)
- [ ] npx tsc --noEmit clean
- [ ] ONE commit: "R7: database dept reliability — role rewrite + normalizeDataModel"
- [ ] Co-authored-by: Claude Opus 4.8
- [ ] root-cause finding reported in summary (what exactly was breaking — number overflow? missing entities? wrapper?)

## Out of scope

- Do NOT touch other depts (content already fixed by R3)
- Do NOT modify the planner
- Do NOT change app_db verify rule
- Do NOT change runner.ts lease/reclaim logic
- Do NOT touch dogfood, evolver, or any non-database code
- Do NOT add new dependencies

## When done

Print 5-line summary:
1. commit hash + subject
2. npm test result
3. tsc --noEmit result
4. files changed (count)
5. root-cause finding from your investigation

Exit.
