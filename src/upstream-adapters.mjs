import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { hash, insist } from "./contracts.mjs";
/** Hash executable/rule files without copying canon. Ignore install artifacts. */
export function upstreamDigest(root, folders) {
  const records = [];
  function walk(p, rel) {
    const stat = lstatSync(p);
    insist(!stat.isSymbolicLink(), "Upstream symlink refused");
    if (stat.isDirectory()) {
      for (const f of readdirSync(p).sort()) walk(join(p, f), `${rel}/${f}`);
    } else {
      insist(stat.size < 5000000, "Upstream file too large");
      records.push([rel, hash(readFileSync(p))]);
    }
  }
  for (const folder of folders) {
    insist(
      !folder.includes("..") && !folder.startsWith("/"),
      "Invalid upstream folder",
    );
    walk(join(root, folder), folder);
  }
  return hash(records);
}
// Native ESM imports are cached by path. Never reuse a mutable installation root
// for a different checksum within this process; install new pins in new roots.
const loadedRoots = new Map();
function bindRoot(root, sha256) {
  root = realpathSync(root);
  insist(!loadedRoots.has(root) || loadedRoots.get(root) === sha256,
    "Upstream root already loaded with another pin; use an immutable install root");
  loadedRoots.set(root, sha256);
  return root;
}
export function designSystemDigest(root) {
  return hash(["aindf.json", "src", "generated"].map(folder => [folder,
    existsSync(join(root, folder)) ? upstreamDigest(root, [folder]) : null]));
}
export async function loadAindf({ root, sha256, packageVersion }) {
  insist(
    upstreamDigest(root, ["cli", "schemas", "package.json"]) === sha256,
    "AINDF upstream checksum mismatch",
  );
  root = bindRoot(root, sha256);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  insist(
    pkg.name === "aindf" && pkg.version === packageVersion,
    "AINDF package identity mismatch",
  );
  const load = (p) => import(pathToFileURL(resolve(root, p)).href);
  const [{ loadDS }, { validateModel }, { buildTools }, { AINDF_VERSION }] =
    await Promise.all([
      load("cli/src/lib/validator/load.js"),
      load("cli/src/lib/validator/index.js"),
      load("cli/src/lib/mcp/tools.js"),
      load("cli/src/lib/version.js"),
    ]);
  return {
    packageVersion,
    frameworkVersion: AINDF_VERSION,
    async evaluate(input) {
      const { mode, artifact, designSystem, requiredRules, upstream } = structuredClone(input);
      insist(["ds-readiness", "ui-compliance"].includes(mode), "Unknown DS mode");
      const checkPins = () => {
        insist(upstream.sha256 === sha256 && upstreamDigest(root, ["cli", "schemas", "package.json"]) === sha256,
          "AINDF upstream checksum mismatch");
        insist(designSystem?.sha256 && designSystemDigest(designSystem.path) === designSystem.sha256,
          "Design system checksum mismatch");
      };
      checkPins();
      insist(
        upstream.version === AINDF_VERSION,
        "Framework version differs from requested pin",
      );
      const subjectHash = mode === "ds-readiness" ? designSystem.sha256 :
        hash({designSystemSha256:designSystem.sha256,sections:designSystem.sections ?? null});
      insist(artifact.sha256 === subjectHash, "AINDF subject hash mismatch");
      const model = loadDS(designSystem.path);
      // The RC validator skips absent contracts: an empty directory can otherwise
      // produce vacuous passing levels. Require an actual DS subject first.
      insist(model.manifest && Object.values(model.contracts ?? {}).some(Boolean),
        "Missing design system inputs");
      let findings = [];
      if (mode === "ds-readiness") {
        const report = validateModel(model);
        findings = requiredRules.map((rule) => {
          const level = report.levels[rule];
          return {
            rule,
            type: "hard",
            outcome: level ? (level.pass ? "pass" : "fail") : "unknown",
            evidence: level ? { reportHash: hash(report), level } : null,
          };
        });
      } else {
        const tools = buildTools(model);
        const sections = designSystem.sections;
        if (!Array.isArray(sections) || !sections.length)
          return {
            upstreamVersion: AINDF_VERSION,
            upstreamSha256: sha256,
            designSystemHash: designSystem.sha256,
            artifactHash: artifact.sha256,
            revision: artifact.revision,
            findings: [],
          };
        const result = tools.validateComposition.run(
          { sections },
          { verbose: true },
        );
        findings = requiredRules.map((rule) => ({
          rule,
          type: "hard",
          outcome:
            rule === "composition-contract"
              ? result.ok
                ? "pass"
                : "fail"
              : "unknown",
          evidence:
            rule === "composition-contract"
              ? { reportHash: hash(result), findings: result.findings }
              : null,
        }));
      }
      checkPins();
      return {
        upstreamVersion: AINDF_VERSION,
        upstreamSha256: sha256,
        designSystemHash: designSystem.sha256,
        artifactHash: artifact.sha256,
        revision: artifact.revision,
        findings,
      };
    },
  };
}
export async function loadUnslop({ root, sha256, packageVersion }) {
  insist(
    upstreamDigest(root, ["scripts", "references", "package.json"]) === sha256,
    "Unslop upstream checksum mismatch",
  );
  root = bindRoot(root, sha256);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  insist(
    pkg.name === "unslop" && pkg.version === packageVersion,
    "Unslop package identity mismatch",
  );
  const { detect } = await import(
    pathToFileURL(resolve(root, "scripts/detect.mjs")).href
  );
  const { selectRules } = await import(pathToFileURL(resolve(root, "scripts/rules/index.mjs")).href);
  return {
    async evaluate(input) {
      const { artifact, requiredRules, upstream } = structuredClone(input);
      const checkPins = () => {
        insist(upstream.sha256 === sha256 && upstreamDigest(root, ["scripts", "references", "package.json"]) === sha256,
          "Unslop upstream checksum mismatch");
        insist(hash(readFileSync(artifact.path)) === artifact.sha256, "Artifact hash mismatch");
      };
      checkPins();
      insist(upstream.version === packageVersion, "Canon version mismatch");
      insist(
        hash(readFileSync(artifact.path)) === artifact.sha256,
        "Artifact hash mismatch",
      );
      const findings = [];
      for (const rule of requiredRules) {
        try {
          const selected = selectRules([rule]);
          const definition = selected.length === 1 && selected[0].id === rule ? selected[0] : null;
          const applicable = definition && ["red", "orange", "white"].includes(definition.severity) &&
            (!definition.fileTypes?.length || definition.fileTypes.includes(extname(artifact.path).toLowerCase())) &&
            (typeof definition.test === "function" || typeof definition.testFile === "function");
          if (!applicable) {
            findings.push({rule, type:"hard", outcome:"unknown", evidence:null});
            continue;
          }
          const result = detect(artifact.path, { rules: [rule] });
          findings.push({
            rule,
            type: definition.severity === "red" ? "hard" : "soft",
            outcome: result.scanned > 0 && result.rulesRun === 1
              ? result.findings.some(f => f.rule === rule) ? "fail" : "pass" : "unknown",
            evidence: { reportHash: hash(result), findings: result.findings, severity:definition.severity },
          });
        } catch {
          findings.push({
            rule,
            type: "hard",
            outcome: "unknown",
            evidence: null,
          });
        }
      }
      checkPins();
      return {
        upstreamVersion: packageVersion,
        upstreamSha256: sha256,
        artifactHash: artifact.sha256,
        revision: artifact.revision,
        findings,
      };
    },
  };
}
