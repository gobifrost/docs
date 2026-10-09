export type TableDocument = { id: string; data?: Record<string, unknown> };
export type TableQueryResult = { documents?: TableDocument[]; total?: unknown; table_id?: string };
export type TableQuery = (table: string, options: Record<string, unknown>) => Promise<TableQueryResult>;

export type PageQueryOptions = {
  pageSize?: number;
  isCurrent?: () => boolean;
  onTableResolved?: (tableId: string) => void;
};

export type TableCountTarget = {
  key: string;
  table: string;
  where?: Record<string, unknown>;
};
export type TableCountsSnapshot = { counts: Record<string, number>; tableIds: string[] };

function current(options: PageQueryOptions) {
  return options.isCurrent?.() ?? true;
}

/** Fetch every ordered page while guarding stale effects and repeated records. */
export async function queryAllPages(
  query: TableQuery,
  table: string,
  queryOptions: Record<string, unknown>,
  options: PageQueryOptions = {},
): Promise<TableDocument[] | null> {
  const pageSize = options.pageSize ?? 200;
  const rows: TableDocument[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (current(options)) {
    const result = await query(table, { ...queryOptions, limit: pageSize, offset });
    if (!current(options)) return null;
    if (typeof result.table_id === "string") options.onTableResolved?.(result.table_id);
    const page = Array.isArray(result.documents) ? result.documents : [];
    let added = 0;
    for (const row of page) {
      if (!row || typeof row.id !== "string" || !row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      added += 1;
    }
    if (page.length < pageSize) return rows;
    if (added === 0) throw new Error("The complete result set could not be loaded because a page repeated.");
    offset += page.length;
  }
  return null;
}

/** Keep count fan-out bounded even for a provider's complete asset-type directory. */
const COUNT_QUERY_CONCURRENCY = 4;
export type TableCountOptions = Pick<PageQueryOptions, "isCurrent">;
type CountEntry = { key: string; total: number; tableId: string | null };

async function countEntries(
  query: TableQuery,
  targets: TableCountTarget[],
  sharedWhere: Record<string, unknown> | undefined,
  options: TableCountOptions,
): Promise<CountEntry[]> {
  const entries: Array<CountEntry | undefined> = new Array(targets.length);
  let nextIndex = 0;
  let stopped = false;
  const isCurrent = () => !stopped && current(options);
  await Promise.all(Array.from({ length: Math.min(COUNT_QUERY_CONCURRENCY, targets.length) }, async () => {
    try {
      while (isCurrent()) {
        const index = nextIndex++;
        const target = targets[index];
        if (!target) return;
        const mergedWhere = { ...(sharedWhere ?? {}), ...(target.where ?? {}) };
        const result = await query(target.table, { limit: 1, where: Object.keys(mergedWhere).length ? mergedWhere : undefined });
        if (!isCurrent()) return;
        const total = Number(result.total);
        if (!Number.isFinite(total) || total < 0) throw new Error(`The ${target.key} count is unavailable.`);
        entries[index] = { key: target.key, total, tableId: typeof result.table_id === "string" ? result.table_id : null };
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  }));
  return entries.flatMap(entry => entry ? [entry] : []);
}

/** Exact totals; failures stay visible instead of becoming invented zeroes. */
export async function loadTableCounts(
  query: TableQuery,
  targets: TableCountTarget[],
  sharedWhere?: Record<string, unknown>,
  options: TableCountOptions = {},
): Promise<Record<string, number>> {
  const entries = await countEntries(query, targets, sharedWhere, options);
  return Object.fromEntries(entries.map(({ key, total }) => [key, total]));
}

export async function loadTableCountsSnapshot(
  query: TableQuery,
  targets: TableCountTarget[],
  sharedWhere?: Record<string, unknown>,
  options: TableCountOptions = {},
): Promise<TableCountsSnapshot> {
  const entries = await countEntries(query, targets, sharedWhere, options);
  return { counts: Object.fromEntries(entries.map(({ key, total }) => [key, total])), tableIds: entries.flatMap(({ tableId }) => tableId ? [tableId] : []) };
}
