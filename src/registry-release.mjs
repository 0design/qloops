import { readFileSync, writeFileSync, lstatSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { hash, insist } from "./contracts.mjs";
import { parseYaml } from "./yaml.mjs";
import { validateManifest } from "./manifest.mjs";
export async function readAsset(base, path) {
  insist(
    /^(catalog\.json|(?:loops|components|demos|authors|examples)\/[a-z0-9-]+\.(?:yaml|json|txt))$/.test(
      path,
    ),
    "Unsafe registry asset path",
  );
  if (/^https?:\/\//.test(base)) {
    const url = new URL(base);
    insist(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          ["127.0.0.1", "localhost"].includes(url.hostname)),
      "Registry requires HTTPS (HTTP is localhost-only)",
    );
    const response = await fetch(`${base.replace(/\/$/, "")}/${path}`, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    insist(
      response.ok,
      `Registry HTTP ${response.status}`,
      "REGISTRY_UNAVAILABLE",
    );
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2000000) {
        await reader.cancel();
        throw new Error("Registry asset too large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  insist(isAbsolute(base), "Registry must be absolute directory or HTTPS URL");
  let p = base;
  insist(!lstatSync(p).isSymbolicLink(), "Unsafe registry directory");
  for (const part of path.split("/")) {
    p = join(p, part);
    insist(!lstatSync(p).isSymbolicLink(), "Unsafe registry symlink");
  }
  insist(lstatSync(p).size <= 2000000, "Registry asset too large");
  return readFileSync(p);
}
export async function loadRelease(base, sha256) {
  insist(/^[a-f0-9]{64}$/.test(sha256), "Explicit catalog SHA256 required");
  const bytes = await readAsset(base, "catalog.json");
  insist(
    hash(bytes) === sha256,
    "Catalog checksum mismatch",
    "CHECKSUM_MISMATCH",
  );
  const catalog = JSON.parse(bytes.toString("utf8"));
  insist(catalog && typeof catalog === "object" && !Array.isArray(catalog), "Invalid catalog");
  insist(
    typeof catalog.releaseVersion === "string" && catalog.releaseVersion.trim() && Array.isArray(catalog.loops),
    "Versioned release required",
  );
  insist(
    catalog.core?.manifest === "qloops.loop/v1",
    "Incompatible manifest contract",
    "ENGINE_INCOMPATIBLE",
  );
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  insist(
    catalog.core?.package === "qloops" && catalog.core.version === pkg.version,
    "Registry must pin installed engine version",
    "ENGINE_INCOMPATIBLE",
  );
  const seen = new Set();
  for (const section of ["loops", "components", "demos"]) {
    insist(catalog[section] === undefined || (Array.isArray(catalog[section]) && catalog[section].length <= 1000), "Invalid registry section");
    for (const e of catalog[section] ?? []) {
      insist(e && typeof e === "object" && !Array.isArray(e), "Invalid registry entry");
      insist(e.dependencies === undefined || (Array.isArray(e.dependencies) && e.dependencies.length <= 100 &&
        e.dependencies.every(d => d && typeof d.id === "string" && /^[a-z0-9-]+$/.test(d.id) &&
          /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(d.version ?? ""))), "Dependencies require exact identities");
      if (e.file !== undefined)
        insist(e.file === `${section}/${e.id}.${section === "loops" ? "yaml" : "json"}`, "Registry file must match its section and identity");
      insist(
        typeof e.id === "string" && /^[a-z0-9-]+$/.test(e.id) &&
          /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(e.version ?? ""),
        "Invalid registry identity",
      );
      insist(!seen.has(`${section}/${e.id}`), "Duplicate registry identity");
      seen.add(`${section}/${e.id}`);
      insist(typeof e.sha256 === "string" && /^[a-f0-9]{64}$/.test(e.sha256), "Missing artifact checksum");
      if (e.engine !== undefined)
        insist(e.engine?.package === catalog.core.package && e.engine?.version === catalog.core.version &&
          e.engine?.manifest === catalog.core.manifest, "Entry engine differs from release pin", "ENGINE_INCOMPATIBLE");
    }
  }
  return catalog;
}
export async function installPinned({
  base,
  catalogSha256,
  id,
  version,
  destination,
}) {
  const catalog = await loadRelease(base, catalogSha256);
  const entry = catalog.loops.find((e) => e.id === id && e.version === version);
  insist(entry, "Pinned loop not found", "VERSION_NOT_FOUND");
  const resolved = [];
  const visiting = new Set();
  async function verify(e, section = "loops") {
    const key = `${section}/${e.id}@${e.version}`;
    if (resolved.some((x) => x.key === key)) return;
    insist(!visiting.has(key), "Dependency cycle");
    visiting.add(key);
    const path = e.file ?? `${section}/${e.id}.${section === "loops" ? "yaml" : "json"}`;
    const bytes = await readAsset(base, path);
    insist(
      hash(bytes) === e.sha256,
      `Artifact checksum mismatch: ${e.id}`,
      "CHECKSUM_MISMATCH",
    );
    for (const dep of e.dependencies ?? []) {
      const matches = [
        ...(catalog.components ?? []).map((e) => [e, "components"]),
        ...catalog.loops.map((e) => [e, "loops"]),
      ].filter(([x]) => x.id === dep.id && x.version === dep.version);
      insist(
        matches.length > 0,
        `Unresolved pinned dependency: ${dep.id}`,
        "VERSION_NOT_FOUND",
      );
      insist(matches.length === 1, `Ambiguous pinned dependency: ${dep.id}`, "AMBIGUOUS_DEPENDENCY");
      await verify(...matches[0]);
    }
    visiting.delete(key);
    resolved.push({ key, path, sha256: e.sha256 });
    return bytes;
  }
  const bytes = await verify(entry);
  const parsed = parseYaml(bytes.toString("utf8"));
  validateManifest(parsed);
  insist(
    parsed.id === id && parsed.version === version,
    "Manifest identity mismatch",
  );
  insist(
    !existsSync(destination) && !existsSync(destination + ".lock.json"),
    "Destination exists; refusing overwrite",
  );
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(
    destination + ".lock.json",
    JSON.stringify(
      {
        protocolVersion: "qf.registry-lock/v1",
        base,
        catalogSha256,
        releaseVersion: catalog.releaseVersion,
        id,
        version,
        resolved,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return {
    id,
    version,
    path: resolve(destination),
    sha256: entry.sha256,
    dependencies: resolved,
  };
}
