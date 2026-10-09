// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BfDataTable } from "./BfDataTable";

afterEach(cleanup);

describe("BfDataTable row navigation", () => {
  it("reserves a minimum width for every data column when dynamic field hints exceed the table width", () => {
    render(<BfDataTable
      rows={[{ id: "asset-1", name: "Core switch", type: "Network", rack: "A-01", serial: "ABC-123", owner: "Infrastructure", updated: "Today" }]}
      columns={[
        { id: "name", header: "Name", accessor: "name" },
        { id: "type", header: "Type", accessor: "type", width: "20%" },
        { id: "rack", header: "Rack", accessor: "rack", width: "18%" },
        { id: "serial", header: "Serial", accessor: "serial", width: "18%" },
        { id: "owner", header: "Owner", accessor: "owner", width: "18%" },
        { id: "updated", header: "Updated", accessor: "updated", width: "18%" },
      ]}
      getRowId={(row) => row.id}
      selection="multiple"
      ariaLabel="Flexible assets"
    />);

    const table = screen.getByRole("table", { name: "Flexible assets" });
    expect(table.classList.contains("bds-data-table__table")).toBe(true);
    expect(table.closest(".bds-data-table")?.getAttribute("style")).toContain("--bds-data-table-min-width: max(100%, 906px)");
  });

  it("exposes an accessible first-cell action without changing table row semantics", () => {
    const open = vi.fn();
    render(<BfDataTable
      rows={[{ id: "doc-1", name: "VPN runbook" }]}
      columns={[{ id: "name", header: "Document", accessor: "name" }]}
      getRowId={(row) => row.id}
      onRowActivate={open}
    />);

    const row = screen.getByRole("row", { name: /VPN runbook/ });
    expect(row.getAttribute("tabindex")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open VPN runbook" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("selects through the padded checkbox label without opening the record", () => {
    const open = vi.fn();
    const selected = vi.fn();
    render(<BfDataTable
      rows={[{ id: "doc-1", name: "VPN runbook" }]}
      columns={[{ id: "name", header: "Document", accessor: "name" }]}
      getRowId={(row) => row.id}
      selection="multiple"
      onSelectionChange={selected}
      onRowActivate={open}
    />);
    const checkbox = screen.getByRole("checkbox", { name: "Select row doc-1" });
    const target = checkbox.closest("label");
    expect(target).not.toBeNull();
    fireEvent.click(target!);
    expect(selected).toHaveBeenCalledWith(["doc-1"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("selects only eligible rows when selecting all visible rows", () => {
    const onSelectionChange = vi.fn();
    render(<BfDataTable
      rows={[{ id: "native", eligible: true }, { id: "source", eligible: false }]}
      columns={[{ id: "id", header: "Document", accessor: "id" }]}
      getRowId={(row) => row.id}
      selection="multiple"
      selectedRowIds={[]}
      onSelectionChange={onSelectionChange}
      isRowSelectable={(row) => row.eligible}
    />);

    expect((screen.getByRole("checkbox", { name: "Select row source" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all eligible visible rows" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["native"]);
  });
});
