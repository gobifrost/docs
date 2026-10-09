import { useEffect, useRef } from "react";
import { tables } from "bifrost";

type TableEvent = { type: string };

function organizationFilter(organizationId: string | null | undefined) {
  return organizationId ? { eq: [{ row: "organization_id" }, organizationId] } : null;
}

/**
 * Refresh a query from its authoritative server snapshot after a table event.
 * The SDK requires the table UUID returned by query/get, never a table alias.
 * A null organization scope is reserved for an authorized global view.
 */
export function useTableInvalidation(
  canonicalTableId: string | null | undefined,
  organizationId: string | null | undefined,
  onInvalidate: () => void,
  onAccessLost?: () => void,
  debounceMs = 250,
) {
  const callback = useRef(onInvalidate);
  const accessLost = useRef(onAccessLost);
  callback.current = onInvalidate;
  accessLost.current = onAccessLost;

  useEffect(() => {
    if (!canonicalTableId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let subscribed = false;
    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) callback.current();
      }, debounceMs);
    };
    const onEvent = (event: TableEvent) => {
      if (disposed) return;
      if (event.type === "subscribed") {
        // Close the initial query → subscription gap once the server confirms
        // this listener. Reconnects use the SDK's separate callback below.
        if (!subscribed) { subscribed = true; schedule(); }
        return;
      }
      if (event.type === "error" || event.type === "subscription_revoked") {
        if (timer) clearTimeout(timer);
        timer = null;
        accessLost.current?.();
        callback.current();
        return;
      }
      if (event.type === "document_change" || event.type === "table_invalidated") schedule();
    };
    const unsubscribe = tables.subscribe(canonicalTableId, organizationFilter(organizationId), onEvent, schedule);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [canonicalTableId, organizationId, debounceMs]);
}

/** Subscribe to a changing set of canonical table UUIDs with one coalesced refresh. */
export function useTableInvalidations(
  tableIds: Array<string | null | undefined>,
  organizationId: string | null | undefined,
  onInvalidate: () => void,
  onAccessLost?: () => void,
  debounceMs = 250,
) {
  const callback = useRef(onInvalidate);
  const accessLost = useRef(onAccessLost);
  callback.current = onInvalidate;
  accessLost.current = onAccessLost;
  const stableIds = [...new Set(tableIds.filter((id): id is string => Boolean(id)))].sort().join("|");
  useEffect(() => {
    const ids = stableIds ? stableIds.split("|") : [];
    if (!ids.length) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const subscribed = new Set<string>();
    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) callback.current();
      }, debounceMs);
    };
    const onEvent = (event: TableEvent, tableId: string) => {
      if (disposed) return;
      if (event.type === "subscribed") {
        if (!subscribed.has(tableId)) { subscribed.add(tableId); schedule(); }
        return;
      }
      if (event.type === "error" || event.type === "subscription_revoked") {
        if (timer) clearTimeout(timer);
        timer = null;
        accessLost.current?.();
        callback.current();
        return;
      }
      if (event.type === "document_change" || event.type === "table_invalidated") schedule();
    };
    const filter = organizationFilter(organizationId);
    const unsubscribers = ids.map((id) => tables.subscribe(id, filter, (event: TableEvent) => onEvent(event, id), schedule));
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [stableIds, organizationId, debounceMs]);
}
