# Plan: full-text search for indexed pages

## Why

The agent currently discovers pages via `list_pages` (max 200 entries per call,
sorted by source/updatedAt) and reads them via `get_page`. There is no search —
just paginated browsing. Past ~500 products, the model can't reliably find a
specific page by content, which caps realistic deployments at roughly 1–2k
pages. We need a search tool so larger stores (target: 75k pages) become viable.

## Approach

Postgres native FTS (`tsvector` + GIN) on `IndexedPage`. No new infrastructure,
no extensions — Postgres 15 ships this. Defer pgvector / semantic search until
FTS misses prove it's needed; doing so would require an RDS upgrade off
`db.t3.micro` (see `chatbuster-cdk/lib/constructs/database-construct.js`).

Dev runs SQLite (`prisma/schema.prisma`), prod runs Postgres
(`prisma/schema.postgresql.prisma`). The new tool is gated on
`DATABASE_URL.startsWith("postgres")` so dev behavior is unchanged — the agent
just doesn't see `search_pages` locally and falls back to `list_pages`.

## Changes

### 1. Migration SQL

Apply manually against RDS — `prisma/migrations/` is SQLite-flavored
(`migration_lock.toml` pins `provider = "sqlite"`), so this can't go in
there until the Postgres migration story is set up properly. Suggested home:
`scripts/postgres/001_add_page_search.sql`.

```sql
-- Adds Postgres full-text search to IndexedPage.
--
-- Apply against the prod RDS instance (chatbuster db):
--   psql "$DATABASE_URL" -f scripts/postgres/001_add_page_search.sql
--
-- Idempotent — safe to re-run. For online deploys against a large table,
-- swap CREATE INDEX for CREATE INDEX CONCURRENTLY and run it outside the
-- transaction.

BEGIN;

-- search_vector is a STORED generated column: Postgres recomputes it on
-- every INSERT/UPDATE and writes the tsvector to disk, so reads never
-- re-tokenize. title is weighted A (highest) and body B, so title matches
-- outrank body matches at equal frequency.
ALTER TABLE "IndexedPage"
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body,  '')), 'B')
  ) STORED;

-- Partial GIN index — only rows the search tool can actually return.
-- Keeps the index ~30% smaller and avoids index churn on transient
-- scrape-retry rows.
CREATE INDEX IF NOT EXISTS "IndexedPage_search_vector_idx"
  ON "IndexedPage" USING GIN (search_vector)
  WHERE status = 'indexed';

COMMIT;
```

### 2. Prisma schema update

`prisma/schema.postgresql.prisma`, inside `model IndexedPage`. Declared as
`Unsupported` so Prisma knows the column exists but never reads/writes it
(the column is managed entirely by Postgres). The partial GIN index is **not**
declared here — Prisma's `@@index` doesn't support `WHERE` clauses, so it
stays in the raw SQL above.

```prisma
model IndexedPage {
  id           String                    @id @default(cuid())
  storeId      String
  url          String
  title        String?
  body         String?
  source       String
  externalId   String?
  status       String
  indexedAt    DateTime?
  lastError    String?
  createdAt    DateTime                  @default(now())
  updatedAt    DateTime                  @updatedAt
  // Managed by Postgres (GENERATED ALWAYS AS … STORED). Used by
  // search_pages via raw SQL; never read or written from Prisma.
  searchVector Unsupported("tsvector")?  @map("search_vector")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, source, externalId])
  @@index([storeId, status])
}
```

No change to `prisma/schema.prisma` (SQLite — no FTS5 work in this pass).

### 3. New tool: `search_pages`

Edit `src/agent/tools.ts`.

**Add to the existing import block:**

```ts
import { Prisma } from "@prisma/client";
```

**Add near the top-level constants (above `SOURCE_FILTER_MAP`):**

```ts
const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_HEADLINE_OPTS =
  'MaxFragments=2, MaxWords=18, MinWords=5, FragmentDelimiter=" … "';
```

**Add the handler after `getPage` (before `TOOL_DEFINITIONS`):**

```ts
interface SearchPagesInput {
  query: string;
  source_filter?: "product" | "page" | "post" | "category" | "any";
  limit?: number;
}

interface SearchHit {
  url: string;
  title: string | null;
  source: string;
  snippet: string;
}

async function searchPages(
  input: SearchPagesInput,
  ctx: ToolContext
): Promise<unknown> {
  const query = (input.query ?? "").trim();
  if (!query) return { error: "missing_query" };

  const requested =
    typeof input.limit === "number" ? input.limit : SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(requested)));

  const sources =
    input.source_filter && input.source_filter !== "any"
      ? SOURCE_FILTER_MAP[input.source_filter]
      : null;

  const sourceClause = sources
    ? Prisma.sql`AND source IN (${Prisma.join(sources)})`
    : Prisma.empty;

  // websearch_to_tsquery is the right parser for user input — it handles
  // quoted phrases and OR without throwing on punctuation. ts_headline
  // re-tokenizes the body for the snippet (not index-backed), so cost
  // scales with body length × limit — fine at 20 × ~10KB.
  const hits = await prisma.$queryRaw<SearchHit[]>(Prisma.sql`
    SELECT url, title, source,
           ts_headline(
             'english',
             coalesce(body, ''),
             q,
             ${SEARCH_HEADLINE_OPTS}
           ) AS snippet
    FROM "IndexedPage", websearch_to_tsquery('english', ${query}) AS q
    WHERE "storeId" = ${ctx.storeId}
      AND status = 'indexed'
      AND search_vector @@ q
      ${sourceClause}
    ORDER BY ts_rank(search_vector, q) DESC
    LIMIT ${limit}
  `);

  return { hits, count: hits.length, query };
}
```

**Append to `TOOL_DEFINITIONS` (spread at the end of the array literal):**

```ts
  ...(isPostgres
    ? [
        {
          name: "search_pages",
          description:
            "Search the merchant's indexed content by keyword(s) and return the best-matching pages with a highlighted snippet from each. Use this when the customer asks about a product, topic, or policy by name or description — e.g. 'do you sell waterproof boots', 'what is your return policy', 'anything for sensitive skin'. Prefer this over list_pages when you have specific words to search for; use list_pages for open-ended browsing. Returns up to 20 hits ranked by relevance.",
          input_schema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search terms. Use the customer's own words plus relevant synonyms. Supports quoted phrases (e.g. '\"return policy\"') and OR (e.g. 'wool OR cashmere').",
              },
              source_filter: {
                type: "string",
                enum: ["product", "page", "post", "category", "any"],
                description:
                  "Restrict results to one content type. Defaults to 'any'.",
              },
              limit: {
                type: "integer",
                description: "Max hits to return (1-50). Defaults to 20.",
                minimum: 1,
                maximum: 50,
              },
            },
            required: ["query"],
          },
        } satisfies Anthropic.Messages.Tool,
      ]
    : []),
```

**Update `HANDLERS` to conditionally include `search_pages`:**

```ts
const HANDLERS: Record<string, ToolHandler> = {
  list_pages: (input, ctx) => listPages(input as unknown as ListPagesInput, ctx),
  get_page: (input, ctx) => getPage(input as unknown as GetPageInput, ctx),
  get_orders: (input, ctx) => getOrders(input as unknown as GetOrdersInput, ctx),
  get_shopify_orders: (input, ctx) =>
    getShopifyOrders(input as unknown as GetShopifyOrdersInput, ctx),
  ...(isPostgres
    ? {
        search_pages: (input, ctx) =>
          searchPages(input as unknown as SearchPagesInput, ctx),
      }
    : {}),
};
```

## Rollout order

1. Apply `001_add_page_search.sql` against RDS — backfills `search_vector` for
   all existing rows synchronously (locks the table briefly; fine at current
   row counts, swap to `CONCURRENTLY` once stores get large).
2. Update `schema.postgresql.prisma`, run `npm run db:generate:prod`, redeploy.
3. Smoke test in prod: hit a store with a known product, confirm the agent
   calls `search_pages` and gets sensible hits.

## Verification

- `EXPLAIN ANALYZE` a representative query on RDS — should show a Bitmap Index
  Scan on `IndexedPage_search_vector_idx`, not a Seq Scan.
- Confirm latency under load: target <100ms p95 for `search_pages` with
  `limit=20` against a store with ~10k pages.
- Spot-check `ts_headline` snippets — they should contain the matched terms
  with `…` separators, not full paragraphs.

## Not in scope (deliberate)

- **SQLite FTS5 parity in dev.** The tool simply isn't registered when
  `DATABASE_URL` isn't Postgres. If we want dev agent testing to exercise
  search, add an FTS5 virtual table + a LIKE-fallback handler later.
- **System prompt changes.** The tool description guides the model; if we
  see it over-using `list_pages` when search would be better, add a nudge
  to `chatbot_system_prompt.md` then.
- **pgvector / semantic search.** Revisit only if FTS misses pile up (signal:
  corrections logging "search returned nothing" patterns). Requires RDS
  upgrade from `t3.micro` and an embedding pipeline on scrape.
- **Multi-language.** Hardcoded `'english'` config. Fine for the current
  customer base; revisit per-store if we onboard non-English stores.

## Open questions

- How is the Postgres migration history actually managed today? The
  `db:migrate:prod` script in `package.json` points at the SQLite migrations
  folder, which can't be replayed on Postgres. Worth resolving before the
  next schema change either way.
- Do we want to expose `search_pages` results in the audit portal so we can
  see which queries the agent runs and what it picks? Useful for tuning the
  tool descriptions.
