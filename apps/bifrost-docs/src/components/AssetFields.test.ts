import { describe, expect, it } from "vitest";
import {
  assetFieldDefaults,
  displayAssetValue,
  safeAssetFields,
  safeAssetTraits,
  validateAssetTraits,
} from "./AssetFields";

const fields = [
  { key: "host", name: "Hostname", type: "text", required: true, show_in_list: true },
  { key: "enabled", name: "Enabled", type: "checkbox", default_value: "true", show_in_list: true },
  { key: "tier", name: "Tier", type: "select", options: ["Production", "Development"], default_value: "Development", show_in_list: true },
  { key: "credential", name: "Credential", type: "password", required: true, show_in_list: true },
  { key: "section", name: "Connection", type: "header" },
  { key: "portal", name: "Portal", kind: "URL", required: true },
  { key: "labels", name: "Labels", kind: "Tag" },
  { key: "manual", name: "Manual", kind: "Upload" },
];

describe("flexible asset field helpers", () => {
  it("keeps safe IT Glue definitions and supplies type-aware defaults", () => {
    expect(safeAssetFields(fields).map((field) => field.key)).toEqual(["host", "enabled", "tier", "section", "portal", "labels", "manual"]);
    expect(assetFieldDefaults(fields, { host: "edge-1" })).toEqual({
      host: "edge-1",
      enabled: true,
      tier: "Development",
      portal: "",
      labels: "",
    });
  });

  it("rejects missing required values and unsupported select values", () => {
    expect(validateAssetTraits(safeAssetFields(fields), { host: "", enabled: false, tier: "Sandbox" })).toEqual({
      host: "Hostname is required.",
      tier: "Tier must be one of the configured options.",
      portal: "Portal is required.",
    });
  });

  it("displays source tag references by record name without object coercion", () => {
    expect(displayAssetValue({ type: "tag" }, { type: "Configurations", values: [{ id: 12, name: "Domain controller", "resource-url": "https://example.invalid/12" }, { id: 13, name: "Backup server" }] })).toBe("Domain controller, Backup server");
    expect(displayAssetValue({ type: "tag" }, ["network", { id: 12, name: "Domain controller" }, null])).toBe("network, Domain controller");
    expect(displayAssetValue({ type: "tag" }, { type: "Configurations", values: [{ id: 12 }] })).toBe("—");
  });

  it("does not write protected traits and formats list values", () => {
    const normalized = safeAssetFields(fields);
    const existing = assetFieldDefaults(fields, {
      host: "edge-1", enabled: false, tier: "Production", credential: "secret",
      labels: ["network", "critical"], manual: "file-42", unmodeled_safe_value: "keep me",
    });
    expect(existing).toEqual({
      host: "edge-1",
      enabled: false,
      tier: "Production",
      labels: ["network", "critical"],
      manual: "file-42",
      unmodeled_safe_value: "keep me",
      portal: "",
    });
    expect(safeAssetTraits(normalized, { ...existing, portal: "", labels: "network, critical" }, fields)).toEqual({
      host: "edge-1",
      enabled: false,
      tier: "Production",
      labels: "network, critical",
      manual: "file-42",
      unmodeled_safe_value: "keep me",
    });
    expect(displayAssetValue({ type: "checkbox" }, false)).toBe("No");
  });
});
