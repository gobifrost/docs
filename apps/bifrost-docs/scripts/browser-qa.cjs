#!/usr/bin/env node
/*
 * Deterministic browser regression harness for Bifrost Docs.
 *
 * Usage (the app must already be served):
 *   node scripts/browser-qa.cjs
 *   QA_BASE_URL=http://127.0.0.1:3417 QA_OUT_DIR=/tmp/docs-qa node scripts/browser-qa.cjs
 *   QA_PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/browser-qa.cjs
 *   QA_DIST_DIR=dist QA_STATIC_PORT=3418 node scripts/browser-qa.cjs
 *
 * The harness never sends a request to a live Bifrost API. Every /api request
 * is intercepted; table queries read the synthetic fixture below, and all
 * mutation-shaped requests are rejected. Browser output is deliberately kept
 * outside source control by default.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
function loadPlaywright() {
  const localModule = path.resolve(__dirname, "..", "node_modules", "playwright-core");
  const candidates = [
    process.env.QA_PLAYWRIGHT_MODULE,
    "playwright-core",
    localModule,
    "/tmp/bifrost-docs-qa/node_modules/playwright-core",
  ].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      // An explicit QA_PLAYWRIGHT_MODULE may be a package name or an absolute
      // module directory. The app-local package is preferred before the
      // disposable QA installation, keeping the harness portable.
      const resolved = path.isAbsolute(candidate)
        ? candidate
        : require.resolve(candidate, { paths: [path.resolve(__dirname, ".."), process.cwd()] });
      return require(resolved);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Playwright Core was not found. Set QA_PLAYWRIGHT_MODULE to its module path or install it for this app. Tried: ${errors.join(" | ")}`);
}

const { chromium } = loadPlaywright();

const distDir = process.env.QA_DIST_DIR ? path.resolve(process.env.QA_DIST_DIR) : null;
const staticPort = Number(process.env.QA_STATIC_PORT || 3418);
const baseUrl = distDir ? `http://127.0.0.1:${staticPort}` : (process.env.QA_BASE_URL || "http://127.0.0.1:3417");
const outDir = path.resolve(process.env.QA_OUT_DIR || "/tmp/docs-delivery-20261001/browser-pass2");
const timeout = Number(process.env.QA_TIMEOUT_MS || 12_000);
const failures = [];
const chromePath = process.env.QA_CHROME_PATH || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
const screenshotModes = [
  ["light", { width: 1440, height: 1000 }],
  ["dark", { width: 1440, height: 1000 }],
  ["light", { width: 768, height: 1024 }],
  ["dark", { width: 768, height: 1024 }],
  ["light", { width: 390, height: 844 }],
  ["dark", { width: 390, height: 844 }],
  ["light", { width: 320, height: 568 }],
  ["dark", { width: 320, height: 568 }],
];
const routeFilter = process.env.QA_ROUTES ? new Set(process.env.QA_ROUTES.split(",").map((value) => value.trim()).filter(Boolean)) : null;
const widthFilter = process.env.QA_WIDTHS ? new Set(process.env.QA_WIDTHS.split(",").map((value) => Number(value.trim())).filter(Boolean)) : null;

const organizations = [
  { id: "org-1", name: "Northern Star" },
  { id: "org-2", name: "Other" },
];

function row(id, data) {
  return { id, data, created_at: "2026-09-30T09:00:00Z", updated_at: "2026-10-01T10:00:00Z" };
}

const onboardingContent = "<h1>Onboarding</h1><p>Welcome to Northern Star.</p><h2>Before you begin</h2><p>Check the organization and review the service request before starting. Confirm the contact, location, equipment and intended access. Keep the request open while working so the next person can see what has been completed and what still needs attention.</p><h2>Prepare the device</h2><p>Record the device name and serial number, connect to the approved network, and install the required applications. Compare the installed versions with the service request. If a step fails, record the message and the action taken before moving to the next step.</p><h3>Check network access</h3><p>Confirm that the device can reach the services the user needs. Check the connection from the user's normal location and verify that the network profile matches the intended use. Record any exceptions alongside the device configuration.</p><h2>Verify the handoff</h2><p>Ask the user to open their normal applications and complete a representative task. Check that shared resources, email and printing behave as expected. Document the results and link the relevant configuration so the team can find the information during future support.</p><h2>Finish and record</h2><p>Review the checklist, update the service request, and confirm that the user knows where to request help. Keep setup notes current when equipment or access changes. The documentation should describe the working arrangement clearly enough for another technician to continue without repeating the investigation.</p><h2>Transferring the Flexible Single Master Operations roles to the replacement domain controller before removing the original controller</h2><p>Validate role ownership before retiring the original controller.</p>";
const documents = [
  row("doc-1", { organization_id: "org-1", name: "Northern Star onboarding", content: onboardingContent, rendered_content: onboardingContent, folder_id: "folder-1", source_system: "bifrost", source_id: "native-1", source_updated_at: "2026-10-01T10:00:00Z", status: "published", archived: false, restricted: false }),
  row("doc-2", { organization_id: "org-1", name: "Network guide", content: "<h2>Network</h2><p>Network reference.</p>", folder_id: "folder-2", source_system: "itglue", source_id: "itglue-2", source_updated_at: "2026-09-30T10:00:00Z", archived: false, restricted: false }),
  row("doc-wifi", { organization_id: "org-1", name: "Wi-Fi setup", content: "<h2>Wireless setup</h2><p>Configure and verify wireless access.</p>", folder_id: "folder-3", source_system: "bifrost", source_id: "native-wifi", status: "published", archived: false, restricted: false }),
  row("doc-other", { organization_id: "org-2", name: "Other handbook", content: "<p>Other organization only.</p>", source_system: "itglue", source_id: "itglue-other", archived: false, restricted: false }),
];
for (let i = 3; i <= 29; i += 1) documents.push(row(`doc-${i}`, { organization_id: "org-1", name: `Northern Star document ${String(i).padStart(2, "0")}`, content: `<p>Fixture ${i}</p>`, source_system: "itglue", source_id: `itglue-${i}`, archived: false, restricted: false }));

const fixture = {
  "docs-documents": documents,
  "docs-document-folders": [
    row("folder-1", { organization_id: "org-1", name: "Getting started", parent_id: "", source_system: "itglue" }),
    row("folder-2", { organization_id: "org-1", name: "Infrastructure", parent_id: "", source_system: "itglue" }),
    row("folder-archive", { organization_id: "org-1", name: "Archive", parent_id: "folder-2", source_system: "bifrost" }),
    row("folder-3", { organization_id: "org-1", name: "Networking", parent_id: "folder-2", source_system: "itglue" }),
  ],
  "docs-password-folders": [row("password-folder-1", { organization_id: "org-1", name: "Credentials", parent_id: "", source_system: "bifrost" })],
  "docs-passwords": [row("password-1", { organization_id: "org-1", name: "VPN metadata", username: "northern-star-admin", category_name: "Infrastructure", source_system: "itglue", source_url: "https://example.invalid/password-1" })],
  "docs-configurations": [row("config-1", { organization_id: "org-1", name: "Northern Star edge firewall", hostname: "fw-01", configuration_type_name: "Firewall", configuration_status_name: "Active", serial_number: "SERIAL-001", manufacturer_name: "Netgate", model_name: "6100", source_system: "itglue" })],
  "docs-locations": [row("location-1", { organization_id: "org-1", name: "Northern Star HQ", address_1: "1 Main Street", city: "New York", region: "NY", postal_code: "10001", country: "US", phone: "+1 555 0100", source_system: "itglue" })],
  "docs-flexible-asset-types": [row("asset-type-1", { organization_id: "org-1", name: "Network devices", fields: [{ name: "Servers", key: "servers", kind: "tag", show_in_list: true }, { name: "IP address", key: "ip_address", kind: "text", show_in_list: true }, ...["Manufacturer", "Model", "Support contact", "Management address", "Warranty expires"].map((name, index) => ({name, key: `field_${index}`, kind: "text", show_in_list: true}))], source_system: "itglue" })],
  "docs-flexible-assets": [row("asset-1", { organization_id: "org-1", name: "Northern Star router", flexible_asset_type_id: "asset-type-1", traits: { ip_address: "10.0.0.1", servers: { type: "Configurations", values: [{ id: 12, name: "Domain controller" }] } }, source_system: "itglue" })],
  "docs-audit-events": [
    row("audit-1", { organization_id: "org-1", occurred_at: "2026-10-01T10:00:00Z", event_type: "document.draft_updated", entity_type: "document", entity_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", summary: "document draft_updated", actor: "cccccccc-cccc-cccc-cccc-cccccccccccc" }),
    row("audit-2", { organization_id: "org-1", occurred_at: "2026-10-01T09:00:00Z", event_type: "configuration.operational_readiness_and_network_safety_review_completed", entity_type: "configuration", entity_id: "dddddddd-dddd-dddd-dddd-dddddddddddd", summary: "Reviewed the network configuration and its operational readiness before handing it over to the support team.", actor: "00000000-0000-0000-0000-000000000001" }),
  ],
  "docs-relationships": [row("relationship-1", { organization_id: "org-1", source_destination_id: "doc-1", source_type: "documents", target_type: "configurations", target_destination_id: "config-1", target_source_id: "104", relationship_type: "related" })],
  "docs-attachments": [row("attachment-1", { organization_id: "org-1", parent_id: "doc-1", parent_type: "documents", file_name: "Network equipment installation and onboarding reference screenshot.png", content_type: "image/png", size_bytes: 8192, file_path: "qa/document/screenshot.png", storage_location: "uploads" })],
  "docs-configuration-types": [row("config-type-1", { organization_id: "org-1", name: "Firewall", active: true })],
  "docs-configuration-statuses": [row("config-status-1", { organization_id: "org-1", name: "Active", active: true })],
};

for (let index = 2; index <= 7; index += 1) fixture["docs-flexible-asset-types"].push(row(`asset-type-${index}`, { organization_id: "org-1", name: `Network devices ${index}`, fields: [], source_system: "bifrost" }));

if (process.env.QA_DETAIL_ENABLED === "1") {
  fixture["docs-configurations"][0].data.is_enabled = false;
  fixture["docs-locations"][0].data.is_enabled = true;
  fixture["docs-flexible-assets"][0].data.is_enabled = false;
}

if (process.env.QA_DISABLED_LIST === "1") {
  for (const table of ["docs-configurations", "docs-locations", "docs-flexible-assets"]) {
    const base = fixture[table][0].data;
    for (const [state, enabled] of [["active", true], ["disabled", false], ["legacy", undefined]]) {
      fixture[table].push(row(`${table}-${state}`, {
        ...base, name: `Visibility ${state}`, source_system: "bifrost",
        ...(enabled === undefined ? {} : { is_enabled: enabled }),
      }));
    }
  }
}

if (process.env.QA_SUMMARY_COUNTS === "1") {
  const type = fixture["docs-flexible-asset-types"][0].data;
  type.source_id = "qa-summary-shared-type";
  fixture["docs-flexible-asset-types"].push(row("summary-type-copy", { ...type, organization_id: "org-2" }));
  for (const table of ["docs-passwords", "docs-documents", "docs-configurations", "docs-locations", "docs-flexible-assets"]) {
    const { is_enabled: ignored, ...base } = fixture[table][0].data;
    for (const [state, enabled, organization_id] of [["active", true, "org-1"], ["legacy", undefined, "org-1"], ["disabled", false, "org-1"], ["other", true, "org-2"]]) {
      fixture[table].push(row(`${table}-summary-${state}`, {
        ...base, name: `Summary ${state}`, organization_id, source_system: "bifrost",
        ...(table === "docs-flexible-assets" && organization_id === "org-2" ? { flexible_asset_type_id: "summary-type-copy" } : {}),
        ...(enabled === undefined ? {} : { is_enabled: enabled }),
      }));
    }
  }
}

if (process.env.QA_RICH_TABLES === "1") {
  const tables = '<table style="width:100%;table-layout:fixed"><caption>Service tasks</caption><colgroup><col style="width:25%"><col style="width:15%"><col style="width:60%"></colgroup><thead><tr><th scope="col">Board</th><th scope="col">Verb</th><th scope="col">Description</th></tr></thead><tbody><tr><td><span data-readability-word>Implementation</span> (PS)</td><td>Configure</td><td>For configuring a feature within an existing solution.</td></tr><tr><td>Support</td><td><span data-readability-word>Troubleshooting</span></td><td>For troubleshooting issues</td></tr></tbody></table><p>Content remains outside the table.</p><table style="width:1200px"><caption>Inventory</caption><thead><tr><th scope="col">Device</th><th scope="col">Management</th><th scope="col">Owner</th><th scope="col">Last column</th></tr></thead><tbody><tr><td rowspan="2">Gateway</td><td><a href="https://example.invalid/management">Management console</a></td><td>Network operations</td><td><span data-table-last>Retained last column</span></td></tr><tr><td colspan="3">Merged inventory details<table><tr><td>Nested metadata</td></tr></table></td></tr></tbody></table>';
  fixture["docs-documents"][0].data.content = onboardingContent + tables;
  fixture["docs-documents"][0].data.rendered_content = onboardingContent + tables;
  fixture["docs-configurations"][0].data.notes = tables;
}

if (process.env.QA_SUPPORTING_LIST_SCALE === "1") {
  fixture["docs-documents"].push(row("supporting-list-target", { organization_id: "org-1", name: "Last linked runbook", content: "<p>Scale fixture target.</p>", source_system: "bifrost", status: "published" }));
  for (const [parentType, parentId] of [["documents", "doc-1"], ["configurations", "config-1"], ["locations", "location-1"], ["flexible_assets", "asset-1"]]) {
    for (let index = 1; index <= 205; index += 1) {
      fixture["docs-attachments"].push(row(`scale-file-${parentType}-${index}`, { organization_id: "org-1", parent_id: parentId, parent_type: parentType, file_name: `Evidence ${index}.txt`, content_type: "text/plain", size_bytes: 20, file_kind: "attachment" }));
      fixture["docs-relationships"].push(row(`scale-related-${parentType}-${index}`, { organization_id: "org-1", source_destination_id: parentId, source_type: parentType, target_type: index === 205 ? "documents" : "unknown", target_destination_id: index === 205 ? "supporting-list-target" : "", relationship_type: "related" }));
    }
  }
}

function safeName(value) {
  return value.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
}

function contentType(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function distHostHtml(entryPath, stylePaths, theme) {
  const className = theme === "dark" ? " class=\"dark\"" : "";
  const styles = stylePaths.map((stylePath) => `<link rel="stylesheet" href="${stylePath}">`).join("");
  return `<!doctype html><html lang="en"${className}><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bifrost Docs QA</title>${styles}</head><body><div id="root"></div><script type="module">import ${JSON.stringify(entryPath)}; const module = [...(window.__BIFROST_APP_MODULES__ || new Map()).values()].at(-1); if (!module) throw new Error("Production Bifrost app module did not register"); module.mount(document.getElementById("root"), { basename: "/", baseUrl: window.location.origin, token: "synthetic-fixture-token", appId: "synthetic-app", solutionId: "synthetic-solution", orgScope: null, onLogout: () => {}, theme: document.documentElement.classList.contains("dark") ? "dark" : "light" });</script></body></html>`;
}

async function startDistServer() {
  if (!distDir) return null;
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) throw new Error(`QA_DIST_DIR has no index.html: ${distDir}`);
  const source = fs.readFileSync(indexPath, "utf8");
  const entryMatch = source.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
  if (!entryMatch) throw new Error(`QA_DIST_DIR index.html has no production module entry: ${indexPath}`);
  const entryPath = entryMatch[1];
  const stylePaths = [...source.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((match) => match[1]).filter((stylePath) => stylePath.startsWith("/"));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${staticPort}`);
    const pathname = decodeURIComponent(url.pathname);
    const candidate = path.resolve(distDir, `.${pathname}`);
    const isInDist = candidate === distDir || candidate.startsWith(`${distDir}${path.sep}`);
    if (isInDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      response.writeHead(200, { "Content-Type": contentType(candidate), "Cache-Control": "no-store" });
      fs.createReadStream(candidate).pipe(response);
      return;
    }
    if (pathname.startsWith("/assets/") || path.extname(pathname)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(distHostHtml(entryPath, stylePaths, url.searchParams.get("qaTheme")));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(staticPort, "127.0.0.1", () => {
      server.off("error", reject);
      server.unref();
      resolve();
    });
  });
  return server;
}

function pageUrl(routeName, appearance) {
  if (!distDir) return `${baseUrl}${routeName}`;
  const separator = routeName.includes("?") ? "&" : "?";
  return `${baseUrl}${routeName}${separator}qaTheme=${appearance}`;
}

function safeRequestUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value.split("?")[0];
  }
}

function attachPageDiagnostics(page, consoleErrors, networkEvents) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      const source = location.url ? `${safeRequestUrl(location.url)}:${location.lineNumber}:${location.columnNumber}` : "unknown source";
      consoleErrors.push(`${message.text()} (${source})`);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => networkEvents.push({
    type: "requestfailed",
    url: safeRequestUrl(request.url()),
    resourceType: request.resourceType(),
    failure: request.failure()?.errorText ?? "unknown request failure",
  }));
  page.on("response", (response) => {
    const request = response.request();
    if (request.isNavigationRequest() || request.resourceType() === "script" || response.status() >= 400) {
      networkEvents.push({ type: "response", url: safeRequestUrl(response.url()), resourceType: request.resourceType(), status: response.status() });
    }
  });
  page.on("crash", () => networkEvents.push({ type: "page-crash" }));
  page.on("close", () => networkEvents.push({ type: "page-close" }));
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function matchesWhere(data, where = {}) {
  return Object.entries(where || {}).every(([key, wanted]) => {
    const actual = data[key];
    if (wanted && typeof wanted === "object" && !Array.isArray(wanted)) {
      if ("$ilike" in wanted) return String(actual || "").toLowerCase().includes(String(wanted.$ilike).replaceAll("%", "").toLowerCase());
      if ("contains" in wanted) return String(actual || "").toLowerCase().includes(String(wanted.contains || "").toLowerCase());
      if ("in" in wanted && Array.isArray(wanted.in)) return wanted.in.includes(actual);
      if ("$eq" in wanted) return actual === wanted.$eq;
      if ("ne" in wanted) return actual !== wanted.ne;
    }
    return actual === wanted;
  });
}

function fixtureResponse(rows, query) {
  const filtered = rows.filter((item) => matchesWhere(item.data, query.where));
  const offset = Number(query.offset || 0);
  const limit = Number(query.limit || filtered.length || 25);
  return { documents: filtered.slice(offset, offset + limit), total: filtered.length };
}

async function installApiFixture(page, { state = "ready", role = "admin", requests }) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    failures.push("Application attempted an external font-service request");
    await route.abort();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;
    const pagePath = new URL(page.url()).pathname;
    const requestEntry = { method, pathname, page: pagePath, where: undefined, pending: true };
    requests.push(requestEntry);
    try {
    if (pathname === "/api/auth/me" && method === "GET") {
      if (role === "denied") return json(route, { detail: "Access denied" }, 403);
      const roles = role === "admin"
        ? ["Bifrost Docs Administrator", "Bifrost Docs Editor"]
        : role === "editor" ? ["Bifrost Docs Editor"] : [];
      return json(route, { id: "qa-viewer", name: "QA Viewer", is_superuser: role === "admin", roles });
    }
    if (pathname === "/api/organizations" && method === "GET") return json(route, organizations);
    if (/^\/api\/applications\/[^/]+\/logo$/.test(pathname) && method === "GET") {
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#5a43d6"/></svg>' });
    }

    if (pathname === "/api/workflows/execute" && method === "POST") {
      const workflow = JSON.parse(request.postData() || "{}").workflow_id;
      requestEntry.workflow = typeof workflow === "string" ? workflow : undefined;
      // Explicit read-only directory/status/preflight fixtures. Other workflow
      // executions remain blocked because they may mutate data.
      if (workflow === "functions/catalog.py::docs_list_organizations") {
        return json(route, { status: "Success", result: { caller_mode: "picker", own_organization_id: null, organizations } });
      }
      if (workflow === "functions/migration.py::docs_migration_preflight") {
        return json(route, { status: "Success", result: { organizations: organizations.map((organization) => ({ bifrost_organization_id: organization.id, bifrost_organization_name: organization.name, itglue_organization_name: `${organization.name} IT Glue` })), resource_types: ["documents", "configurations", "locations", "passwords", "flexible_assets"], count: organizations.length } });
      }
      if (workflow === "functions/migration.py::docs_migration_status") {
        return json(route, { status: "Success", result: { run: null, counts: {}, failures: [], findings: [] } });
      }
    }

    const queryMatch = pathname.match(/^\/api\/tables\/([^/]+)\/documents\/query$/);
    if (queryMatch && method === "POST") {
      const table = decodeURIComponent(queryMatch[1]);
      const query = JSON.parse(request.postData() || "{}");
      requestEntry.where = query.where;
      if (state === "error" && table === "docs-documents") return json(route, { detail: "Synthetic table failure" }, 500);
      if (state === "loading") {
        // Keep the route pending long enough to capture its visible loading
        // state, then release it so context shutdown cannot retain a hanging
        // intercepted request.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const rows = state === "empty" ? [] : (fixture[table] || []);
      return json(route, fixtureResponse(rows, query));
    }

    const recordMatch = pathname.match(/^\/api\/tables\/([^/]+)\/documents\/([^/]+)$/);
    if (recordMatch && method === "GET") {
      const rows = fixture[decodeURIComponent(recordMatch[1])] || [];
      const item = rows.find((candidate) => candidate.id === decodeURIComponent(recordMatch[2]));
      return item ? json(route, item) : json(route, { detail: "Synthetic record not found" }, 404);
    }

    // Query endpoints above are the only permitted POSTs. This makes an
    // accidental create/update/delete visible without mutating any system.
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      failures.push(`forbidden write: ${method} ${pathname}`);
      return json(route, { detail: "Browser QA blocks writes" }, 405);
    }
    failures.push(`unhandled API request: ${method} ${pathname}`);
    return json(route, { detail: "No fixture for this API request" }, 404);
    } finally {
      requestEntry.pending = false;
    }
  });
}

async function expect(page, condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readinessFor(routeName) {
  const table = (heading, tableName) => ({ heading, tableName });
  if (routeName === "/org/org-1/browse") return table("Documents", "Documents");
  if (routeName.startsWith("/browse")) {
    const kind = new URL(routeName, "https://example.invalid").searchParams.get("type") || "documents";
    const labels = { documents: "Documents", passwords: "Password metadata", configurations: "Configurations", locations: "Locations", "flexible-asset-types": "Flexible asset types", "document-folders": "Document folders", "password-folders": "Password folders" };
    return { heading: "Records", tableName: labels[kind], assetGrid: kind === "flexible-assets" };
  }
  if (routeName === "/configuration-taxonomy") return {heading: "Configuration taxonomy"};
  if (routeName === "/org/org-1/flexible-asset-types") return table("Flexible asset types", "Flexible asset types");
  if (routeName === "/org/org-1/document-folders") return table("Document folders", "Document folders");
  if (routeName === "/org/org-1/password-folders") return table("Password folders", "Password folders");
  if (/flexible-asset-types\/asset-type-1$/.test(routeName)) return {heading: "Network devices"};
  if (/document-folders\/folder-1$/.test(routeName)) return {heading: "Getting started"};
  if (/password-folders\/password-folder-1$/.test(routeName)) return {heading: "Credentials"};
  if (routeName === "/documents/new") return {heading: "New draft"};
  if (routeName === "/audit-trail") return table("Audit trail", "Audit trail");
  if (routeName === "/") return { heading: "Dashboard", countCards: true };
  if (routeName === "/org/org-1") return { heading: "Northern Star" };
  if (routeName === "/org/org-1/documents/new") return { heading: "New draft" };
  if (routeName === "/org/org-1/documents/doc-1") return { heading: "Northern Star onboarding" };
  if (routeName === "/org/org-1/passwords/password-1") return { heading: "VPN metadata" };
  if (routeName === "/org/org-1/configurations/config-1") return { heading: "Northern Star edge firewall" };
  if (routeName === "/org/org-1/locations/location-1") return { heading: "Northern Star HQ" };
  if (routeName === "/org/org-1/assets/asset-type-1/asset-1") return { heading: "Northern Star router" };
  if (routeName === "/org/org-1/documents") return table("Documents", "Documents");
  if (routeName === "/org/org-1/passwords") return table("Password metadata", "Password metadata");
  if (routeName === "/org/org-1/configurations") return table("Configurations", "Configurations");
  if (routeName === "/org/org-1/locations") return table("Locations", "Locations");
  if (routeName === "/org/org-1/assets/asset-type-1") return table("Flexible assets", "Flexible assets");
  if (routeName === "/org/org-1/assets") return { heading: "Flexible assets" };
  if (routeName === "/org/org-1/audit-trail") return table("Audit trail", "Audit trail");
  if (routeName === "/organizations") return { heading: "Organizations" };
  if (routeName === "/global") return { heading: "Global view", countCards: true };
  if (routeName === "/global/documents") return table("Documents", "Global Documents");
  if (routeName === "/global/passwords") return table("Password metadata", "Global Password metadata");
  if (routeName === "/global/configurations") return table("Configurations", "Global Configurations");
  if (routeName === "/global/locations") return table("Locations", "Global Locations");
  if (routeName === "/global/assets/asset-type-1") return table("Network devices", "Global Flexible assets");
  if (routeName === "/global/audit-trail") return table("Global audit trail", "Audit trail");
  if (routeName.startsWith("/settings")) return { heading: "Settings" };
  if (routeName === "/migration") return { heading: "IT Glue migration" };
  throw new Error(`No readiness contract for ${routeName}`);
}

async function waitForMeaningfulPage(page, routeName) {
  await page.waitForLoadState("domcontentloaded");
  const expected = readinessFor(routeName);
  if (["/configuration-taxonomy", "/settings", "/settings/configuration-types", "/settings/configuration-statuses", "/settings/custom-asset-types", "/settings/knowledge", "/settings/ai"].includes(routeName)) {
    const picker = page.locator("main").getByRole("combobox", { name: "Bifrost organization", exact: true });
    await picker.waitFor({ state: "visible", timeout });
    await page.waitForFunction(() => {
      const control = document.querySelector("main [role=combobox], main select");
      return control && !control.disabled;
    }, undefined, { timeout });
    if (await picker.evaluate(node => node instanceof HTMLSelectElement)) await picker.selectOption("org-1");
    else { await picker.click(); await page.getByRole("option", { name: "Northern Star", exact: true }).click(); }
  }
  await page.getByRole("heading", { name: expected.heading, exact: true }).waitFor({ state: "visible", timeout });
  if (routeName === "/org/org-1/assets/asset-type-1/asset-1") {
    await page.locator("main").getByText("Domain controller", { exact: true }).waitFor({ state: "visible", timeout });
    await expect(page, !/"values":|\[object Object\]/.test(await page.locator("main").innerText()), "asset detail displays source reference data rather than names");
  }
  if (expected.countCards) {
    await page.waitForFunction(() => !document.querySelector(".animate-pulse"), undefined, { timeout });
  }
  if (expected.tableName) {
    const table = page.getByRole("table", { name: expected.tableName, exact: true });
    await table.waitFor({ state: "visible", timeout });
    await page.waitForFunction((name) => {
      const candidate = [...document.querySelectorAll("table")].find((node) => node.getAttribute("aria-label") === name);
      return Boolean(candidate && candidate.getAttribute("aria-busy") !== "true" && candidate.querySelector("tbody tr:not([aria-hidden])"));
    }, expected.tableName, { timeout });
  }
  const text = await page.locator("body").innerText();
  await expect(page, !/Internal Server Error|Failed to compile|Unexpected Application Error/i.test(text), `${routeName}: framework error visible`);
}

async function captureFailure(page, { routeName, appearance, viewport, error, requests, consoleErrors = [], networkEvents = [] }) {
  const stem = `${safeName(routeName)}--failure--${appearance}--${viewport.width}`;
  let bodyText = "";
  let currentUrl = "";
  let readyState = "";
  let rootState = null;
  try { bodyText = (await page.locator("body").innerText({ timeout: 1000 })).slice(0, 12_000); } catch (failure) { bodyText = `[body unavailable: ${failure.message}]`; }
  try {
    currentUrl = safeRequestUrl(page.url());
    ({ readyState, rootState } = await page.evaluate(() => {
      const root = document.getElementById("root");
      return { readyState: document.readyState, rootState: root ? { childElementCount: root.childElementCount, textLength: root.textContent?.length ?? 0 } : null };
    }));
  } catch (failure) { currentUrl = `[url unavailable: ${failure.message}]`; }
  let screenshotError = "";
  try { await page.screenshot({ path: path.join(outDir, `${stem}.png`), fullPage: true, timeout: 5000 }); } catch (failure) { screenshotError = failure.message; }
  const pendingApiRequests = requests.filter((request) => request.pending).map(({ method, pathname, page: requestPage, where, workflow }) => ({ method, pathname, page: requestPage, where, workflow }));
  fs.writeFileSync(path.join(outDir, `${stem}.json`), `${JSON.stringify({ route: routeName, appearance, viewport, currentUrl, readyState, rootState, error: error.message, bodyText, pendingApiRequests, consoleErrors: consoleErrors.slice(-20), networkEvents: networkEvents.slice(-80), screenshotError }, null, 2)}\n`);
}

async function screenshotRoute(page, routeName, appearance, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(pageUrl(routeName, appearance), { waitUntil: "domcontentloaded", timeout });
  await waitForMeaningfulPage(page, routeName);
  if (routeName === "/global") {
    const count = page.locator('main a[href="/global/assets/asset-type-1"] p.tabular-nums');
    await count.waitFor({ state: "visible", timeout });
    await expect(page, await count.textContent() === (process.env.QA_SUMMARY_COUNTS === "1" ? "4 enabled" : "1 enabled"), "global asset type card must count the fixture's enabled member records");
  }
  await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), appearance);
  if (process.env.QA_RICH_TABLES === "1") await richTableChecks(page, routeName, appearance, viewport);
  if (viewport.width <= 820 && await page.locator('.settings-nav').count()) {
    const navigation = await page.locator('.settings-nav').boundingBox();
    await expect(page, navigation.height <= 80, `${routeName}: settings navigation consumes the compact first screen`);
  }
  const panels = await page.locator("main .record-content:not(.document-reading-outline), main .operation-panel").evaluateAll(nodes => nodes.map(node => ({ background: getComputedStyle(node).backgroundColor, paper: getComputedStyle(document.querySelector(".docs-shell__header")).backgroundColor })));
  await expect(page, panels.every(panel => panel.background === panel.paper), `${routeName}: record/operation surface does not use canonical paper ${JSON.stringify(panels)}`);
  const groups = await page.locator(".detail-main > .record-content").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  await expect(page, groups.every((group, index) => index === 0 || group.top - groups[index - 1].bottom >= 16), `${routeName}: grouped record cards have no visual separation`);
  const subtitles = await page.locator("main .page-heading > div > p:not(.section-kicker), main .record-heading > div > p.muted").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontSize));
  await expect(page, subtitles.every(size => size === "13px"), `${routeName}: page description does not use canonical 13px typography ${JSON.stringify(subtitles)}`);
  const buttonStyles = await page.locator("main .bds-button, main .detail-actions a").evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().width > 0).map((node) => ({ font: getComputedStyle(node).fontSize, height: node.getBoundingClientRect().height })));
  await expect(page, buttonStyles.every((item) => item.font === "12px"), `${routeName}: design-system button typography overridden ${JSON.stringify(buttonStyles)}`);
  const primaryText = await page.locator("main .bds-button--primary").evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width > 0).map(node => ({button: getComputedStyle(node).color, text: getComputedStyle(node.querySelector("span:last-child") || node).color})));
  await expect(page, primaryText.every(item => item.button === item.text), `${routeName}: primary button text color overridden ${JSON.stringify(primaryText)}`);
  const attachments = await page.locator("main .attachments li").evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height > 0).map(node => {
    const metadata = node.querySelector(".attachment-file-link, .attachment-file-name").getBoundingClientRect();
    const actions = node.querySelector(".attachment-actions").getBoundingClientRect();
    return { width: metadata.width, overlaps: metadata.left < actions.right && actions.left < metadata.right && metadata.top < actions.bottom && actions.top < metadata.bottom };
  }));
  await expect(page, attachments.every(item => item.width >= 80 && !item.overlaps), `${routeName}: attachment metadata is collapsed or overlaps actions ${JSON.stringify(attachments)}`);
  await expect(page, !(await page.locator("main table").allTextContents()).some(text => text.includes("[object Object]")), `${routeName}: imported references use object coercion`);
  if (viewport.width >= 1024 && await page.locator('.docs-shell__sidebar:not([data-collapsed="true"])').count()) {
    const searchIcon = await page.getByRole("button", { name: "Search catalog", exact: true }).locator("svg").boundingBox();
    const homeIcon = await page.getByRole("link", { name: "Home", exact: true }).locator("svg").boundingBox();
    await expect(page, Math.abs(searchIcon.x - homeIcon.x) <= 1, `${routeName}: navigation utilities are indented beyond the main links`);
  }
  const selectionControls = await page.locator('.bds-data-table__selection input[type="checkbox"]').evaluateAll(nodes => nodes.map(node => {
    const visual = node.getBoundingClientRect();
    const target = node.closest("label")?.getBoundingClientRect();
    return { width: visual.width, height: visual.height, targetWidth: target?.width, targetHeight: target?.height };
  }));
  await expect(page, selectionControls.every(control => control.width === 16 && control.height === 16 && control.targetWidth >= 32 && control.targetHeight >= 32), `${routeName}: selection checkboxes do not match the canonical 16px size with a padded target ${JSON.stringify(selectionControls)}`);
  if (await page.locator(".catalog-toolbar").count()) {
    const searchBounds = await page.locator(".catalog-toolbar__search input").boundingBox();
    const toolbarBounds = await page.locator(".catalog-toolbar").boundingBox();
    await expect(page, searchBounds.width >= Math.min(320, toolbarBounds.width - 44), `${routeName}: search is squeezed by secondary controls`);
    await expect(page, Math.abs(searchBounds.x - toolbarBounds.x) <= 1, `${routeName}: search is not aligned with the start of the toolbar`);
    const refresh = page.getByRole("button", { name: "Refresh records", exact: true });
    if (await refresh.count()) {
      const bounds = await refresh.boundingBox();
      await expect(page, bounds.width <= 40 && bounds.height <= 40 && !/Refresh/.test(await refresh.innerText()), `${routeName}: refresh is a large labelled action`);
    }
    await expect(page, await page.getByRole("tablist", { name: "Record type", exact: true }).count() === 0, `${routeName}: record type chips remain`);
  }
  if (await page.locator(".document-reader").count()) {
    const article = page.getByRole("article", { name: "Document content", exact: true });
    await expect(page, await article.isVisible(), `${routeName}: document reading surface is missing`);
    await expect(page, await article.getByRole("heading", { name: "Content", exact: true }).count() === 0, `${routeName}: content is wrapped in a redundant card heading`);
    const titleBounds = await article.locator(".record-heading h1").boundingBox();
    const actionBounds = await article.locator(".detail-actions").boundingBox();
    await expect(page, actionBounds.y < titleBounds.y + titleBounds.height && actionBounds.x >= titleBounds.x + titleBounds.width, `${routeName}: document actions occupy a separate row`);
    await expect(page, await page.locator('.document-reader .detail-rail, .document-reading-outline, .document-outline-mobile').count() === 0, `${routeName}: document reserves permanent utility or contents columns`);
    await expect(page, await page.getByRole('button', { name: 'Attachments', exact: true }).isVisible() && await page.getByRole('button', { name: 'Related items', exact: true }).isVisible(), `${routeName}: on-demand document tools are missing`);
    await expect(page, await page.getByRole('dialog').count() === 0, `${routeName}: document utility opens without a request`);
    const headerBounds = await article.locator(".record-heading").boundingBox();
    await expect(page, headerBounds.height < 220, `${routeName}: document header pushes reading content out of the viewport`);
    const surface = await article.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderWidth }));
    await expect(page, surface.background === "rgba(0, 0, 0, 0)" && surface.border === "0px", `${routeName}: document content is boxed in a card`);
    const contentBounds = await article.boundingBox();
    await expect(page, viewport.width < 1024 || contentBounds.width >= 500, `${routeName}: document has no generous reading measure`);
  }
  await assertKeyboardAndTouchTargets(page, routeName, viewport);
  await assertResponsiveHeader(page, routeName, viewport);
  if (routeName.endsWith('/audit-trail')) {
    const audit = page.locator('.audit-table');
    await audit.locator('.audit-event summary').first().waitFor({ state: 'visible', timeout });
    await expect(page, await page.getByText('Policy-scoped', { exact: true }).count() === 0, `${routeName}: audit repeats implementation policy copy`);
    const identifiers = audit.getByText('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { exact: true });
    await expect(page, !(await identifiers.isVisible()), `${routeName}: record identifiers are exposed before disclosure`);
    if (viewport.width <= 820) {
      const geometry = await audit.locator('.bds-data-table__scroller').evaluate(node => ({ viewport: node.clientWidth, scroll: node.scrollWidth, table: node.querySelector('table').getBoundingClientRect().width, layout: getComputedStyle(node.querySelector('table')).tableLayout, cells: [...node.querySelectorAll('tbody tr:first-child td')].map(cell => ({ width: cell.getBoundingClientRect().width, display: getComputedStyle(cell).display })), chips: [...node.querySelectorAll('.audit-event__content .bds-chip')].map(chip => ({ width: chip.getBoundingClientRect().width, maxWidth: getComputedStyle(chip).maxWidth, whiteSpace: getComputedStyle(chip).whiteSpace })) }));
      await expect(page, geometry.scroll <= geometry.viewport + 1, `${routeName}: mobile audit requires horizontal scrolling ${JSON.stringify(geometry)}`);
      await expect(page, await audit.locator('.audit-event__mobile-meta time').first().isVisible(), `${routeName}: mobile audit loses the activity timestamp`);
    }
    const disclosure = audit.locator('.audit-event').first();
    const summary = disclosure.locator('summary');
    await expect(page, (await summary.boundingBox()).height >= 32, `${routeName}: audit details have an undersized touch target`);
    await summary.click();
    await expect(page, await identifiers.isVisible(), `${routeName}: audit identifiers cannot be inspected`);
    await page.screenshot({ path: path.join(outDir, `${safeName(routeName)}--${appearance}--${viewport.width}--audit-details.png`), fullPage: true });
    await summary.focus();
    await page.keyboard.press('Space');
    await expect(page, !(await identifiers.isVisible()), `${routeName}: audit disclosure cannot close from the keyboard`);
  }
  if (viewport.width >= 1024 && await page.locator(".document-workspace.has-navigation").count()) {
    const rail = page.locator(".docs-shell__sidebar");
    await expect(page, await rail.getAttribute("data-collapsed") === "true", `${routeName}: application navigation competes with the document explorer`);
    const railBounds = await rail.boundingBox();
    await expect(page, railBounds.width === 64, `${routeName}: collapsed application navigation is not the 64px icon rail`);
    const navIcons = await rail.locator('[data-sidebar-nav-item] svg').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return box.x + box.width / 2; }));
    await expect(page, navIcons.every(center => Math.abs(center - railBounds.x - railBounds.width / 2) <= 2), `${routeName}: icon rail navigation is not centered ${JSON.stringify(navIcons)}`);
    const brand = await page.getByRole("link", { name: "Bifrost Docs home", exact: true }).boundingBox();
    const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
    const toggleBounds = await expand.boundingBox();
    const overlaps = brand.x < toggleBounds.x + toggleBounds.width && toggleBounds.x < brand.x + brand.width && brand.y < toggleBounds.y + toggleBounds.height && toggleBounds.y < brand.y + brand.height;
    await expect(page, !overlaps, `${routeName}: sidebar expansion overlaps the product identity`);
    const content = page.locator(".document-workspace__content");
    const before = await content.boundingBox();
    const draftTitle = routeName.endsWith("/new") ? page.getByRole("textbox", { name: "Title", exact: true }) : null;
    if (draftTitle) await draftTitle.fill("Unsaved sidebar layout check");
    await expand.click();
    await expect(page, await rail.getAttribute("data-collapsed") !== "true", `${routeName}: manual sidebar expansion failed`);
    const expandedContent = await content.boundingBox();
    await expect(page, before.width - expandedContent.width >= 180, `${routeName}: the compact rail does not release reading space`);
    if (draftTitle) await expect(page, await draftTitle.inputValue() === "Unsaved sidebar layout check", `${routeName}: expanding navigation discarded the draft`);
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    const restored = await content.boundingBox();
    await expect(page, Math.abs(before.width - restored.width) <= 1 && Math.abs(before.x - restored.x) <= 1, `${routeName}: collapsing navigation did not restore reading space`);
    if (draftTitle) { await expect(page, await draftTitle.inputValue() === "Unsaved sidebar layout check", `${routeName}: collapsing navigation discarded the draft`); await draftTitle.fill(""); }
    const pane = await page.locator(".document-workspace__navigation").boundingBox();
    const heading = await page.locator("main h1").first().boundingBox();
    await expect(page, pane && heading && pane.y <= heading.y + 1, `${routeName}: document navigation starts below the page heading`);
    const tree = await page.locator(".document-sidebar__tree").boundingBox();
    await expect(page, tree.y + tree.height <= viewport.height + 1, `${routeName}: document navigation tree falls outside the viewport`);
    const treeRows = await page.locator('.document-sidebar__tree button[draggable]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    await expect(page, treeRows.length > 0 && treeRows.every(height => height <= 32), `${routeName}: document explorer rows are too tall`);
    const createFolder = page.getByRole("button", { name: "New folder", exact: true });
    if (await createFolder.count()) { const control = await createFolder.boundingBox(); await expect(page, control.y + control.height <= tree.y && control.width <= 36, `${routeName}: new folder is not a compact top action`); }
  }
  const overflow = await page.locator("main").evaluateAll((nodes) => nodes.map((node) => ({
    width: node.clientWidth, scrollWidth: node.scrollWidth,
    offenders: [...node.querySelectorAll("*")].filter((child) => {
      const box = child.getBoundingClientRect();
      return box.width > 0 && box.right > node.getBoundingClientRect().right + 1 && !child.closest("table");
    }).slice(0, 12).map((child) => ({ tag: child.tagName, className: String(child.className), width: Math.round(child.getBoundingClientRect().width) })),
  })).filter((box) => box.scrollWidth > box.width + 1));
  await expect(page, overflow.length === 0, `${routeName} ${viewport.width}px: content exceeds its scrollable page container ${JSON.stringify(overflow)}`);
  const headers = await page.locator("main table thead tr").evaluateAll(rows => rows.flatMap(row => [...row.children].map(cell => ({cell: cell.getBoundingClientRect().toJSON(), labels: [...cell.querySelectorAll("button > span")].map(label => label.getBoundingClientRect().toJSON())}))));
  await expect(page, headers.every(({cell, labels}) => labels.every(label => label.left >= cell.left - 1 && label.right <= cell.right + 1)), `${routeName}: table header text crosses column boundaries`);
  await page.evaluate(async () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: path.join(outDir, `${safeName(routeName)}--${appearance}--${viewport.width}.png`), fullPage: true });
  if (await page.locator('.document-reader').count()) {
    for (const name of ['Attachments', 'Related items', 'On this page']) {
      const trigger = page.getByRole('button', { name, exact: true });
      if (!(await trigger.count())) continue;
      const docked = await page.locator('.document-tools-layout[data-layout="docked"]').count() > 0;
      const card = docked && name !== 'On this page';
      if (!card) await trigger.click();
      const panel = page.getByRole(card ? 'region' : 'dialog', { name, exact: true });
      await panel.waitFor({state: 'visible'});
      await expect(page, await page.getByRole('dialog').count() === (card ? 0 : 1), `${routeName}: document opens competing utility panels`);
      if (card) {
        const bounds = await panel.boundingBox();
        const article = await page.locator('.document-content').boundingBox();
        await expect(page, bounds.x >= article.x + article.width + 20 && article.width >= 648, `${routeName}: supporting card overlaps or squeezes the article`);
        await expect(page, await page.getByRole('region', { name: 'On this page', exact: true }).count() === 0, `${routeName}: contents became a permanent column`);
      }
      await panel.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
      const panelBounds = await panel.boundingBox();
      await expect(page, await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${routeName}: ${name} scrolls horizontally`);
      await expect(page, panelBounds.x >= -1 && panelBounds.x + panelBounds.width <= viewport.width + 1 && panelBounds.y >= 0 && panelBounds.y + panelBounds.height <= viewport.height + 1, `${routeName}: ${name} escapes the viewport`);
      await expect(page, await panel.evaluate(node => node.classList.contains('document-tools__drawer')) === (!docked && !card), `${routeName}: ${name} has the wrong responsive panel`);
      if (name === 'Related items') {
        await panel.getByRole('link', { name: 'Northern Star edge firewall', exact: true }).waitFor({state: 'visible', timeout: 15000});
        const actions = await panel.locator('.related-items li button').evaluateAll(nodes => nodes.map(node => ({box: node.getBoundingClientRect().toJSON(), label: node.closest('li').querySelector('strong').getBoundingClientRect().toJSON()})));
        const rowCount = await panel.locator('.related-items li').count();
        await expect(page, rowCount > 0 && actions.length === rowCount * 2 && actions.every(({box, label}) => box.y < label.bottom && box.bottom > label.y && box.width <= 36), `${routeName}: relationship actions occupy extra rows or labelled buttons`);
      }
      if (name === 'Attachments') await expect(page, await panel.getByRole('button', {name: 'Drop a file or browse', exact: true}).isVisible(), `${routeName}: attachment uploads are inaccessible`);
      await page.screenshot({ path: path.join(outDir, `${safeName(routeName)}--${appearance}--${viewport.width}--${safeName(name)}.png`), fullPage: true });
      if (name === 'Related items') {
        await panel.locator('.related-items li').filter({ has: page.getByRole('link', { name: 'Northern Star edge firewall', exact: true }) }).getByRole('button', { name: 'Remove', exact: true }).click();
        const confirmation = page.getByRole('dialog', { name: 'Remove related item?', exact: true });
        await confirmation.waitFor({state: 'visible'});
        await page.keyboard.press('Escape');
        await confirmation.waitFor({state: 'hidden'});
        await expect(page, await panel.isVisible(), `${routeName}: cancelling relationship confirmation dismisses its utility panel`);
      }
      if (name === 'On this page') {
        const section = panel.getByRole('link').nth(1);
        const target = await section.getAttribute('href');
        await section.click();
        await expect(page, await page.evaluate(fragment => Boolean(document.getElementById(fragment.slice(1))), target), `${routeName}: section menu does not target a document heading`);
        await page.waitForFunction(fragment => location.hash === fragment, target);
      } else if (card) await panel.getByRole('button', { name: `Close ${name}`, exact: true }).click();
      else await page.keyboard.press('Escape');
      await panel.waitFor({state: 'hidden'});
      await page.waitForFunction(label => [...document.querySelectorAll('button')].some(node => node.getAttribute('aria-label') === label && node === document.activeElement), name, { timeout: 2000 });
      if (card) {
        await trigger.click();
        await panel.waitFor({state: 'visible'});
        await page.waitForFunction(label => [...document.querySelectorAll('[role="region"]')].some(node => node.getAttribute('aria-label') === label && node === document.activeElement), name, { timeout: 2000 });
      }
    }
  }
  const main = page.locator("main");
  const scroll = await main.evaluate(node => ({height: node.clientHeight, total: node.scrollHeight}));
  if (scroll.total > scroll.height + 20) {
    await main.evaluate(node => {node.scrollTop = node.scrollHeight;});
    if (viewport.width <= 820 && await page.locator(".settings-nav").count()) {
      const layout = await page.locator(".settings-layout").evaluate(node => ({ navigation: node.querySelector(".settings-nav").getBoundingClientRect().toJSON(), content: node.lastElementChild.getBoundingClientRect().toJSON() }));
      await expect(page, layout.navigation.bottom <= layout.content.top + 1, `${routeName}: settings navigation overlaps scrolled mobile content`);
    }
    await page.screenshot({ path: path.join(outDir, `${safeName(routeName)}--${appearance}--${viewport.width}--bottom.png`), fullPage: true });
    await main.evaluate(node => {node.scrollTop = 0;});
  }
}

async function richTableChecks(page, routeName, appearance, viewport) {
  await page.locator(".rich-content table").first().waitFor({ state: "visible", timeout });
  await page.evaluate(() => document.fonts.ready);
  const words = await page.locator(".rich-content [data-readability-word]").evaluateAll(nodes => nodes.map(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return { word: node.textContent, fragments: range.getClientRects().length };
  }));
  await expect(page, words.length === 2 && words.every(word => word.fragments === 1), `${routeName}: table words are split across lines ${JSON.stringify(words)}`);
  const scrollers = page.locator(".rich-content > .rich-table-scroll");
  await expect(page, await scrollers.count() === 2, `${routeName}: outer tables need independent scrolling regions`);
  const inventory = page.getByRole("region", { name: "Inventory", exact: true });
  const geometry = await inventory.evaluate(node => ({width:node.clientWidth,scroll:node.scrollWidth,overflow:getComputedStyle(node).overflowX,tabIndex:node.tabIndex}));
  await expect(page, geometry.width <= viewport.width && geometry.scroll > geometry.width && geometry.overflow === "auto" && geometry.tabIndex === 0, `${routeName}: wide table cannot be independently scrolled ${JSON.stringify(geometry)}`);
  await inventory.focus();
  const keyboardScroll = await inventory.evaluateHandle(node => {
    const state = {done:false};
    node.addEventListener("scrollend", () => {state.done = true;}, {once:true});
    return state;
  });
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(state => state.done, keyboardScroll, { timeout });
  await keyboardScroll.dispose();
  await expect(page, await inventory.evaluate(node => node.scrollLeft > 0), `${routeName}: keyboard did not scroll the table`);
  await inventory.evaluate(node => {node.scrollLeft = node.scrollWidth;});
  await page.waitForFunction(() => { const node = document.querySelector('.rich-table-scroll[aria-label="Inventory"]'); return node && Math.abs(node.scrollLeft - (node.scrollWidth - node.clientWidth)) < 2; }, null, { timeout });
  await inventory.locator("[data-table-last]").scrollIntoViewIfNeeded();
  const last = await inventory.locator("[data-table-last]").boundingBox(), box = await inventory.boundingBox();
  await expect(page, last.x >= box.x - 1 && last.x + last.width <= box.x + box.width + 1, `${routeName}: final table column is unreachable (${JSON.stringify({last,box})})`);
  await expect(page, await inventory.locator('[rowspan="2"]').count() === 1 && await inventory.locator('[colspan="3"]').count() === 1 && await inventory.locator('table table').count() === 1 && await inventory.locator('[role="region"]').count() === 0, `${routeName}: merged or nested table semantics changed`);
  await expect(page, await page.locator("main").evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollLeft === 0), `${routeName}: table scrolling overflowed the page`);
  await page.screenshot({ path: path.join(outDir, `rich-table-last--${safeName(routeName)}--${appearance}--${viewport.width}.png`), fullPage: true });
  await inventory.evaluate(node => {node.scrollLeft = 0;});
  await page.getByRole("region", { name: "Service tasks", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, `rich-table-words--${safeName(routeName)}--${appearance}--${viewport.width}.png`), fullPage: true });
  await page.locator('.docs-shell__header button:visible, .docs-shell__header a:visible').first().focus();
  await page.locator("main").evaluate(node => {node.scrollTop = 0;});
}

async function assertKeyboardAndTouchTargets(page, routeName, viewport) {
  // The route must remain operable without a pointer. A Tab press is a low-cost
  // regression check for accidentally removed focusability in every viewport.
  await page.locator("body").press("Tab");
  const focusable = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body && active.tabIndex >= 0;
  });
  await expect(page, focusable, `${routeName} ${viewport.width}px: Tab did not move focus to an interactive control`);

  // Small icon buttons may be visually compact, but their actual hit target
  // cannot shrink below 24 CSS px. Hidden dialog controls are excluded.
  const undersized = await page.locator("button, input, select, textarea, [role=button], [role=combobox], a[href]").evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      // Native checkbox/radio inputs can be a 1px visually-hidden control
      // behind their labelled, full-size Radix/tailwind proxy. Measuring the
      // hidden input would be a false touch-target failure.
      if (node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type) && rect.width <= 2 && rect.height <= 2) return false;
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    })
    .map((node) => {
      const target = node instanceof HTMLInputElement && node.type === "checkbox" ? node.closest("label") || node : node;
      const rect = target.getBoundingClientRect();
      return { tag: node.tagName, label: node.getAttribute("aria-label") || node.textContent?.trim() || "unlabelled", width: Math.round(rect.width), height: Math.round(rect.height) };
    })
    .filter((item) => item.width < 24 || item.height < 24));
  await expect(page, undersized.length === 0, `${routeName} ${viewport.width}px: undersized touch targets ${JSON.stringify(undersized.slice(0, 5))}`);
}

// Use the SDK controls at the current breakpoint; phone controls live in Menu.
async function setSdkTheme(page, theme) {
  const header = page.locator(".docs-shell__header");
  const phone = await page.evaluate(() => window.innerWidth < 640);
  if (phone) {
    const toggle = header.getByRole("button", { name: "Open menu", exact: true });
    await toggle.waitFor({ state: "visible", timeout });
    if (await header.getAttribute("data-bifrost-header-theme") === theme) return;
    await toggle.click();
    const panel = header.getByRole("dialog", { name: "Menu", exact: true });
    await panel.getByRole("button", { name: theme === "dark" ? "Dark mode" : "Light mode", exact: true }).click();
    await page.waitForFunction(value => document.querySelector("[data-bifrost-header]")?.getAttribute("data-bifrost-header-theme") === value, theme, { timeout });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden", timeout });
  } else {
    await header.getByRole("button", { name: "Account menu", exact: true }).waitFor({ state: "visible", timeout });
    if (await header.getAttribute("data-bifrost-header-theme") !== theme) {
      await header.getByRole("button", { name: `Switch to ${theme} theme`, exact: true }).click();
    }
  }
  await page.waitForFunction(value => document.documentElement.classList.contains("dark") === (value === "dark"), theme, { timeout });
}

async function assertResponsiveHeader(page, routeName, viewport) {
  const header = page.locator(".docs-shell__header");
  await expect(page, await header.count() === 1, `${routeName}: expected one SDK header`);
  await expect(page, await header.getByRole("button", { name: /search|recently viewed/i }).count() === 0, `${routeName}: search/history belong in navigation`);
  if (viewport.width < 640) {
    const toggle = header.getByRole("button", { name: "Open menu", exact: true });
    await toggle.waitFor({ state: "visible", timeout });
    const bounds = await header.boundingBox();
    await expect(page, bounds.height <= 58, `${routeName}: phone SDK header reserves an obsolete second row (${bounds.height}px)`);
    const button = await toggle.boundingBox();
    await expect(page, button.width >= 44 && button.height >= 44, `${routeName}: phone menu target is smaller than 44px (${button.width}×${button.height})`);
    await expect(page, !await header.getByRole("combobox").isVisible(), `${routeName}: phone organization selector should be in the SDK menu`);
    await toggle.click();
    const panel = header.getByRole("dialog", { name: "Menu", exact: true });
    await panel.waitFor({ state: "visible", timeout });
    const panelBox = await panel.boundingBox();
    await expect(page, panelBox.x >= 0 && panelBox.y >= bounds.y + bounds.height - 1 && panelBox.x + panelBox.width <= viewport.width + 1 && panelBox.y + panelBox.height <= viewport.height + 1, `${routeName}: SDK phone menu exceeds viewport`);
    await expect(page, await panel.evaluate(node => getComputedStyle(node).display !== "contents" && node.scrollWidth <= node.clientWidth + 1), `${routeName}: legacy CSS flattened or overflowed the SDK phone panel`);
    const org = panel.getByRole("combobox");
    await org.waitFor({ state: "visible", timeout });
    const orgBox = await org.boundingBox();
    await expect(page, orgBox.width >= 184 && orgBox.height >= 44, `${routeName}: phone organization selector is undersized`);
    await expect(page, await panel.getByRole("button", { name: "Open navigation", exact: true }).isVisible(), `${routeName}: phone navigation unavailable in SDK menu`);
    await expect(page, await panel.getByRole("link", { name: "Back to Bifrost", exact: true }).isVisible() && await panel.getByRole("button", { name: "Log out", exact: true }).isVisible(), `${routeName}: phone platform/account controls unavailable`);
    if (process.env.QA_HEADER_MOBILE === "1") {
      await page.screenshot({ path: path.join(outDir, `sdk-phone-menu--${safeName(routeName)}--${viewport.width}--${await header.getAttribute("data-bifrost-header-theme")}.png`), fullPage: true });
      await org.click();
      const search = page.getByRole("searchbox", { name: "Search organizations", exact: true });
      await search.fill("Northern Star");
      await expect(page, await page.getByRole("listbox").getByRole("option", { name: "Northern Star", exact: true }).isVisible(), `${routeName}: organization filter unavailable from phone menu`);
      await page.keyboard.press("Escape");
      await search.waitFor({ state: "hidden", timeout });
      if (!await panel.isVisible()) await toggle.click();
      const mode = await header.getAttribute("data-bifrost-header-theme");
      const themeButton = panel.getByRole("button", { name: mode === "dark" ? "Light mode" : "Dark mode", exact: true });
      await themeButton.click();
      await page.waitForFunction(previous => document.querySelector("[data-bifrost-header]")?.getAttribute("data-bifrost-header-theme") !== previous, mode);
      await panel.getByRole("button", { name: mode === "dark" ? "Dark mode" : "Light mode", exact: true }).click();
      await page.waitForFunction(value => document.querySelector("[data-bifrost-header]")?.getAttribute("data-bifrost-header-theme") === value, mode);
      await panel.getByRole("button", { name: "Open navigation", exact: true }).click();
      const navigation = page.getByRole("dialog", { name: "Documentation navigation", exact: true });
      await navigation.waitFor({ state: "visible", timeout });
      await page.keyboard.press("Tab");
      await expect(page, await navigation.evaluate(node => node.contains(document.activeElement)), `${routeName}: phone navigation does not contain keyboard focus`);
      await page.screenshot({ path: path.join(outDir, `sdk-phone-navigation--${safeName(routeName)}--${viewport.width}--${mode}.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await navigation.waitFor({ state: "hidden", timeout });
      const restoredTrigger = await panel.isVisible() ? panel.getByRole("button", { name: "Open navigation", exact: true }) : toggle;
      await expect(page, await restoredTrigger.evaluate(node => node === document.activeElement), `${routeName}: phone navigation dismissal lost trigger focus`);
    }
    if (await panel.isVisible()) await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden", timeout });
    await expect(page, await toggle.evaluate(node => node === document.activeElement), `${routeName}: phone menu dismissal did not restore focus`);
  } else {
    await expect(page, await header.getByRole("button", { name: "Open menu", exact: true }).count() === 0, `${routeName}: phone SDK menu remained on desktop`);
    const org = header.getByRole("combobox");
    await org.waitFor({ state: "visible", timeout });
    await expect(page, (await org.boundingBox()).width >= 200, `${routeName}: organization selector too narrow`);
    const mobileToggle = header.getByRole("button", { name: "Open navigation", exact: true });
    await expect(page, await mobileToggle.isVisible() === (viewport.width < 1024), `${routeName}: navigation toggle at wrong width`);
    await expect(page, await header.getByRole("button", { name: "Account menu", exact: true }).isVisible(), `${routeName}: desktop account controls unavailable`);
  }
  const boxes = await header.locator('button:visible, a:visible, [role="combobox"]:visible').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute("aria-label") || node.textContent.trim(), rect: node.getBoundingClientRect().toJSON() })));
  for (const {label, rect} of boxes) await expect(page, rect.left >= -1 && rect.right <= viewport.width + 1, `${routeName}: header ${label} exceeds viewport`);
}

async function openApplicationNavigation(page) {
  if (page.viewportSize().width < 640) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("dialog", { name: "Documentation navigation", exact: true }).waitFor({ state: "visible", timeout });
}

async function catalogCurrentChecks(page, routeName, appearance, viewport) {
  const url = new URL(routeName, baseUrl);
  const kind = url.searchParams.get("type");
  const documentsExpected = /^(?:\/org\/[^/]+)?\/browse$/.test(url.pathname)
    ? !kind || kind === "documents"
    : /\/documents(?:\/|$)/.test(url.pathname);
  if (viewport.width < 1024) await openApplicationNavigation(page);
  const navigation = page.getByRole("navigation", { name: "Documentation navigation", exact: true });
  const documents = navigation.getByRole("link", { name: "Documents", exact: true });
  await documents.waitFor({ state: "visible", timeout });
  await expect(page, (await documents.getAttribute("aria-current") === "page") === documentsExpected, `${routeName}: Documents current-page semantics do not match the displayed catalog`);
  await expect(page, (await documents.getAttribute("data-active") === "true") === documentsExpected, `${routeName}: Documents visual selection does not match the displayed catalog`);
  if (documentsExpected) await expect(page, await navigation.locator('[aria-current="page"]').count() === 1, `${routeName}: multiple navigation links marked as the current page`);
  await page.screenshot({ path: path.join(outDir, `catalog-current--${safeName(routeName)}--${viewport.width}--${appearance}.png`), fullPage: true });
  if (viewport.width < 1024) {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Documentation navigation", exact: true }).waitFor({ state: "hidden", timeout });
    const panel = page.getByRole("dialog", { name: "Menu", exact: true });
    if (await panel.isVisible()) await page.keyboard.press("Escape");
  }
}

async function summaryCountChecks(page, routeName, appearance, viewport) {
  const scoped = routeName.startsWith("/org/");
  if (routeName === "/global") {
    for (const [href, expected] of [["/global/passwords", 4], ["/global/locations", 4], ["/global/documents", 34], ["/global/configurations?type=Firewall", 4], ["/global/assets/asset-type-1", 4]]) {
      const count = page.locator(`main a[href="${href}"] .tabular-nums`);
      await expect(page, await count.textContent() === `${expected} enabled`, `${routeName}: enabled card total differs for ${href}`);
    }
  }
  if (["/org/org-1/assets", "/browse?type=flexible-assets"].includes(routeName)) {
    const card = page.getByRole("button", { name: /Network devices/ }).first();
    await expect(page, await card.locator(".tabular-nums").textContent() === (scoped ? "4" : "5"), `${routeName}: inclusive browse-grid count changed`);
  }
  if (viewport.width < 1024) await openApplicationNavigation(page);
  const navigation = page.getByRole("navigation", { name: "Documentation navigation", exact: true });
  for (const [name, expected] of [["Passwords", scoped ? 3 : 4], ["Locations", scoped ? 3 : 4], ["Documents", scoped ? 32 : 34], ["Configurations", scoped ? 3 : 4]]) {
    const count = navigation.getByRole("link", { name, exact: true }).locator(".tabular-nums");
    await count.waitFor({ state: "visible", timeout });
    await expect(page, await count.textContent() === String(expected), `${routeName}: enabled navigation total differs for ${name}`);
    await expect(page, await count.getAttribute("title") === `${expected} enabled records`, `${routeName}: count meaning is not labelled for ${name}`);
  }
  await page.screenshot({ path: path.join(outDir, `summary-counts--${safeName(routeName)}--${appearance}--${viewport.width}.png`), fullPage: true, animations: "disabled" });
  if (viewport.width < 1024) {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Documentation navigation", exact: true }).waitFor({ state: "hidden", timeout });
    const menu = page.getByRole("dialog", { name: "Menu", exact: true });
    if (await menu.isVisible()) await page.keyboard.press("Escape");
  }
}

async function disabledListChecks(page, routeName, appearance, viewport) {
  const supported = /(?:configurations|locations|assets\/asset-type-1)$/.test(routeName)
    || ["/browse?type=configurations", "/browse?type=locations"].includes(routeName);
  if (!supported) return;
  const main = page.locator("main");
  const disabled = main.getByText("Visibility disabled", { exact: true });
  const active = main.getByText("Visibility active", { exact: true });
  const legacy = main.getByText("Visibility legacy", { exact: true });
  const control = page.getByRole("switch", { name: "Show disabled", exact: true });
  await active.waitFor({ state: "visible", timeout });
  await legacy.waitFor({ state: "visible", timeout });
  if (routeName.startsWith("/global/")) {
    await disabled.waitFor({ state: "visible", timeout });
    await expect(page, await control.count() === 0, `${routeName}: original inclusive global list acquired a scoped visibility toggle`);
    return;
  }
  await control.waitFor({ state: "visible", timeout });
  await expect(page, await control.getAttribute("aria-checked") === "false" && await disabled.count() === 0, `${routeName}: disabled records are not hidden by default`);
  await expect(page, (await main.locator("caption").textContent()).startsWith("3 "), `${routeName}: default server count did not exclude disabled records`);
  const bounds = await page.locator(".catalog-visibility-filter").boundingBox();
  await expect(page, bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, `${routeName}: visibility filter exceeds viewport`);
  await control.focus();
  await page.keyboard.press("Space");
  await disabled.waitFor({ state: "visible", timeout });
  await expect(page, await control.getAttribute("aria-checked") === "true" && new URL(page.url()).searchParams.get("showDisabled") === "1", `${routeName}: keyboard toggle did not preserve visibility in the URL`);
  await expect(page, (await main.locator("caption").textContent()).startsWith("4 "), `${routeName}: inclusive server count is incorrect`);
  await expect(page, await control.evaluate(node => node === document.activeElement), `${routeName}: toggling visibility lost keyboard focus`);
  await page.screenshot({ path: path.join(outDir, `disabled-list--${safeName(routeName)}--${appearance}--${viewport.width}--inclusive.png`), fullPage: true, animations: "disabled" });
  await page.reload({ waitUntil: "domcontentloaded", timeout });
  await disabled.waitFor({ state: "visible", timeout });
  await expect(page, await control.getAttribute("aria-checked") === "true", `${routeName}: bookmarked visibility was lost on reload`);
  await control.focus();
  await page.keyboard.press("Enter");
  await disabled.waitFor({ state: "detached", timeout });
  await legacy.waitFor({ state: "visible", timeout });
  await expect(page, await control.getAttribute("aria-checked") === "false" && !new URL(page.url()).searchParams.has("showDisabled"), `${routeName}: turning visibility off left a stale URL state`);
}

async function detailEnabledChecks(page, routeName, appearance, viewport) {
  const cases = {
    "/org/org-1/configurations/config-1": ["Enable configuration", false],
    "/org/org-1/locations/location-1": ["Disable location", true],
    "/org/org-1/assets/asset-type-1/asset-1": ["Enable flexible asset", false],
  };
  const state = cases[routeName];
  if (!state) return;
  const [label, enabled] = state;
  const action = page.getByRole("button", { name: label, exact: true });
  await action.waitFor({ state: "visible", timeout });
  const box = await action.boundingBox();
  await expect(page, box && box.width <= 40 && box.x >= 0 && box.x + box.width <= viewport.width, `${routeName}: enabled-state action is not compact or exceeds viewport`);
  await expect(page, await page.locator(".record-meta").getByText("Disabled", { exact: true }).count() === (enabled ? 0 : 1), `${routeName}: disabled status does not match record state`);
  await expect(page, !await page.getByText(/IT Glue may overwrite/).isVisible(), `${routeName}: source warning leaked into reading view`);
  await action.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: `${label}?`, exact: true });
  await dialog.waitFor({ state: "visible", timeout });
  await dialog.evaluate(async node => {
    let timeoutId;
    try {
      await Promise.race([
        Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))),
        new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("Enabled-state dialog animation did not settle")), 3000); }),
      ]);
    } finally { clearTimeout(timeoutId); }
  });
  await expect(page, await dialog.getByText(/IT Glue may overwrite/).isVisible(), `${routeName}: imported mutation lacks source warning`);
  const bounds = await dialog.boundingBox();
  await expect(page, bounds && bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, `${routeName}: confirmation exceeds viewport`);
  await page.screenshot({ path: path.join(outDir, `detail-enabled-confirmation--${safeName(routeName)}--${appearance}--${viewport.width}.png`), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout });
  await expect(page, await action.evaluate(node => node === document.activeElement), `${routeName}: cancellation did not restore action focus`);
}

async function backupEntryChecks(page, routeName, appearance, viewport) {
  if (!["/settings/backup", "/settings/exports"].includes(routeName)) return;
  const link = page.getByRole("link", { name: "Manage backups", exact: true });
  await expect(page, await link.count() === 1, `${routeName}: backup management entry is missing`);
  await expect(page, await link.getAttribute("href") === "/solutions/synthetic-solution?tab=exports", `${routeName}: backup entry did not use the host's owning Solution`);
  const box = await link.boundingBox();
  await expect(page, box && box.x >= 0 && box.x + box.width <= viewport.width, `${routeName} ${viewport.width}px: backup action exceeds the viewport`);
  await link.focus();
  await expect(page, await link.evaluate(node => node === document.activeElement), `${routeName}: backup entry cannot receive keyboard focus`);
  await expect(page, await page.getByText(/Include Table data and Solution-owned files/).isVisible(), `${routeName}: full backup selection guidance is missing`);
  await page.screenshot({ path: path.join(outDir, `backup-entry--${routeName.endsWith("exports") ? "alias" : "backup"}--${appearance}--${viewport.width}.png`), fullPage: true });
}

async function taxonomyNavigationChecks(page, routeName, appearance, viewport) {
  const standalone = routeName === "/configuration-taxonomy";
  const currentPath = new URL(page.url()).pathname;
  if (!standalone && !/\/settings\/configuration-(types|statuses)$/.test(currentPath)) return;
  const statuses = currentPath.endsWith("/configuration-statuses");
  const title = statuses ? "Configuration statuses" : "Configuration types";
  const other = statuses ? "Configuration types" : "Configuration statuses";
  const tabs = page.getByRole("tablist", { name: "Taxonomy kind", exact: true });
  if (standalone) {
    await tabs.waitFor({ state: "visible", timeout });
    await tabs.getByRole("tab", { name: other, exact: true }).click();
  } else {
    await expect(page, await tabs.count() === 0, `${routeName}: settings repeats its taxonomy navigation`);
    await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible", timeout });
    if (viewport.width >= 1024) {
      const heading = await page.getByRole("heading", { name: title, exact: true }).boundingBox();
      const create = await page.getByRole("button", { name: `New ${statuses ? "Configuration status" : "Configuration type"}`, exact: true }).boundingBox();
      await expect(page, Math.abs(heading.y + heading.height / 2 - create.y - create.height / 2) <= 2, `${routeName}: creation action consumes a separate desktop header row`);
    }
    const compact = page.getByRole("combobox", { name: "Settings section", exact: true });
    if (await compact.isVisible()) await compact.selectOption(statuses ? "/settings/configuration-types" : "/settings/configuration-statuses");
    else await page.getByRole("navigation", { name: "Settings sections", exact: true }).getByRole("link", { name: other, exact: true }).click();
    await page.getByRole("heading", { name: other, exact: true }).waitFor({ state: "visible", timeout });
  }
  await page.getByRole("table", { name: other, exact: true }).waitFor({ state: "visible", timeout });
  await page.getByRole("button", { name: `New ${statuses ? "Configuration type" : "Configuration status"}`, exact: true }).waitFor({ state: "visible", timeout });
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: path.join(outDir, `taxonomy-navigation--${safeName(routeName)}--${viewport.width}--${appearance}.png`), fullPage: true, animations: "disabled" });
}

async function searchResultStabilityChecks(page, appearance, viewport) {
  if (page.viewportSize().width < 1024) await openApplicationNavigation(page);
  await page.getByRole("button", { name: "Search catalog", exact: true }).click();
  await page.getByRole("textbox", { name: "Search query", exact: true }).fill("Northern Star onboarding");
  const dialog = page.getByRole("dialog", { name: "Search the catalog", exact: true });
  const result = dialog.locator('a[href$="/documents/doc-1"]');
  await result.waitFor({ state: "visible", timeout });
  const before = await result.boundingBox();
  await result.hover();
  await dialog.getByRole("complementary", { name: "Record preview", exact: true }).getByRole("heading", { name: "Northern Star onboarding", exact: true }).waitFor({ state: "visible", timeout });
  const after = await result.boundingBox();
  await expect(page, Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1, `hover preview moved a result away from the pointer: ${JSON.stringify({ before, after })}`);
  await page.screenshot({ path: path.join(outDir, `search-result-stable--${viewport.width}--${appearance}.png`), fullPage: true });
  await result.click();
  await page.waitForURL(/\/documents\/doc-1$/, { timeout });
  await page.getByRole("heading", { name: "Northern Star onboarding", exact: true }).first().waitFor({ state: "visible", timeout });
  await page.goto(`${baseUrl}/org/org-1/documents`, { waitUntil: "domcontentloaded", timeout });
  await waitForMeaningfulPage(page, "/org/org-1/documents");
}

async function openFolderNavigation(page) {
  const trigger = page.getByRole("button", { name: "Browse folders", exact: true });
  // React's media-query update may commit after setViewportSize resolves.
  // At a known phone width, wait for the drawer trigger instead of skipping it.
  if (page.viewportSize().width < 1024) await trigger.click();
}

async function closeFolderNavigation(page) {
  const close = page.getByRole("button", { name: "Close folders", exact: true });
  if (await close.isVisible()) await close.click();
}

async function folderNavigationStateChecks(page, appearance, viewport) {
  await openFolderNavigation(page);
  const sidebar = page.getByRole("complementary", { name: "Document folders", exact: true });
  await sidebar.getByRole("button", { name: "Wi-Fi setup", exact: true }).waitFor({ state: "visible", timeout });
  await sidebar.getByRole("button", { name: "Collapse Networking", exact: true }).click();
  await sidebar.getByRole("button", { name: "Collapse Getting started", exact: true }).click();
  const filter = sidebar.getByRole("textbox", { name: "Filter documents", exact: true });
  await filter.fill("wi-fi");
  if (viewport.width < 1024) {
    await closeFolderNavigation(page);
    await page.getByRole("dialog", { name: "Document folders", exact: true }).waitFor({ state: "hidden", timeout });
    await openFolderNavigation(page);
  }
  await expect(page, await filter.inputValue() === "wi-fi", "reopening the folder drawer reset its filter");
  await sidebar.getByRole("button", { name: "Wi-Fi setup", exact: true }).waitFor({ state: "visible", timeout });
  await expect(page, await sidebar.getByRole("button", { name: "Network guide", exact: true }).count() === 0, "reopened folder filtering includes unrelated records");
  for (const width of [1920, 390, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    if (width < 1024) await openFolderNavigation(page);
    await filter.waitFor({ state: "visible", timeout });
    await expect(page, await filter.inputValue() === "wi-fi", "folder filtering was lost during a responsive transition");
  }
  if (process.env.QA_HEADER_RESIZE === "1") {
    const header = page.locator(".docs-shell__header");
    await header.getByRole("combobox").waitFor({ state: "visible", timeout });
    await expect(page, await header.getByRole("button", { name: "Account menu", exact: true }).isVisible(), "desktop account controls did not return after phone resizing");
    await expect(page, await header.getByRole("button", { name: "Open menu", exact: true }).count() === 0, "phone SDK menu remained after desktop return");
  }
  await filter.fill("");
  await sidebar.getByRole("button", { name: "Expand Getting started", exact: true }).waitFor({ state: "visible", timeout });
  await sidebar.getByRole("button", { name: "Expand Networking", exact: true }).waitFor({ state: "visible", timeout });
  await expect(page, await sidebar.getByRole("button", { name: "Northern Star onboarding", exact: true }).count() === 0, "reopening undid a manually collapsed active-document ancestor");
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
  await page.screenshot({ path: path.join(outDir, `folder-state--${appearance}--${viewport.width}.png`), fullPage: true });
  await page.setViewportSize(viewport);
}

async function folderNavigationChecks(page, appearance, viewport) {
  const trigger = page.getByRole("button", { name: "Browse folders", exact: true });
  const compact = viewport.width < 1024;
  const before = await page.locator(".document-workspace__content").boundingBox();
  await openFolderNavigation(page);
  if (compact) {
    const drawer = page.getByRole("dialog", { name: "Document folders", exact: true });
    await drawer.waitFor({ state: "visible", timeout });
    const bounds = await drawer.boundingBox();
    await expect(page, bounds.x >= 0 && bounds.width <= viewport.width - 16 && bounds.height <= viewport.height + 1, "folder drawer exceeded its viewport");
    await page.screenshot({ path: path.join(outDir, `folder-drawer--${viewport.width}--${appearance}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout });
    await expect(page, await trigger.evaluate(node => document.activeElement === node), "folder drawer did not restore trigger focus");
    const after = await page.locator(".document-workspace__content").boundingBox();
    await expect(page, Math.abs(before.y - after.y) <= 1 && Math.abs(before.width - after.width) <= 1, "folder drawer moved or narrowed the document");
    await openFolderNavigation(page);
  }
  const sidebar = page.getByRole("complementary", { name: "Document folders", exact: true });
  await sidebar.getByRole("button", { name: "Wi-Fi setup", exact: true }).waitFor({ state: "visible", timeout });
  await sidebar.getByRole("button", { name: "Actions for Networking", exact: true }).click();
  const rename = page.getByRole("menuitem", { name: "Rename folder", exact: true });
  await rename.waitFor({ state: "visible", timeout });
  await expect(page, await rename.evaluate(node => document.activeElement === node), "folder action menu escaped the drawer's focus boundary");
  await rename.click();
  const folderName = sidebar.getByRole("textbox", { name: "Rename Networking", exact: true });
  await folderName.waitFor({ state: "visible", timeout });
  await expect(page, await folderName.inputValue() === "Networking", "folder action failed to open its editor");
  await sidebar.getByRole("button", { name: "Cancel", exact: true }).click();
  await sidebar.getByRole("button", { name: "Actions for Networking", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "Actions for Networking", exact: true }).waitFor({ state: "hidden", timeout });
  await expect(page, await sidebar.isVisible(), "Escape dismissed the folder drawer along with its action menu");
  await sidebar.getByRole("button", { name: "Collapse Networking", exact: true }).click();
  await sidebar.getByRole("button", { name: "Collapse Infrastructure", exact: true }).click();
  await sidebar.getByRole("button", { name: "Expand Infrastructure", exact: true }).click();
  await expect(page, await sidebar.getByRole("button", { name: "Expand Networking", exact: true }).count() === 1, "reopening a parent reset its child's collapsed state");
  await sidebar.getByRole("button", { name: "Collapse Infrastructure", exact: true }).click();
  const filter = sidebar.getByRole("textbox", { name: "Filter documents", exact: true });
  await filter.fill("wi-fi");
  await sidebar.getByRole("button", { name: "Wi-Fi setup", exact: true }).waitFor({ state: "visible", timeout });
  await expect(page, await sidebar.getByRole("button", { name: "Archive", exact: true }).count() === 0, "folder search retained an unrelated nested branch");
  await expect(page, await sidebar.getByRole("button", { name: "Network guide", exact: true }).count() === 0, "folder search retained an unrelated document");
  await page.screenshot({ path: path.join(outDir, `folder-filter--${viewport.width}--${appearance}.png`), fullPage: true });
  await filter.fill("Infrastructure");
  await sidebar.getByRole("button", { name: "Wi-Fi setup", exact: true }).waitFor({ state: "visible", timeout });
  await filter.fill("no matching title");
  await sidebar.getByRole("status").getByText("No folders or documents match.", { exact: true }).waitFor({ state: "visible", timeout });
  await filter.fill("");
  await expect(page, await sidebar.getByRole("button", { name: "Expand Infrastructure", exact: true }).count() === 1, "clearing search did not restore the previous collapse");
  await closeFolderNavigation(page);
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("Wi-Fi setup");
  const documentAction = page.getByRole("table", { name: "Documents", exact: true }).getByRole("button", { name: "Open Wi-Fi setup", exact: true });
  await documentAction.waitFor({ state: "visible", timeout });
  await documentAction.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/documents\/doc-wifi$/, { timeout });
  await page.getByRole("heading", { name: "Wi-Fi setup", exact: true }).waitFor({ state: "visible", timeout });
  await openFolderNavigation(page);
  const active = sidebar.getByRole("button", { name: "Wi-Fi setup", exact: true });
  await active.waitFor({ state: "visible", timeout });
  await expect(page, await active.getAttribute("aria-current") === "page", "opening a document outside the tree did not reveal its selected row");
  await expect(page, await sidebar.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "folder navigation overflowed its available width");
  await page.screenshot({ path: path.join(outDir, `folder-active-path--${viewport.width}--${appearance}.png`), fullPage: true });
  if (compact) {
    await active.click();
    await page.getByRole("dialog", { name: "Document folders", exact: true }).waitFor({ state: "hidden", timeout });
    await page.getByRole("heading", { name: "Wi-Fi setup", exact: true }).waitFor({ state: "visible", timeout });
    await openFolderNavigation(page);
    await sidebar.getByRole("button", { name: "Getting started", exact: true }).click();
    await page.waitForURL(/\/documents\?folder=folder-1$/, { timeout });
    await page.getByRole("dialog", { name: "Document folders", exact: true }).waitFor({ state: "hidden", timeout });
  }
}

async function interactionChecks(page, requests) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/org/org-1`, { waitUntil: "domcontentloaded", timeout });
  await waitForMeaningfulPage(page, "/org/org-1");
  await page.goto(`${baseUrl}/org/org-1/documents/doc-1`, { waitUntil: "domcontentloaded", timeout });
  await waitForMeaningfulPage(page, "/org/org-1/documents/doc-1");
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout });
  await page.getByRole("heading", { name: "Recent Organizations", exact: true }).waitFor({ state: "visible", timeout });
  await page.getByRole("heading", { name: "Recent Items", exact: true }).waitFor({ state: "visible", timeout });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
    for (const theme of ["light", "dark"]) {
      await setSdkTheme(page, theme);
      await page.evaluate(async () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
      await page.screenshot({ path: path.join(outDir, `interaction-populated-dashboard--${width}--${theme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/global`, { waitUntil: "domcontentloaded", timeout });
  await waitForMeaningfulPage(page, "/global");

  const search = page.getByRole("button", { name: /search/i }).first();
  await search.click();
  const query = page.getByRole("textbox", { name: "Search query" });
  await query.fill("Welcome");
  await expect(page, await query.evaluate((node) => document.activeElement === node), "search dialog did not focus its query input");
  await page.getByRole("heading", { name: "Documents" }).waitFor({ state: "visible", timeout });
  await page.getByRole("link", { name: /Northern Star onboarding/i }).waitFor({ state: "visible", timeout });
  await page.getByRole("button", { name: "Preview Northern Star onboarding" }).click();
  await expect(page, await page.getByRole("complementary", { name: "Record preview" }).getByText(/Welcome to Northern Star/i).isVisible(), "search preview did not render document content");
  await page.screenshot({ path: path.join(outDir, "interaction-search-results.png"), fullPage: true });
  await query.fill("Northern Star");
  await page.getByRole("button", { name: "Documents" }).click();
  await page.getByRole("button", { name: /^Search$/ }).click();
  await page.waitForURL(/\/global\/documents\?q=Northern Star$/, { timeout });
  await expect(page, page.url().includes("/global/documents?q=Northern Star"), "search submit did not target the global kind route");

  await page.keyboard.press("Control+k");
  await expect(page, await page.getByRole("dialog").isVisible(), "keyboard shortcut did not reopen the search dialog");
  await page.keyboard.press("Escape");
  await expect(page, !(await page.getByRole("dialog").isVisible()), "Escape did not dismiss the search dialog");

  await page.goto(`${baseUrl}/org/org-1`, { waitUntil: "domcontentloaded", timeout });
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Other" }).click();
  await page.waitForURL(/\/org\/org-2$/, { timeout });
  await expect(page, page.url().endsWith("/org/org-2"), "organization selector did not navigate to the chosen organization");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/org/org-1/documents`, { waitUntil: "domcontentloaded", timeout });
  await openApplicationNavigation(page);
  await page.getByRole("button", { name: "Close navigation" }).waitFor({ state: "visible", timeout });
  await page.screenshot({ path: path.join(outDir, "interaction-mobile-menu--390.png"), fullPage: true });
  await page.keyboard.press("Escape");
  if (await page.getByRole("button", { name: "Close navigation" }).isVisible()) failures.push("Escape did not dismiss the mobile navigation drawer");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/org/org-1/documents`, { waitUntil: "domcontentloaded", timeout });
  await waitForMeaningfulPage(page, "/org/org-1/documents");
  const tree = page.locator(".document-sidebar__tree");
  const mainScroll = await page.locator("main").evaluate(node => node.scrollTop);
  await tree.hover(); await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.querySelector(".document-sidebar__tree").scrollTop > 0);
  await expect(page, await page.locator("main").evaluate(node => node.scrollTop) === mainScroll, "document tree scroll moved the document page");
  await tree.evaluate(node => { node.scrollTop = 0; });
  const resize = page.getByRole("separator", { name: "Resize document navigation" });
  await resize.focus(); await page.keyboard.press("End");
  await expect(page, await resize.getAttribute("aria-valuenow") === "480", "document pane keyboard resize missed upper bound");
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowLeft");
  await expect(page, await resize.getAttribute("aria-valuenow") === "180", "document pane keyboard resize exceeded lower bound");
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Actions for Getting started", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename folder", exact: true }).click();
  await page.getByRole("textbox", { name: "Rename Getting started", exact: true }).waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(outDir, "interaction-folder-rename.png"), fullPage: true });
  await page.locator(".document-sidebar").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Actions for Getting started", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move folder", exact: true }).click();
  await page.getByRole("combobox", { name: "Move Getting started to", exact: true }).waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(outDir, "interaction-folder-move.png"), fullPage: true });
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
  await collapse.click();
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor({ state: "visible", timeout });
  await page.screenshot({ path: path.join(outDir, "interaction-desktop-sidebar-collapsed.png"), fullPage: true });
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  const next = page.getByRole("button", { name: /next/i }).first();
  if (await next.count()) {
    await next.click();
    await page.waitForTimeout(150);
    await expect(page, !page.url().includes("page=1"), "table paging did not advance from page one");
  } else {
    failures.push("table paging control not found on the populated document route");
  }

  const scopedTableRequests = requests.filter((item) => item.page.startsWith("/org/org-1") && item.pathname.includes("/api/tables/"));
  await expect(page, scopedTableRequests.length > 0, "organization route did not request fixture tables");
  const scopedDataQuery = scopedTableRequests.find((item) => item.pathname.includes("docs-documents") && item.where?.organization_id === "org-1");
  await expect(page, Boolean(scopedDataQuery), "organization document query omitted where.organization_id=org-1");
}

async function assetGridSearchChecks(page) {
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await page.goto(`${baseUrl}/org/org-1/assets`, { waitUntil: "domcontentloaded", timeout });
    await waitForMeaningfulPage(page, "/org/org-1/assets");
    await page.getByRole("textbox", { name: "Search flexible assets", exact: true }).fill("router");
    const table = page.getByRole("table", { name: "Flexible assets", exact: true });
    await table.waitFor({ state: "visible", timeout });
    await table.getByText("Northern Star router", { exact: true }).waitFor({ state: "visible", timeout });
    await expect(page, await page.locator("main").evaluate(node => node.scrollWidth <= node.clientWidth + 1), `asset search ${width}px: content overflow`);
    await page.screenshot({ path: path.join(outDir, `interaction-asset-search--${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await page.getByRole("button", { name: /^Network devices 1 record/ }).waitFor({ state: "visible", timeout });
    await expect(page, !(await table.isVisible()), `asset search ${width}px: clearing search did not restore the type grid`);
  }
}

async function assertOpenDialog(page, name, viewport) {
  const dialog = page.getByRole("dialog", { name });
  await expect(page, await dialog.isVisible(), `${name}: dialog did not open`);
  const bounds = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
  await expect(page, bounds.left >= 0 && bounds.top >= 0 && bounds.right <= viewport.width && bounds.bottom <= viewport.height,
    `${name} ${viewport.width}px: dialog exceeds viewport ${JSON.stringify(bounds)}`);
  const clipped = await dialog.evaluate((node) => [node, ...node.querySelectorAll(".bf-dialog__body, form")]
    .filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
    .map((element) => ({ className: element.className, width: element.clientWidth, scrollWidth: element.scrollWidth })));
  await expect(page, clipped.length === 0,
    `${name} ${viewport.width}px: dialog content requires horizontal scrolling ${JSON.stringify(clipped)}`);
  await page.keyboard.press("Tab");
  const focusedInDialog = await dialog.evaluate((node) => node.contains(document.activeElement));
  await expect(page, focusedInDialog, `${name} ${viewport.width}px: keyboard focus did not enter dialog`);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: path.join(outDir, `interaction-dialog-${safeName(name)}--${viewport.width}.png`), fullPage: true });
}

async function mobileEditorAndDialogChecks(browser) {
  // These deliberately stop before Save/Create/Move. The API fixture turns any
  // unexpected mutation into a visible 405, so the coverage remains read-only.
  for (const width of [320, 390]) {
    const viewport = { width, height: width === 320 ? 568 : 844 };
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const requests = [];
    const consoleErrors = [];
    const networkEvents = [];
    attachPageDiagnostics(page, consoleErrors, networkEvents);
    await installApiFixture(page, { role: "admin", requests });
    try {
      await page.goto(`${baseUrl}/org/org-1/documents/new`, { waitUntil: "domcontentloaded", timeout });
      await waitForMeaningfulPage(page, "/org/org-1/documents/new");
      const title = page.getByRole("textbox", { name: "Title" });
      await expect(page, await title.isVisible(), `new document ${width}px: title control is not visible`);
      await title.focus();
      await expect(page, await title.evaluate((node) => document.activeElement === node), `new document ${width}px: title cannot receive focus`);
      await expect(page, await page.getByRole("button", { name: /Create draft/i }).isVisible(), `new document ${width}px: create control is absent`);
      await assertKeyboardAndTouchTargets(page, "/org/org-1/documents/new", viewport);
      await page.screenshot({ path: path.join(outDir, `interaction-new-document--${width}.png`), fullPage: true });

      await page.goto(`${baseUrl}/org/org-1/documents/doc-1`, { waitUntil: "domcontentloaded", timeout });
      await waitForMeaningfulPage(page, "/org/org-1/documents/doc-1");
      await page.getByRole("button", { name: /^Edit$/ }).click();
      await assertOpenDialog(page, "Edit Document", viewport);
      await page.keyboard.press("Escape");
      await expect(page, !(await page.getByRole("dialog", { name: "Edit Document" }).isVisible()), `record editor ${width}px: Escape did not dismiss dialog`);

      await page.getByRole("button", { name: "Related items", exact: true }).click();
      const relatedPanel = page.getByRole("dialog", { name: "Related items", exact: true });
      await relatedPanel.waitFor({ state: "visible", timeout });
      await relatedPanel.getByRole("button", { name: "Add related item", exact: true }).click();
      await page.getByRole("textbox", { name: "Search query", exact: true }).fill("Network");
      await page.getByRole("button", { name: "Link Network guide", exact: true }).waitFor({ state: "visible", timeout });
      await expect(page, await page.getByLabel("Target source ID").count() === 0 && await page.getByLabel("Target Bifrost record ID").count() === 0, `related item ${width}px: internal identifiers are required`);
      await assertOpenDialog(page, "Add related item", viewport);
      await page.keyboard.press("Escape");

      await page.goto(`${baseUrl}/org/org-1/documents`, { waitUntil: "domcontentloaded", timeout });
      await waitForMeaningfulPage(page, "/org/org-1/documents");
      await page.getByRole("checkbox", { name: "Select row doc-1", exact: true }).click();
      await page.getByRole("button", { name: "Move selected" }).click();
      await assertOpenDialog(page, "Move selected documents?", viewport);
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page, !(await page.getByRole("dialog", { name: "Move selected documents?" }).isVisible()), `bulk move ${width}px: Cancel did not dismiss dialog`);
      await page.screenshot({ path: path.join(outDir, `interaction-bulk-move--${width}.png`), fullPage: true });

      const writes = requests.filter((item) => !["GET", "HEAD", "OPTIONS"].includes(item.method)
        && !(/^\/api\/tables\/[^/]+\/documents\/query$/.test(item.pathname))
        && !(item.pathname === "/api/workflows/execute" && ["functions/catalog.py::docs_list_organizations", "functions/migration.py::docs_migration_preflight", "functions/migration.py::docs_migration_status"].includes(item.workflow)));
      await expect(page, writes.length === 0, `mobile controls ${width}px sent mutation-shaped request(s): ${JSON.stringify(writes)}`);
    } catch (error) {
      await captureFailure(page, { routeName: "/org/org-1/documents", appearance: "mobile-dialog", viewport, error, requests, consoleErrors, networkEvents });
      failures.push(`mobile editor/dialog ${width}px: ${error.message}`);
    }
    await context.close();
  }
}

async function assetTypePickerChecks(browser) {
  for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"]) {
    const viewport = { width, height: width === 320 ? 568 : 844 };
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const requests = [];
    await installApiFixture(page, { role: "admin", requests });
    try {
      await page.goto(`${baseUrl}/org/org-1/assets`, { waitUntil: "domcontentloaded", timeout });
      await waitForMeaningfulPage(page, "/org/org-1/assets");
      await setSdkTheme(page, theme);
      await page.getByRole("button", { name: "New flexible asset", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Create Flexible asset", exact: true });
      const picker = dialog.getByRole("combobox", { name: "Asset type", exact: true });
      await picker.waitFor({ state: "visible", timeout });
      await page.waitForFunction(() => document.querySelector('[role=dialog] [role=combobox][aria-label="Asset type"]')?.getAttribute('aria-busy') !== 'true', undefined, { timeout });
      await picker.click();
      await page.getByRole("option", { name: "Network devices", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Servers", exact: true }).waitFor({ state: "visible", timeout });
      await expect(page, await dialog.getByLabel("Flexible asset type ID").count() === 0, `asset type ${width}px ${theme}: manual type ID remains`);
      await assertOpenDialog(page, "Create Flexible asset", viewport);
      await page.screenshot({ path: path.join(outDir, `interaction-asset-type-picker--${width}--${theme}.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden", timeout });
      await expect(page, !requests.some(request => request.method === "POST" && /\/documents$/.test(request.pathname)), "asset type picker wrote a record before submission");
    } catch (error) {
      await captureFailure(page, { routeName: "/org/org-1/assets", appearance: `asset-type-picker-${theme}`, viewport, error, requests });
      failures.push(`asset type picker ${width}px ${theme}: ${error.message}`);
    }
    await context.close();
  }
}

async function stateChecks(browser) {
  for (const [name, options, routeName, expected] of [
    ["loading", { state: "loading" }, "/org/org-1/documents", /Loading|Verifying/i],
    ["empty", { state: "empty" }, "/org/org-1/documents", /No records yet|No documents/i],
    ["error", { state: "error" }, "/org/org-1/documents", /could not load|Synthetic table failure/i],
    ["role-denied", { role: "reader" }, "/settings", /require administration access|administrator access required/i],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const requests = [];
    const consoleErrors = [];
    const networkEvents = [];
    attachPageDiagnostics(page, consoleErrors, networkEvents);
    await installApiFixture(page, { ...options, requests });
    try {
      await page.goto(`${baseUrl}${routeName}`, { waitUntil: "domcontentloaded", timeout });
      await page.getByText(expected).first().waitFor({ state: "visible", timeout });
      await page.screenshot({ path: path.join(outDir, `state-${name}.png`), fullPage: true });
    } catch (error) {
      await captureFailure(page, { routeName, appearance: `state-${name}`, viewport: { width: 1440, height: 1000 }, error, requests, consoleErrors, networkEvents });
      failures.push(`${name}: ${error.message}`);
    }
    await context.close();
  }
}

async function supportingStateChecks(page, appearance, viewport) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('.document-tools-layout[data-layout="docked"]').waitFor({ state: "visible", timeout });
  const attachmentCard = page.getByRole("region", { name: "Attachments", exact: true });
  await attachmentCard.waitFor({ state: "visible", timeout });
  await attachmentCard.getByLabel("Choose attachment").setInputFiles({ name: "unsaved-runbook.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic unsaved attachment") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.document-tools-layout[data-layout="drawer"]').waitFor({ state: "visible", timeout });
  await page.getByRole("button", { name: "Attachments", exact: true }).click();
  const attachmentDrawer = page.getByRole("dialog", { name: "Attachments", exact: true });
  await attachmentDrawer.waitFor({ state: "visible", timeout });
  await expect(page, await attachmentDrawer.getByRole("button", { name: "Drop a file or browse", exact: true }).textContent() === "unsaved-runbook.txt", "selected attachment was lost when switching to a phone drawer");
  await attachmentDrawer.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: path.join(outDir, `supporting-state--${appearance}--${viewport.width}--selected-upload.png`), fullPage: true });
  await page.keyboard.press("Escape");
  await attachmentDrawer.waitFor({ state: "hidden", timeout });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await attachmentCard.waitFor({ state: "visible", timeout });
  await expect(page, await attachmentCard.getByRole("button", { name: "Drop a file or browse", exact: true }).textContent() === "unsaved-runbook.txt", "selected attachment was lost after returning to the gutter");
  await page.getByRole("button", { name: "Add related item", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add related item", exact: true });
  await picker.waitFor({ state: "visible", timeout });
  const query = picker.getByLabel("Search query", { exact: true });
  await query.fill("Network");
  await query.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.document-tools-layout[data-layout="drawer"]').waitFor({ state: "visible", timeout });
  await expect(page, await picker.isVisible() && await query.inputValue() === "Network" && await query.evaluate(node => node === document.activeElement), "relationship picker or its focused query was lost during the phone transition");
  await picker.getByRole("button", { name: "Link Network guide", exact: true }).waitFor({ state: "visible", timeout });
  await picker.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: path.join(outDir, `supporting-state--${appearance}--${viewport.width}--relationship-picker.png`), fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('.document-tools-layout[data-layout="docked"]').waitFor({ state: "visible", timeout });
  await expect(page, await picker.isVisible() && await query.inputValue() === "Network", "relationship picker was lost after returning to the gutter");
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden", timeout });
  await attachmentCard.getByLabel("Choose attachment").setInputFiles([]);
  await page.setViewportSize(viewport);
}

async function supportingListChecks(page, routeName, appearance, viewport) {
  for (const [title, className, targetRole, targetName] of [
    ["Attachments", ".attachments", "button", "Download Evidence 205.txt"],
    ["Related items", ".related-items", "link", "Last linked runbook"],
  ]) {
    const documentReader = await page.locator('.document-reader').count() > 0;
    const docked = await page.locator('.document-tools-layout[data-layout="docked"]').count() > 0;
    if (documentReader && !docked) await page.getByRole("button", { name: title, exact: true }).click();
    const utility = page.locator(`${className}:visible`);
    if (!documentReader && await utility.evaluate(node => node.tagName === 'DETAILS' && !node.open)) await utility.locator('summary').click();
    await utility.getByRole(targetRole, { name: targetName, exact: true }).waitFor({ state: "attached", timeout });
    const list = utility.locator('ul');
    await expect(page, await list.locator('li').count() >= 205, `${routeName}: ${title} silently omitted later-page rows`);
    const bounds = await list.boundingBox();
    await expect(page, bounds.height <= 280 && bounds.height <= viewport.height * .4 + 1, `${routeName}: ${title} list crowds out its supporting card`);
    await utility.getByRole(targetRole, { name: targetName, exact: true }).scrollIntoViewIfNeeded();
    await expect(page, await list.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollTop > 0), `${routeName}: later ${title} rows cannot be reached in their own list`);
    await expect(page, await list.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${routeName}: scaled ${title} list overflows horizontally`);
    await page.screenshot({ path: path.join(outDir, `supporting-list--${safeName(routeName)}--${appearance}--${viewport.width}--${safeName(title)}.png`), fullPage: true });
    if (documentReader && !docked) { await page.keyboard.press("Escape"); await utility.waitFor({ state: "hidden", timeout }); }
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const distServer = await startDistServer();
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const requests = [];
  const consoleErrors = [];
  const networkEvents = [];
  attachPageDiagnostics(page, consoleErrors, networkEvents);
  await installApiFixture(page, { requests });

  const allRoutes = [
    "/browse", "/browse?type=passwords", "/browse?type=configurations", "/browse?type=locations", "/browse?type=flexible-assets", "/browse?type=flexible-asset-types", "/browse?type=document-folders", "/browse?type=password-folders",
    "/org/org-1/browse", "/org/org-1/flexible-asset-types", "/org/org-1/document-folders", "/org/org-1/password-folders", "/org/org-1/flexible-asset-types/asset-type-1", "/org/org-1/document-folders/folder-1", "/org/org-1/password-folders/password-folder-1", "/configuration-taxonomy", "/documents/new", "/audit-trail",
    "/", "/org/org-1", "/org/org-1/documents", "/org/org-1/documents/doc-1",
    "/org/org-1/documents/new",
    "/org/org-1/passwords", "/org/org-1/passwords/password-1", "/org/org-1/configurations", "/org/org-1/configurations/config-1",
    "/org/org-1/locations", "/org/org-1/locations/location-1", "/org/org-1/assets", "/org/org-1/assets/asset-type-1", "/org/org-1/assets/asset-type-1/asset-1",
    "/org/org-1/audit-trail", "/organizations", "/global", "/global/documents", "/global/passwords", "/global/configurations", "/global/locations", "/global/assets/asset-type-1", "/global/audit-trail",
    "/settings", "/settings/configuration-types", "/settings/configuration-statuses", "/settings/custom-asset-types", "/settings/knowledge", "/settings/backup", "/settings/ai", "/settings/exports", "/migration",
  ];
  const routes = routeFilter ? allRoutes.filter((routeName) => routeFilter.has(routeName)) : allRoutes;
  await expect(page, routes.length > 0, "QA_ROUTES did not match any defined browser route");
  if (widthFilter?.has(1920)) screenshotModes.push(["light", { width: 1920, height: 1080 }], ["dark", { width: 1920, height: 1080 }]);
  for (const width of [639, 640, 1024, 1280]) if (widthFilter?.has(width)) screenshotModes.push(["light", { width, height: 1000 }], ["dark", { width, height: 1000 }]);
  const modes = widthFilter ? screenshotModes.filter(([, viewport]) => widthFilter.has(viewport.width)) : screenshotModes;
  await expect(page, modes.length > 0, "QA_WIDTHS did not match a supported viewport");
  for (const routeName of routes) {
    for (const [appearance, viewport] of modes) {
      try {
        await screenshotRoute(page, routeName, appearance, viewport);
        if (process.env.QA_CATALOG_CURRENT === "1") await catalogCurrentChecks(page, routeName, appearance, viewport);
        if (process.env.QA_TAXONOMY_NAVIGATION === "1") await taxonomyNavigationChecks(page, routeName, appearance, viewport);
        if (process.env.QA_SUMMARY_COUNTS === "1") await summaryCountChecks(page, routeName, appearance, viewport);
        if (process.env.QA_DISABLED_LIST === "1") await disabledListChecks(page, routeName, appearance, viewport);
        if (process.env.QA_DETAIL_ENABLED === "1") await detailEnabledChecks(page, routeName, appearance, viewport);
        if (process.env.QA_BACKUP_ENTRY === "1") await backupEntryChecks(page, routeName, appearance, viewport);
        if (process.env.QA_SUPPORTING_LIST_SCALE === "1") await supportingListChecks(page, routeName, appearance, viewport);
        if (process.env.QA_SUPPORTING_STATE === "1" && routeName === "/org/org-1/documents/doc-1") await supportingStateChecks(page, appearance, viewport);
        if (process.env.QA_SEARCH_STABILITY === "1" && routeName === "/org/org-1/documents") await searchResultStabilityChecks(page, appearance, viewport);
        if (process.env.QA_FOLDER_NAVIGATION === "1" && routeName === "/org/org-1/documents") await folderNavigationChecks(page, appearance, viewport);
        if (process.env.QA_FOLDER_STATE === "1" && routeName === "/org/org-1/documents/doc-1") await folderNavigationStateChecks(page, appearance, viewport);
      }
      catch (error) {
        await captureFailure(page, { routeName, appearance, viewport, error, requests, consoleErrors, networkEvents });
        failures.push(`${routeName} ${appearance}: ${error.message}`);
      }
    }
  }
  if (!routeFilter || process.env.QA_INTERACTIONS === "1") {
    try { await interactionChecks(page, requests); } catch (error) {
      await captureFailure(page, { routeName: new URL(page.url()).pathname, appearance: "interaction", viewport: page.viewportSize() || { width: 1440, height: 1000 }, error, requests, consoleErrors, networkEvents });
      failures.push(`interaction checks: ${error.message}`);
    }
    try { await assetGridSearchChecks(page); } catch (error) { failures.push(`asset grid search: ${error.message}`); }
    try { await mobileEditorAndDialogChecks(browser); } catch (error) { failures.push(`mobile editor/dialog checks: ${error.message}`); }
    try { await assetTypePickerChecks(browser); } catch (error) { failures.push(`asset type picker checks: ${error.message}`); }
    try { await stateChecks(browser); } catch (error) { failures.push(`state checks: ${error.message}`); }
  }
  if (consoleErrors.length) failures.push(...consoleErrors.map((message) => `browser error: ${message}`));
  await context.close();
  await browser.close();
  if (distServer) await new Promise((resolve) => distServer.close(resolve));

  const uniqueFailures = [...new Set(failures)];
  const touchTargets = new Map();
  const failureGroups = uniqueFailures.reduce((groups, failure) => {
    const targetMatch = failure.match(/undersized touch targets (\[.*\])$/);
    if (targetMatch) {
      try {
        for (const target of JSON.parse(targetMatch[1])) {
          const key = `${target.tag} ${target.label} ${target.width}x${target.height}`;
          const current = touchTargets.get(key) || { count: 0, example: failure.split(": undersized", 1)[0] };
          current.count += 1;
          touchTargets.set(key, current);
        }
        return groups;
      } catch { /* retain malformed diagnostics below */ }
    }
    const category = failure.startsWith("forbidden write:") ? "unexpected API writes"
      : failure.startsWith("unhandled API request:") ? "unhandled API requests"
      : /exceeds viewport/.test(failure) ? "mobile geometry"
      : /Tab did not move focus|keyboard focus|Escape did not|Cancel did not/.test(failure) ? "keyboard and dismissal"
      : failure.startsWith("browser error:") ? "browser errors" : "route and interaction assertions";
    (groups[category] ||= []).push(failure);
    return groups;
  }, {});
  if (touchTargets.size) {
    failureGroups["undersized touch targets"] = [...touchTargets.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .map(([target, detail]) => `${target} (${detail.count} route/theme captures; e.g. ${detail.example})`);
  }
  const summary = { baseUrl, outDir, routes: routes.length, modes: modes.map(([appearance, viewport]) => ({ appearance, width: viewport.width })), requests: requests.map(({ method, pathname, page, where, workflow, pending }) => ({ method, pathname, page, where, workflow, pending })), failures: uniqueFailures, failureGroups };
  fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (uniqueFailures.length) {
    const compact = Object.entries(failureGroups).map(([category, entries]) => {
      const shown = entries.slice(0, 6).map((entry) => `  - ${entry}`).join("\n");
      return `${category} (${entries.length})\n${shown}${entries.length > 6 ? `\n  - … ${entries.length - 6} more unique failures in summary.json` : ""}`;
    }).join("\n");
    console.error(`Browser QA failed (${uniqueFailures.length} unique):\n${compact}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Browser QA passed: ${routes.length} routes, ${modes.length} viewport/theme modes each. Evidence: ${outDir}`);
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
