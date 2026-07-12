import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateStaticRunnerReport } from "../src/runner-report.ts";

test("generateStaticRunnerReport writes escaped static HTML from copied artifacts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, "status.json"), JSON.stringify({ status: "done", summary: "<done>" }), "utf8");
  writeFileSync(join(dir, "iterations.jsonl"), JSON.stringify({ iteration: 1, summary: "<script>alert(1)</script>", progress: true }) + "\n", "utf8");
  writeFileSync(join(dir, "events.jsonl"), JSON.stringify({ type: "note", message: "use <b>bold</b>" }) + "\n", "utf8");

  const result = generateStaticRunnerReport(dir);

  assert.equal(result.iterations, 1);
  assert.equal(result.events, 1);
  assert.equal(result.reportPath, join(dir, "report.html"));
  assert.equal(existsSync(result.reportPath), true);
  const html = readFileSync(result.reportPath, "utf8");
  assert.match(html, /Ralph Loop Dossier/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /use &lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("generateStaticRunnerReport renders an operator dossier instead of a generic dashboard", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-dossier-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, "status.json"), JSON.stringify({
    status: "complete",
    currentIteration: 2,
    maxIterations: 3,
    taskDir: "/repo/task-<x>",
    startedAt: "2026-05-04T00:00:00.000Z",
    completedAt: "2026-05-04T00:00:05.000Z",
  }), "utf8");
  writeFileSync(join(dir, "iterations.jsonl"), [
    JSON.stringify({ iteration: 1, status: "complete", progress: true, changedFiles: ["src/a.ts"], durationMs: 1200, completionGate: { ready: false, reasons: ["not yet"] } }),
    JSON.stringify({ iteration: 2, status: "complete", progress: false, changedFiles: [], durationMs: 3400, completionGate: { ready: true, reasons: [] }, completion: { promiseSeen: true } }),
  ].join("\n") + "\n", "utf8");
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({ type: "runner.started", timestamp: "2026-05-04T00:00:00.000Z" }),
    JSON.stringify({ type: "completion_gate_passed", timestamp: "2026-05-04T00:00:05.000Z", ready: true }),
  ].join("\n") + "\n", "utf8");
  mkdirSync(join(dir, "transcripts"));
  writeFileSync(join(dir, "transcripts", "iteration-001-safe.md"), "transcript", "utf8");

  const result = generateStaticRunnerReport(dir);
  const html = readFileSync(result.reportPath, "utf8");

  assert.match(html, /<title>Ralph Loop Dossier<\/title>/);
  assert.match(html, /class="page dossier-page"/);
  assert.match(html, /class="toc"/);
  assert.match(html, /class="cover"/);
  assert.match(html, /Static audit packet/);
  assert.match(html, /class="stamp stamp-good">COMPLETE<\/strong>/);
  assert.match(html, /class="fact-grid"/);
  assert.match(html, /<dt>Case ID<\/dt>/);
  assert.match(html, /Operator summary/);
  assert.match(html, /Run completed and the completion gate cleared\./);
  assert.match(html, /Completion gate/);
  assert.match(html, /Guardrails &amp; scope/);
  assert.match(html, /Iteration ledger/);
  assert.match(html, /File evidence/);
  assert.match(html, /Event trace/);
  assert.match(html, /Raw evidence vault/);
  assert.match(html, /href="transcripts\/iteration-001-safe\.md"/);
  assert.match(html, /src\/a\.ts/);
  assert.match(html, /task-&lt;x&gt;/);
  assert.doesNotMatch(html, /task-<x>/);
  assert.doesNotMatch(html, /metric-grid/);
  assert.ok(html.indexOf("Operator summary") < html.indexOf("Raw evidence vault"));
});

test("generateStaticRunnerReport renders stopped runs as operator-stopped", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-stopped-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, "status.json"), JSON.stringify({ status: "stopped", currentIteration: 2, maxIterations: 5 }), "utf8");
  writeFileSync(join(dir, "iterations.jsonl"), JSON.stringify({ iteration: 2, status: "stopped", completionGate: { ready: false, reasons: ["operator stopped"] } }) + "\n", "utf8");

  const result = generateStaticRunnerReport(dir);
  const html = readFileSync(result.reportPath, "utf8");

  assert.match(html, /class="stamp stamp-info">STOPPED<\/strong>/);
  assert.match(html, /class="status status-info">stopped<\/span>/);
  assert.match(html, /Run was stopped by operator control after the current iteration\./);
  assert.doesNotMatch(html, /Run state is unverified/);
});

test("generateStaticRunnerReport escapes summary and message list labels", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-labels-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, "iterations.jsonl"), JSON.stringify({ summary: "<img src=x onerror=alert(1)>" }) + "\n", "utf8");
  writeFileSync(join(dir, "events.jsonl"), JSON.stringify({ message: "<svg onload=alert(1)>" }) + "\n", "utf8");

  const result = generateStaticRunnerReport(dir);
  const html = readFileSync(result.reportPath, "utf8");

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(html, /<svg onload=alert\(1\)>/);
});

test("generateStaticRunnerReport rejects symlinked artifact directories", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-symlink-dir-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const target = join(dir, "target");
  mkdirSync(target);
  symlinkSync(target, join(dir, "linked"), "dir");

  assert.throws(() => generateStaticRunnerReport(join(dir, "linked")), /Unsafe artifactsDir path segment|artifactsDir must be a regular directory/);
});

test("generateStaticRunnerReport rejects artifact directories reached through symlinked parents", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-symlink-parent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const outside = join(dir, "outside");
  mkdirSync(join(outside, "artifacts"), { recursive: true });
  symlinkSync(outside, join(dir, "linked-parent"), "dir");

  assert.throws(() => generateStaticRunnerReport(join(dir, "linked-parent", "artifacts")), /Unsafe artifactsDir path segment/);
  assert.equal(existsSync(join(outside, "artifacts", "report.html")), false);
});

test("generateStaticRunnerReport skips symlinked copied artifacts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-symlink-artifact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, "secret-status.json"), JSON.stringify({ secret: "leak" }), "utf8");
  symlinkSync(join(dir, "secret-status.json"), join(dir, "status.json"));

  const result = generateStaticRunnerReport(dir);
  const html = readFileSync(result.reportPath, "utf8");

  assert.match(html, /No status\.json exported\./);
  assert.doesNotMatch(html, /leak/);
});

test("generateStaticRunnerReport refuses to overwrite symlinked report files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-symlink-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const target = join(dir, "outside.html");
  writeFileSync(target, "do not overwrite", "utf8");
  symlinkSync(target, join(dir, "report.html"));

  assert.throws(() => generateStaticRunnerReport(dir), /EEXIST/);
  assert.equal(readFileSync(target, "utf8"), "do not overwrite");
});

test("generateStaticRunnerReport bounds large inline JSONL previews", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-large-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ iteration: index + 1, summary: `large-${index}-${"x".repeat(300)}` }));
  writeFileSync(join(dir, "iterations.jsonl"), `${lines.join("\n")}\n`, "utf8");
  writeFileSync(join(dir, "events.jsonl"), `${lines.map((line, index) => JSON.stringify({ type: "event", index, payload: line })).join("\n")}\n`, "utf8");

  const result = generateStaticRunnerReport(dir);
  const html = readFileSync(result.reportPath, "utf8");

  assert.equal(result.iterations, 1200);
  assert.match(html, /preview truncated/);
  assert.match(html, /omitted from parsed report cards after 200 records/);
  assert.match(html, /large-1199/);
  assert.match(html, /canonical exported file remains complete/);
  assert.ok(Buffer.byteLength(html, "utf8") < 900_000);
});

test("generateStaticRunnerReport counts split UTF-8 whitespace consistently in large artifacts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-utf8-count-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const artifact = Buffer.concat([
    Buffer.alloc(64 * 1024 - 1, 0x20),
    Buffer.from("\u3000\n"),
    Buffer.from('{"iteration":1}\n'),
    Buffer.alloc(300_000, 0x20),
  ]);
  writeFileSync(join(dir, "iterations.jsonl"), artifact);
  writeFileSync(join(dir, "events.jsonl"), artifact);

  const result = generateStaticRunnerReport(dir);

  assert.equal(result.iterations, 1);
  assert.equal(result.events, 1);
});

test("generateStaticRunnerReport rejects path-like report names", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-report-name-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.throws(() => generateStaticRunnerReport(dir, "../report.html"), /basename-only/);
  assert.throws(() => generateStaticRunnerReport(dir, "."), /basename-only/);
  assert.throws(() => generateStaticRunnerReport(dir, ".."), /basename-only/);
  assert.equal(existsSync(join(dir, "..", "report.html")), false);
});
