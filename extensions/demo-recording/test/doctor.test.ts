import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { type DoctorProbes, formatDoctor, runDoctor } from "../src/doctor.ts";

const SECRET = "sk-super-secret-value-123";

function probes(over: Partial<DoctorProbes> = {}): Partial<DoctorProbes> {
  return {
    run: (cmd, args) => {
      if (cmd === "ffmpeg" && args.includes("-encoders"))
        return { status: 0, stdout: " V....D libx264  H.264" };
      return { status: 0, stdout: `${cmd} version 1.2.3\nmore` };
    },
    env: { ELEVENLABS_API_KEY: SECRET, OPENAI_API_KEY: SECRET },
    nodeVersion: "24.1.0",
    chromiumPath: async () => "/fake/chromium",
    exists: () => true,
    freeBytes: () => 50 * 1024 ** 3,
    ensureWritable: () => {},
    ...over,
  };
}

const cfg = { ...defaultConfig("/home/t"), voiceName: "Stefan v2" };

test("all green with everything present; key values never appear in output", async () => {
  const results = await runDoctor(cfg, probes());
  assert.ok(
    results.every((r) => r.status === "pass"),
    formatDoctor(results),
  );
  const text = formatDoctor(results);
  assert.ok(!text.includes(SECRET), "API key values must never be printed");
  assert.match(text, /all required checks pass/);
});

test("missing ffmpeg / chromium / old node are failures with fix hints", async () => {
  const results = await runDoctor(
    cfg,
    probes({
      run: (cmd) => (cmd === "uv" ? { status: 0, stdout: "uv 0.5" } : undefined),
      chromiumPath: async () => undefined,
      nodeVersion: "20.11.0",
    }),
  );
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(byName.node?.status, "fail");
  assert.equal(byName.ffmpeg?.status, "fail");
  assert.match(byName.ffmpeg?.detail ?? "", /brew install ffmpeg/);
  assert.equal(byName.chromium?.status, "fail");
  assert.match(byName.chromium?.detail ?? "", /playwright install chromium/);
  assert.match(formatDoctor(results), /failing/);
});

test("ffmpeg without libx264 fails; missing keys/uv/voice/low disk are warnings", async () => {
  const results = await runDoctor(
    { ...cfg, voiceName: "" },
    probes({
      run: (cmd, args) => {
        if (cmd === "uv") return undefined;
        if (args.includes("-encoders")) return { status: 0, stdout: "only vp8" };
        return { status: 0, stdout: "ffmpeg version 7" };
      },
      env: {},
      freeBytes: () => 1024 ** 3,
    }),
  );
  const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
  assert.equal(byName.ffmpeg, "fail");
  for (const name of ["uv", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "voice", "disk"]) {
    assert.equal(byName[name], "warn", name);
  }
});

test("unwritable workdir fails", async () => {
  const results = await runDoctor(
    cfg,
    probes({
      ensureWritable: () => {
        throw new Error("EACCES");
      },
    }),
  );
  assert.equal(results.find((r) => r.name === "workdir")?.status, "fail");
});

test("a configured brand that is not under the working folder is a warning that says what renders use instead (R2-8)", async () => {
  const gone = await runDoctor(
    { ...cfg, brand: "datadog-poc", root: "/tmp/no-such-folder-for-brands" },
    probes(),
  );
  const b = gone.find((r) => r.name === "brand");
  assert.equal(b?.status, "warn");
  assert.match(
    b?.detail ?? "",
    /"datadog-poc" is not under \/tmp\/no-such-folder-for-brands\/brands .* renders use neutral instead/,
  );
  // the built-in is always there
  const fine = await runDoctor(
    { ...cfg, brand: "neutral", root: "/tmp/no-such-folder-for-brands" },
    probes(),
  );
  assert.equal(fine.find((r) => r.name === "brand")?.status, "pass");
});
