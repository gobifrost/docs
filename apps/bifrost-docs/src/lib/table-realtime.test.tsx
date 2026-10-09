import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTableInvalidation, useTableInvalidations } from "./table-realtime";

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("bifrost", () => ({ tables: { subscribe: mocks.subscribe } }));

function Listener({ tableId, organizationId, onInvalidate, onAccessLost }: { tableId: string | null; organizationId: string | null; onInvalidate: () => void; onAccessLost?: () => void }) {
  useTableInvalidation(tableId, organizationId, onInvalidate, onAccessLost, 1);
  return null;
}

function MultiListener({ organizationId, onInvalidate, onAccessLost }: { organizationId: string | null; onInvalidate: () => void; onAccessLost?: () => void }) {
  useTableInvalidations(["table-a", "table-b"], organizationId, onInvalidate, onAccessLost, 1);
  return null;
}

afterEach(() => { mocks.subscribe.mockReset(); mocks.unsubscribe.mockReset(); });

describe("useTableInvalidation", () => {
  it.each([false, true])("ignores connection and heartbeat frames without starting a refresh loop (multiple=%s)", async (multiple) => {
    const events: Array<(event: { type: string }) => void> = [];
    mocks.subscribe.mockImplementation((_tableId, _filter, event) => { events.push(event); return mocks.unsubscribe; });
    const invalidate = vi.fn();
    const accessLost = vi.fn();
    render(multiple
      ? <MultiListener organizationId="org-a" onInvalidate={invalidate} onAccessLost={accessLost} />
      : <Listener tableId="table-uuid" organizationId="org-a" onInvalidate={invalidate} onAccessLost={accessLost} />);
    for (const event of events) for (const type of ["connected", "unsubscribed", "ping", "pong"]) event({ type });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(invalidate).not.toHaveBeenCalled();
    expect(accessLost).not.toHaveBeenCalled();
  });

  it.each([false, true])("closes the query-to-subscribe gap once per confirmed table subscription (multiple=%s)", async (multiple) => {
    const events: Array<(event: { type: string }) => void> = [];
    mocks.subscribe.mockImplementation((_tableId, _filter, event) => { events.push(event); return mocks.unsubscribe; });
    const invalidate = vi.fn();
    render(multiple ? <MultiListener organizationId="org-a" onInvalidate={invalidate} /> : <Listener tableId="table-uuid" organizationId="org-a" onInvalidate={invalidate} />);
    events[0]({ type: "subscribed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(invalidate).toHaveBeenCalledTimes(1);
    events[0]({ type: "subscribed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(invalidate).toHaveBeenCalledTimes(1);
    if (multiple) {
      events[1]({ type: "subscribed" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(invalidate).toHaveBeenCalledTimes(2);
    }
  });

  it("subscribes by the canonical table UUID and coalesces bursts plus reconnect", async () => {
    let onEvent!: (event: { type: string }) => void; let onReconnect!: () => void;
    mocks.subscribe.mockImplementation((tableId, filter, event, reconnect) => { onEvent = event; onReconnect = reconnect; return mocks.unsubscribe; });
    const invalidate = vi.fn();
    render(<Listener tableId="table-uuid" organizationId="org-a" onInvalidate={invalidate} />);

    expect(mocks.subscribe).toHaveBeenCalledWith("table-uuid", { eq: [{ row: "organization_id" }, "org-a"] }, expect.any(Function), expect.any(Function));
    onEvent({ type: "document_change" }); onEvent({ type: "table_invalidated" }); onReconnect();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("replaces the subscription when the organization changes even if the UUID does not", () => {
    mocks.subscribe.mockReturnValue(mocks.unsubscribe);
    const invalidate = vi.fn();
    const view = render(<Listener tableId="table-uuid" organizationId="org-a" onInvalidate={invalidate} />);
    view.rerender(<Listener tableId="table-uuid" organizationId="org-b" onInvalidate={invalidate} />);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe.mock.calls.map(([id, filter]) => [id, filter])).toEqual([
      ["table-uuid", { eq: [{ row: "organization_id" }, "org-a"] }],
      ["table-uuid", { eq: [{ row: "organization_id" }, "org-b"] }],
    ]);
  });

  it("cancels a queued event from the previous organization scope", async () => {
    const events: Array<(event: { type: string }) => void> = [];
    mocks.subscribe.mockImplementation((_tableId, _filter, event) => { events.push(event); return mocks.unsubscribe; });
    const invalidate = vi.fn();
    const view = render(<Listener tableId="table-uuid" organizationId="org-a" onInvalidate={invalidate} />);
    events[0]({ type: "document_change" });
    view.rerender(<Listener tableId="table-uuid" organizationId="org-b" onInvalidate={invalidate} />);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("ignores a revocation delivered by an already-unsubscribed organization listener", () => {
    const events: Array<(event: { type: string }) => void> = [];
    mocks.subscribe.mockImplementation((_tableId, _filter, event) => { events.push(event); return mocks.unsubscribe; });
    const invalidate = vi.fn();
    const accessLost = vi.fn();
    const view = render(<Listener tableId="table-uuid" organizationId="org-a" onInvalidate={invalidate} onAccessLost={accessLost} />);
    view.rerender(<Listener tableId="table-uuid" organizationId="org-b" onInvalidate={invalidate} onAccessLost={accessLost} />);

    events[0]({ type: "subscription_revoked" });
    expect(accessLost).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("also ignores a stale revocation from a multi-table listener", () => {
    const events: Array<(event: { type: string }) => void> = [];
    mocks.subscribe.mockImplementation((_tableId, _filter, event) => { events.push(event); return mocks.unsubscribe; });
    const invalidate = vi.fn();
    const accessLost = vi.fn();
    const view = render(<MultiListener organizationId="org-a" onInvalidate={invalidate} onAccessLost={accessLost} />);
    view.rerender(<MultiListener organizationId="org-b" onInvalidate={invalidate} onAccessLost={accessLost} />);

    events[0]({ type: "error" });
    expect(accessLost).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("clears stale rows immediately when the stream reports access loss, then refreshes", async () => {
    let onEvent!: (event: { type: string }) => void;
    mocks.subscribe.mockImplementation((_tableId, _filter, event) => { onEvent = event; return mocks.unsubscribe; });
    const invalidate = vi.fn();
    const accessLost = vi.fn();
    render(<Listener tableId="table-uuid" organizationId="org-a" onInvalidate={invalidate} onAccessLost={accessLost} />);

    onEvent({ type: "subscription_revoked" });
    expect(accessLost).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });
});
