import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../src/contracts.mjs";
import { installPinned } from "../src/registry-release.mjs";
test("independent pinned catalog -> checksum -> validate -> install; corruption rejected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qloops-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "loops"));
  const body =
    "manifest: qloops.loop/v1\nid: synthetic\nversion: 1.0.0\nsteps:\n  - id: gate\n    kind: approval-gate\n    config: { reviewer: human }\n";
  writeFileSync(join(dir, "loops/synthetic.yaml"), body);
  const catalog = JSON.stringify({
    releaseVersion: "fixture.1",
    core: {
      package: "qloops",
      version: JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url)),
      ).version,
      manifest: "qloops.loop/v1",
    },
    loops: [
      {
        id: "synthetic",
        version: "1.0.0",
        file: "loops/synthetic.yaml",
        sha256: hash(body),
        dependencies: [],
      },
    ],
  });
  writeFileSync(join(dir, "catalog.json"), catalog);
  const request = {
    base: dir,
    catalogSha256: hash(catalog),
    id: "synthetic",
    version: "1.0.0",
    destination: join(dir, "installed.yaml"),
  };
  assert.equal((await installPinned(request)).sha256, hash(body));
  assert.equal(readFileSync(request.destination, "utf8"), body);
  await assert.rejects(installPinned(request), /Destination exists/);
  await assert.rejects(installPinned({ ...request, version: "2.0.0" }), {
    code: "VERSION_NOT_FOUND",
  });
  await assert.rejects(
    installPinned({ ...request, catalogSha256: "0".repeat(64) }),
    { code: "CHECKSUM_MISMATCH" },
  );
  writeFileSync(join(dir, "loops/synthetic.yaml"), body + "# tamper");
  await assert.rejects(installPinned(request), { code: "CHECKSUM_MISMATCH" });
});

test("localhost catalog transport verifies exact bytes and refuses remote plaintext", async (t) => {
  const { createServer } = await import("node:http");
  const { readAsset } = await import("../src/registry-release.mjs");
  const server = createServer((req, res) => res.end("fixture catalog"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  assert.equal(
    (
      await readAsset(
        `http://127.0.0.1:${server.address().port}`,
        "catalog.json",
      )
    ).toString(),
    "fixture catalog",
  );
  await assert.rejects(
    readAsset("http://example.com", "catalog.json"),
    /HTTPS/,
  );
  await assert.rejects(readAsset("http://127.0.0.1", "../secret"), /Unsafe/);
});

test('dependency graph rejects ambiguity, cycles, malformed sections and mismatched paths before writing',async t=>{
  const {existsSync}=await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'qloops-graph-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'loops'));mkdirSync(join(dir,'components'));
  const body='manifest: qloops.loop/v1\nid: target\nversion: 1.0.0\nsteps:\n  - id: gate\n    kind: approval-gate\n    config: { reviewer: human }\n';
  writeFileSync(join(dir,'loops/target.yaml'),body);
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
  const loop={id:'target',version:'1.0.0',file:'loops/target.yaml',sha256:hash(body),dependencies:[]};
  const base={releaseVersion:'test.1',core:{package:'qloops',version:pkg.version,manifest:'qloops.loop/v1'},loops:[loop],components:[]};
  const cases=[
    [{...base,loops:[{...loop,dependencies:[{id:'target',version:'1.0.0'}]}]},/cycle/],
    [{...base,loops:[{...loop,dependencies:[{id:'target',version:'1.0.0'}]}],components:[{...loop,file:'components/target.json'}]},/Ambiguous/],
    [{...base,loops:[{...loop,dependencies:[{id:'missing',version:'1.0.0'}]}]},/Unresolved/],
    [{...base,components:{}},/section/],
    [{...base,loops:[{...loop,dependencies:{}}]},/Dependencies/],
    [{...base,loops:[{...loop,dependencies:[{id:'missing',version:'latest'}]}]},/Dependencies/],
    [{...base,loops:[{...loop,file:'components/target.json'}]},/section and identity/],
    [{...base,loops:[{...loop,engine:{...base.core,version:'different'}}]},/engine differs/],
  ];
  for(const [catalog,error] of cases){
    const bytes=JSON.stringify(catalog);writeFileSync(join(dir,'catalog.json'),bytes);
    const destination=join(dir,'result.yaml');
    await assert.rejects(installPinned({base:dir,catalogSha256:hash(bytes),id:'target',version:'1.0.0',destination}),error);
    assert.equal(existsSync(destination),false);assert.equal(existsSync(destination+'.lock.json'),false);
  }
});
