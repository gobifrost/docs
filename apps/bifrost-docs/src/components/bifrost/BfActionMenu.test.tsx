import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { BfActionMenu } from "./BfActionMenu";

afterEach(cleanup);

it("keeps a nested action menu keyboard accessible inside the modal focus boundary", async () => {
  const select = vi.fn();
  function Example() {
    const [open, setOpen] = useState(true);
    return <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined}><DialogTitle>Folder navigation</DialogTitle><BfActionMenu label="Actions for Runbooks" items={[{ value: "rename", label: "Rename folder" }]} onSelect={select} /></DialogContent></Dialog>;
  }
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "Actions for Runbooks" });
  fireEvent.click(trigger);
  const rename = screen.getByRole("menuitem", { name: "Rename folder" });
  await waitFor(() => expect(rename).toHaveFocus());
  fireEvent.keyDown(rename, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename folder" }));
  expect(select).toHaveBeenCalledWith("rename");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
