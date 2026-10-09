import { describe, expect, it, vi } from "vitest";
import { loadTableCounts, loadTableCountsSnapshot, queryAllPages } from "./table-query";

describe("table query helpers", () => {
  it("loads every stable page once and ignores duplicate IDs", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ documents: [{ id: "a" }, { id: "b" }] })
      .mockResolvedValueOnce({ documents: [{ id: "b" }, { id: "c" }] })
      .mockResolvedValueOnce({ documents: [] });

    const rows = await queryAllPages(query, "docs-flexible-asset-types", {
      where: { organization_id: "org-1" },
      order_by: "name",
      order_dir: "asc",
    }, { pageSize: 2 });

    expect(rows?.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(query).toHaveBeenNthCalledWith(2, "docs-flexible-asset-types", expect.objectContaining({ offset: 2, limit: 2 }));
  });

  it("stops safely when its caller is no longer current", async () => {
    let active = true;
    const query = vi.fn(async () => {
      active = false;
      return { documents: [{ id: "a" }] };
    });
    const rows = await queryAllPages(query, "docs-flexible-asset-types", {}, {
      pageSize: 2,
      isCurrent: () => active,
    });

    expect(rows).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reports a canonical table UUID only while its request remains current", async () => {
    let resolved = "";
    const rows = await queryAllPages(
      vi.fn().mockResolvedValue({ table_id: "canonical-uuid", documents: [] }),
      "docs-flexible-asset-types",
      {},
      { onTableResolved: (tableId) => { resolved = tableId; } },
    );
    expect(rows).toEqual([]);
    expect(resolved).toBe("canonical-uuid");
  });

  it("does not turn failed or malformed totals into zero", async () => {
    await expect(loadTableCounts(
      vi.fn().mockResolvedValue({ documents: [], total: undefined }),
      [{ key: "documents", table: "docs-documents" }],
    )).rejects.toThrow("unavailable");
  });
});


describe("count-query backpressure", () => {
  it.each([loadTableCounts, loadTableCountsSnapshot])("bounds requests while retaining exact totals and organization filters", async (load) => {
    const targets = Array.from({ length: 180 }, (_, index) => ({ key: `type-${index}`, table: "docs-flexible-assets", where: { flexible_asset_type_id: `type-${index}` } }));
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const query = vi.fn((_table: string, options: Record<string, unknown>) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<{ total: number; table_id: string }>(resolve => gates.push(() => {
        active -= 1;
        const where = options.where as Record<string, string>;
        resolve({ total: Number(where.flexible_asset_type_id.slice(5)), table_id: "canonical-assets" });
      }));
    });
    let completed = false;
    const work = load(query, targets, { organization_id: "org-1" }).finally(() => { completed = true; });
    while (!completed) {
      gates.splice(0).forEach(release => release());
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const result = await work;
    const counts = "counts" in result ? result.counts : result;
    expect(peak).toBeLessThanOrEqual(4);
    expect(query).toHaveBeenCalledTimes(180);
    expect(counts).toEqual(Object.fromEntries(targets.map((target, index) => [target.key, index])));
    for (const [_table, options] of query.mock.calls) expect(options.where).toMatchObject({ organization_id: "org-1" });
  });

  it("stops queued requests when a scope changes", async () => {
    let active = true;
    const query = vi.fn(async () => { active = false; return { total: 1 }; });
    await loadTableCountsSnapshot(query, Array.from({ length: 20 }, (_, index) => ({ key: String(index), table: "docs-flexible-assets" })), undefined, { isCurrent: () => active });
    expect(query.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
