import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarCollapse } from "./useSidebarCollapse";

const key = "bifrost-docs-sidebar-collapsed";
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe("document workspace sidebar preference", () => {
  it("defaults to the icon rail in documents without overwriting the general preference", () => {
    const { result } = renderHook(() => useSidebarCollapse(true));
    expect(result.current.isCollapsed).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("keeps a manual expansion within documents, restores the general layout on exit, and collapses on reentry", () => {
    const { result, rerender } = renderHook(({ documents }) => useSidebarCollapse(documents), { initialProps: { documents: true } });
    act(() => result.current.toggle());
    expect(result.current.isCollapsed).toBe(false);
    rerender({ documents: true });
    expect(result.current.isCollapsed).toBe(false);
    rerender({ documents: false });
    expect(result.current.isCollapsed).toBe(false);
    rerender({ documents: true });
    expect(result.current.isCollapsed).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("preserves a saved collapsed preference when documents are manually expanded", () => {
    localStorage.setItem(key, "1");
    const { result, rerender } = renderHook(({ documents }) => useSidebarCollapse(documents), { initialProps: { documents: true } });
    act(() => result.current.toggle());
    expect(result.current.isCollapsed).toBe(false);
    expect(localStorage.getItem(key)).toBe("1");
    rerender({ documents: false });
    expect(result.current.isCollapsed).toBe(true);
  });

  it("still persists explicit toggles outside the document workspace", () => {
    const { result, rerender } = renderHook(({ documents }) => useSidebarCollapse(documents), { initialProps: { documents: false } });
    act(() => result.current.toggle());
    expect(result.current.isCollapsed).toBe(true);
    expect(localStorage.getItem(key)).toBe("1");
    rerender({ documents: true });
    act(() => result.current.toggle());
    rerender({ documents: false });
    expect(result.current.isCollapsed).toBe(true);
    act(() => result.current.toggle());
    expect(localStorage.getItem(key)).toBe("0");
  });

  it("keeps navigation usable when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    const { result } = renderHook(() => useSidebarCollapse(true));
    expect(result.current.isCollapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.isCollapsed).toBe(false);
  });
});
