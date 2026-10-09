import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function readBifrostEnv() {
  // `solution start` deliberately supplies `/` plus a short-lived proxy token.
  // A raw Vite run may read only this Solution's instance binding and must
  // receive its token explicitly; never borrow credentials from another profile.
  const proxied = process.env.BIFROST_API_URL === "/";
  const out = {
    url: proxied ? "/" : "",
    token: proxied ? process.env.BIFROST_ACCESS_TOKEN || "" : "",
    solutionId: process.env.BIFROST_SOLUTION_ID || "",
  };
  const appDir = dirname(fileURLToPath(import.meta.url));
  const envPath = join(appDir, "..", "..", ".env");
  if (!proxied && existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*(BIFROST_API_URL|BIFROST_SOLUTION_ID)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (match[1] === "BIFROST_API_URL") out.url = value;
      else out.solutionId = value;
    }
  }
  return out;
}

export default defineConfig(({ command }) => {
  const env = readBifrostEnv();
  const define = command === "serve" ? {
    "import.meta.env.VITE_BIFROST_API_URL": JSON.stringify(env.url),
    "import.meta.env.VITE_BIFROST_TOKEN": JSON.stringify(env.token),
    "import.meta.env.VITE_BIFROST_APP_ID": JSON.stringify(process.env.VITE_BIFROST_APP_ID || ""),
    "import.meta.env.VITE_BIFROST_ORG_ID": JSON.stringify(process.env.VITE_BIFROST_ORG_ID || null),
    "import.meta.env.VITE_BIFROST_SOLUTION_ID": JSON.stringify(process.env.VITE_BIFROST_SOLUTION_ID || env.solutionId),
  } : {};
  return { plugins: [react(), tailwindcss()], resolve: { alias: { "@": resolve(dirname(fileURLToPath(import.meta.url)), "src") } }, define };
});
