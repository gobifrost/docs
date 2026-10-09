import { describe, expect, it } from "vitest";
import { organizationTargetMode } from "./organization-target";

describe("organization creation target", () => {
  it("locks customer authoring to the host-provided organization scope", () => {
    expect(organizationTargetMode("customer-org")).toEqual({ kind: "fixed", organizationId: "customer-org" });
  });

  it("requires a Bifrost organization selection for global scope", () => {
    expect(organizationTargetMode(null)).toEqual({ kind: "picker" });
  });
});
