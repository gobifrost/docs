export type ConfigurationTaxonomyKind = "type" | "status";

export type TaxonomyRow = {
  id: string;
  name?: unknown;
  active?: unknown;
};

export function taxonomyTable(kind: ConfigurationTaxonomyKind) {
  return kind === "type" ? "docs-configuration-types" : "docs-configuration-statuses";
}

export function activeTaxonomyOptions(rows: TaxonomyRow[], currentValue = "") {
  const current = currentValue.trim();
  const options = rows
    .filter((row) => typeof row.name === "string" && row.name.trim())
    .filter((row) => row.active !== false || String(row.name).trim() === current)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)))
    .map((row) => ({
      value: String(row.name).trim(),
      label: String(row.name).trim(),
      ...(row.active === false ? { description: "Inactive" } : {}),
    }));
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current, description: "Not in current taxonomy" });
  }
  return options;
}
