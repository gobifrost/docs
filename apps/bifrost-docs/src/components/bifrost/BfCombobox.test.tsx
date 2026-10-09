import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BfCombobox, BfMultiSelect } from "./BfCombobox";

afterEach(cleanup);

describe("asynchronous selection readiness", () => {
  it("announces loading options until a single selection is usable", () => {
    const props = { label: "Destination folder", options: [{ value: "folder-1", label: "Destination" }], onValueChange: vi.fn() };
    const view = render(<BfCombobox {...props} loading />);
    expect(screen.getByRole("combobox", { name: props.label })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: props.label })).toBeDisabled();
    view.rerender(<BfCombobox {...props} loading={false} />);
    expect(screen.getByRole("combobox", { name: props.label })).not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: props.label })).not.toBeDisabled();
  });

  it("announces loading options until multiple selections are usable", () => {
    const props = { label: "Organizations", options: [{ value: "org-1", label: "Northern Star" }], value: [], onValueChange: vi.fn() };
    const view = render(<BfMultiSelect {...props} loading />);
    expect(screen.getByRole("combobox", { name: props.label })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: props.label })).toHaveAttribute("aria-disabled", "true");
    view.rerender(<BfMultiSelect {...props} loading={false} />);
    expect(screen.getByRole("combobox", { name: props.label })).not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: props.label })).toHaveAttribute("aria-disabled", "false");
  });
});

describe("BfCombobox modal positioning", () => {
  it("keeps an opened listbox in its native dialog top layer", () => {
    render(
      <dialog open>
        <BfCombobox
          label="Destination folder"
          options={[{ value: "folder-1", label: "Destination" }]}
          onValueChange={vi.fn()}
        />
      </dialog>,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Destination folder" }));

    expect(screen.getByRole("option", { name: "Destination" }).closest("dialog")).toBe(screen.getByRole("dialog"));
  });
});
