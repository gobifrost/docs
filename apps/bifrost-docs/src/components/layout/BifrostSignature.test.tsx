import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BifrostSignature } from "./BifrostSignature";

describe("BifrostSignature", () => {
  it("renders the canonical bundled Bifrost mark as an inline asset", () => {
    render(<BifrostSignature product="Docs" />);

    expect(screen.getByRole("img", { name: "Bifrost" })).toHaveAttribute("src", expect.stringContaining("data:image/svg+xml"));
  });
});
