import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, parse as parsePath, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type StaticRunnerReportResult = {
  reportPath: string;
  iterations: number;
  events: number;
};

type JsonRecord = Record<string, unknown>;
type StatusKind = "good" | "info" | "warn" | "bad" | "neutral";

const REPORT_ARTIFACT_PREVIEW_MAX_BYTES = 256 * 1024;
const REPORT_JSONL_MAX_RECORDS = 200;

type ParsedJsonl = {
  records: JsonRecord[];
  invalidLines: number;
  omittedLines: number;
};

type ArtifactText = {
  text: string;
  truncated: boolean;
  originalBytes: number;
};

type Fact = {
  label: string;
  value: string;
  html?: boolean;
};

type GateView = {
  text: string;
  kind: StatusKind;
  reasons: string[];
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function isAllowedDarwinSystemRootAlias(path: string): boolean {
  return process.platform === "darwin" && (path === "/var" || path === "/tmp" || path === "/etc");
}

function assertNoSymlinkedExistingPathSegments(targetPath: string, label: string): void {
  const resolvedTarget = resolve(targetPath);
  const parsed = parsePath(resolvedTarget);
  let current = parsed.root;
  const segments = resolvedTarget.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);

  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`Unsafe ${label}: ${current}`);
    }
    if (stat.isSymbolicLink() && !isAllowedDarwinSystemRootAlias(current)) {
      throw new Error(`Unsafe ${label}: ${current}`);
    }
  }
}

function readArtifact(path: string, maxBytes = REPORT_ARTIFACT_PREVIEW_MAX_BYTES, mode: "head" | "tail" = "head"): ArtifactText {
  if (!existsSync(path)) return { text: "", truncated: false, originalBytes: 0 };
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { text: "", truncated: false, originalBytes: 0 };
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const offset = mode === "tail" ? Math.max(0, stat.size - bytesToRead) : 0;
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = bytesToRead > 0 ? readSync(fd, buffer, 0, bytesToRead, offset) : 0;
    let text = buffer.toString("utf8", 0, bytesRead);
    if (mode === "tail" && offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return {
      text,
      truncated: stat.size > maxBytes,
      originalBytes: stat.size,
    };
  } catch {
    return { text: "", truncated: false, originalBytes: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function countNonEmptyLines(path: string): number {
  if (!existsSync(path)) return 0;
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return 0;
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let count = 0;
    let currentLineHasContent = false;
    const consume = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n") {
          if (currentLineHasContent) count += 1;
          currentLineHasContent = false;
        } else if (!/\s/.test(char)) {
          currentLineHasContent = true;
        }
      }
    };
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (currentLineHasContent) count += 1;
    return count;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").filter((line) => line.trim().length > 0);
}

function parseObject(value: string): JsonRecord | null {
  if (!value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function parseJsonl(lines: string[], totalLines = lines.length): ParsedJsonl {
  const records: JsonRecord[] = [];
  let invalidLines = 0;
  const candidateLines = lines.slice(-REPORT_JSONL_MAX_RECORDS);

  for (const line of candidateLines) {
    const parsed = parseObject(line);
    if (parsed) {
      records.push(parsed);
    } else {
      invalidLines += 1;
    }
  }

  return { records, invalidLines, omittedLines: Math.max(0, totalLines - records.length - invalidLines) };
}

function stringValue(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function scalarValue(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function latest<T>(values: T[]): T | undefined {
  return values[values.length - 1];
}

function normalizeStatus(status: unknown): string {
  return stringValue(status, "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function statusKind(status: unknown): StatusKind {
  const normalized = normalizeStatus(status);
  if (["complete", "completed", "done", "ok", "success", "ready"].includes(normalized)) return "good";
  if (["running", "initializing", "started", "in-progress", "progress", "stopped"].includes(normalized)) return "info";
  if (["max-iterations", "no-progress-exhaustion", "blocked", "warning", "warn", "not-checked", "unknown"].includes(normalized)) return "warn";
  if (["error", "failed", "failure", "cancelled", "canceled", "timeout", "timed-out"].includes(normalized)) return "bad";
  return "neutral";
}

function stampLabel(status: unknown): string {
  const normalized = normalizeStatus(status);
  if (["complete", "completed", "done", "ok", "success"].includes(normalized)) return "COMPLETE";
  if (["running", "initializing", "started", "in-progress"].includes(normalized)) return "IN PROGRESS";
  if (normalized === "stopped") return "STOPPED";
  if (normalized === "max-iterations") return "MAX ITERATIONS";
  if (normalized === "no-progress-exhaustion") return "NO PROGRESS";
  if (["timeout", "timed-out"].includes(normalized)) return "TIMEOUT";
  if (["error", "failed", "failure"].includes(normalized)) return "ERROR";
  if (["cancelled", "canceled"].includes(normalized)) return "CANCELLED";
  return "UNVERIFIED";
}

function statusBadge(status: unknown): string {
  const label = stringValue(status, "unknown");
  return `<span class="status status-${statusKind(status)}">${escapeHtml(label)}</span>`;
}

function stamp(status: unknown): string {
  return `<strong class="stamp stamp-${statusKind(status)}">${escapeHtml(stampLabel(status))}</strong>`;
}

function boolWord(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function formatDuration(ms: unknown): string {
  const value = numberValue(ms);
  if (value === undefined || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function durationBetween(start: unknown, end: unknown): string {
  const startText = stringValue(start, "");
  const endText = stringValue(end, "");
  if (!startText || !endText) return "—";
  const ms = Date.parse(endText) - Date.parse(startText);
  return Number.isFinite(ms) ? formatDuration(ms) : "—";
}

function formatTime(value: unknown): string {
  return stringValue(value, "—");
}

function gateView(iteration: JsonRecord | undefined): GateView {
  const gate = objectValue(iteration?.completionGate);
  if (!gate) return { text: "not checked", kind: "warn", reasons: [] };
  const reasons = arrayOfStrings(gate.reasons);
  if (gate.ready === true) return { text: "ready", kind: "good", reasons };
  if (gate.ready === false) return { text: reasons.length > 0 ? "blocked" : "not ready", kind: "warn", reasons };
  return { text: "unknown", kind: "warn", reasons };
}

function completionRecord(iteration: JsonRecord | undefined): JsonRecord | undefined {
  return objectValue(iteration?.completion);
}

function promiseSeen(iteration: JsonRecord | undefined): unknown {
  return completionRecord(iteration)?.promiseSeen ?? iteration?.completionPromiseMatched;
}

function durableProgressObserved(iteration: JsonRecord | undefined): unknown {
  return completionRecord(iteration)?.durableProgressObserved ?? iteration?.progress;
}

function verdict(status: unknown, gate: GateView): string {
  const normalized = normalizeStatus(status);
  if (["complete", "completed", "done", "ok", "success"].includes(normalized) && gate.text === "ready") {
    return "Run completed and the completion gate cleared.";
  }
  if (["complete", "completed", "done", "ok", "success"].includes(normalized)) {
    return "Run completed; inspect the completion gate and evidence before relying on the result.";
  }
  if (["running", "initializing", "started", "in-progress"].includes(normalized)) {
    return "Run was still in progress when these artifacts were exported.";
  }
  if (normalized === "stopped") {
    return "Run was stopped by operator control after the current iteration.";
  }
  if (normalized === "max-iterations") {
    return "Run exhausted its iteration limit with unresolved work.";
  }
  if (normalized === "no-progress-exhaustion") {
    return "Run stopped because Ralph could not verify durable progress.";
  }
  if (["timeout", "timed-out"].includes(normalized)) {
    return "Run timed out; inspect the event trace and raw artifacts.";
  }
  if (["error", "failed", "failure"].includes(normalized)) {
    return "Run ended in error; inspect event trace and raw artifacts.";
  }
  if (["cancelled", "canceled"].includes(normalized)) {
    return "Run was cancelled by operator control.";
  }
  return "Run state is unverified; use the raw evidence vault as the source of truth.";
}

function renderFactGrid(facts: Fact[]): string {
  return `<dl class="fact-grid">
${facts.map((fact) => `    <div><dt>${escapeHtml(fact.label)}</dt><dd>${fact.html ? fact.value : escapeHtml(fact.value)}</dd></div>`).join("\n")}
  </dl>`;
}

function renderSection(id: string, title: string, body: string, note?: string): string {
  return `<section class="section" id="${escapeAttr(id)}">
  <h2>${escapeHtml(title)}</h2>
  ${note ? `<p class="section-note">${escapeHtml(note)}</p>` : ""}
${body}
</section>`;
}

function renderCallout(kind: StatusKind, text: string): string {
  return `<p class="callout callout-${kind}">${escapeHtml(text)}</p>`;
}

function renderList(items: string[], empty: string): string {
  if (items.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<ul class="plain-list">
${items.map((item) => `    <li><code>${escapeHtml(item)}</code></li>`).join("\n")}
  </ul>`;
}

function renderChangedFiles(files: string[]): string {
  if (files.length === 0) return `<span class="empty">none recorded</span>`;
  return `<ul class="file-list">${files.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>`;
}

function commandOutcomes(iteration: JsonRecord): JsonRecord[] {
  const completion = objectValue(iteration.completion);
  return [
    ...(Array.isArray(iteration.commandOutcomes) ? iteration.commandOutcomes : []),
    ...(completion && Array.isArray(completion.acceptanceOutcomes) ? completion.acceptanceOutcomes : []),
  ].filter((outcome): outcome is JsonRecord => Boolean(outcome) && typeof outcome === "object" && !Array.isArray(outcome));
}

function renderCommandEvidence(iteration: JsonRecord): string {
  const outcomes = commandOutcomes(iteration);
  if (outcomes.length === 0) {
    return `<p class="empty">No structured command outcomes recorded for this iteration.</p>`;
  }

  return `<div class="table-wrap"><table class="ledger-table">
    <thead><tr><th>Name</th><th>Status</th><th>Acceptance</th><th>Output preview</th></tr></thead>
    <tbody>
${outcomes.map((outcome) => `      <tr><td>${escapeHtml(stringValue(outcome.name, "command"))}</td><td>${statusBadge(outcome.status)}</td><td>${escapeHtml(outcome.acceptance === true ? "yes" : "no")}</td><td><code>${escapeHtml(stringValue(outcome.outputPreview, "—"))}</code></td></tr>`).join("\n")}
    </tbody>
  </table></div>`;
}

function renderIterationCards(iterations: JsonRecord[]): string {
  if (iterations.length === 0) return renderCallout("warn", "No iteration records were exported. The runner may not have entered its first iteration, or artifacts may be incomplete.");

  return iterations.map((iteration, index) => {
    const number = iteration.iteration ?? index + 1;
    const id = `iteration-${String(number).replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
    const gate = gateView(iteration);
    const changedFiles = arrayOfStrings(iteration.changedFiles);
    const warnings = [
      iteration.snapshotTruncated === true ? "Snapshot evidence was truncated." : "",
      numberValue(iteration.snapshotErrorCount) && numberValue(iteration.snapshotErrorCount)! > 0 ? `Snapshot recorded ${numberValue(iteration.snapshotErrorCount)} error(s).` : "",
    ].filter(Boolean);
    const summary = stringValue(iteration.summary ?? iteration.message, "");

    return `<article class="iteration-card" id="${escapeAttr(id)}">
  <header class="iteration-head">
    <h3><a href="#${escapeAttr(id)}">Iteration ${escapeHtml(String(number).padStart(2, "0"))}</a></h3>
    ${statusBadge(iteration.status)}
  </header>
  <dl class="mini-facts">
    <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(iteration.durationMs))}</dd></div>
    <div><dt>Progress</dt><dd>${escapeHtml(boolWord(iteration.progress))}</dd></div>
    <div><dt>Gate</dt><dd>${statusBadge(gate.text)}</dd></div>
    <div><dt>Promise</dt><dd>${escapeHtml(boolWord(promiseSeen(iteration)))}</dd></div>
  </dl>
  ${summary ? `<p class="iteration-summary">${escapeHtml(summary)}</p>` : ""}
  ${gate.reasons.length > 0 ? renderCallout(gate.kind, `Blocking reasons: ${gate.reasons.join("; ")}`) : ""}
  ${warnings.map((warning) => renderCallout("warn", warning)).join("\n")}
  <div class="evidence-block">
    <h4>Changed files</h4>
    ${renderChangedFiles(changedFiles)}
  </div>
  <details class="evidence-details">
    <summary>Command and acceptance evidence</summary>
    ${renderCommandEvidence(iteration)}
  </details>
</article>`;
  }).join("\n");
}

function aggregateFiles(iterations: JsonRecord[]): { file: string; count: number; first: string; last: string }[] {
  const files = new Map<string, { count: number; first: string; last: string }>();
  for (const iteration of iterations) {
    for (const file of arrayOfStrings(iteration.changedFiles)) {
      const iterationLabel = String(iteration.iteration ?? "?");
      const existing = files.get(file);
      if (existing) {
        existing.count += 1;
        existing.last = iterationLabel;
      } else {
        files.set(file, { count: 1, first: iterationLabel, last: iterationLabel });
      }
    }
  }
  return [...files.entries()].map(([file, evidence]) => ({ file, ...evidence })).sort((a, b) => a.file.localeCompare(b.file));
}

function renderFileEvidence(iterations: JsonRecord[]): string {
  const files = aggregateFiles(iterations);
  if (files.length === 0) return renderCallout("neutral", "No changed files were recorded in the exported iteration ledger.");

  return `<div class="table-wrap"><table class="ledger-table">
    <thead><tr><th>File</th><th>Touches</th><th>First seen</th><th>Last seen</th></tr></thead>
    <tbody>
${files.map((file) => `      <tr><td><code>${escapeHtml(file.file)}</code></td><td>${file.count}</td><td>${escapeHtml(file.first)}</td><td>${escapeHtml(file.last)}</td></tr>`).join("\n")}
    </tbody>
  </table></div>`;
}

function eventLabel(event: JsonRecord): string {
  return stringValue(event.type ?? event.event ?? event.status ?? event.summary ?? event.message, "event");
}

function eventEvidence(event: JsonRecord): string {
  const obvious = event.message ?? event.reason ?? event.summary;
  if (obvious !== undefined) return String(obvious);
  if (event.ready !== undefined) return `ready=${String(event.ready)}`;
  if (event.progress !== undefined) return `progress=${String(event.progress)}`;
  const reasons = arrayOfStrings(event.reasons);
  if (reasons.length > 0) return reasons.join("; ");
  return "—";
}

function renderEventTrace(events: JsonRecord[], invalidLines: number): string {
  const warning = invalidLines > 0 ? renderCallout("warn", `${invalidLines} events.jsonl line(s) could not be parsed. Raw artifact text is preserved below.`) : "";
  if (events.length === 0) {
    return `${warning}${renderCallout("warn", "No parsed events were exported.")}`;
  }

  const visible = events.length > 100 ? events.slice(-100) : events;
  const trimmed = events.length > visible.length ? renderCallout("info", `Showing the last ${visible.length} parsed events. Raw events.jsonl below remains canonical.`) : "";

  return `${warning}${trimmed}<div class="table-wrap"><table class="ledger-table event-table">
    <caption>Parsed events from events.jsonl</caption>
    <thead><tr><th>Time</th><th>Iteration</th><th>Type</th><th>Evidence</th></tr></thead>
    <tbody>
${visible.map((event) => `      <tr><td class="mono">${escapeHtml(formatTime(event.timestamp))}</td><td>${escapeHtml(String(event.iteration ?? "—"))}</td><td><code>${escapeHtml(eventLabel(event))}</code></td><td>${escapeHtml(eventEvidence(event))}</td></tr>`).join("\n")}
    </tbody>
  </table></div>`;
}

function renderGuardrails(status: JsonRecord): string {
  const guardrails = objectValue(status.guardrails) ?? {};
  const blockCommands = arrayOfStrings(guardrails.blockCommands);
  const protectedFiles = arrayOfStrings(guardrails.protectedFiles);
  const facts = renderFactGrid([
    { label: "Timeout", value: scalarValue(status.timeout, "—") },
    { label: "Max iterations", value: scalarValue(status.maxIterations, "—") },
    { label: "Blocked commands", value: String(blockCommands.length) },
    { label: "Protected file globs", value: String(protectedFiles.length) },
  ]);

  return `${facts}
<div class="split-blocks">
  <div class="evidence-block"><h3>Blocked commands</h3>${renderList(blockCommands, "No command blocks recorded.")}</div>
  <div class="evidence-block"><h3>Protected files</h3>${renderList(protectedFiles, "No protected file globs recorded.")}</div>
</div>`;
}

function listTranscripts(artifactsDir: string): string[] {
  const transcriptsDir = join(artifactsDir, "transcripts");
  if (!existsSync(transcriptsDir)) return [];
  try {
    const dirStat = lstatSync(transcriptsDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return [];
    return readdirSync(transcriptsDir)
      .filter((entry) => {
        try {
          const stat = lstatSync(join(transcriptsDir, entry));
          return stat.isFile() && !stat.isSymbolicLink();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function renderArtifactLinks(transcripts: string[]): string {
  const transcriptLinks = transcripts.map((file) => `<a href="${escapeAttr(`transcripts/${encodeURIComponent(file)}`)}">${escapeHtml(file)}</a>`).join("\n      ");
  return `<div class="artifact-links">
    <a href="status.json">status.json</a>
    <a href="iterations.jsonl">iterations.jsonl</a>
    <a href="events.jsonl">events.jsonl</a>
    ${transcriptLinks}
  </div>`;
}

function artifactDisplayText(artifact: ArtifactText, missing: string): string {
  if (!artifact.text) return missing;
  if (!artifact.truncated) return artifact.text;
  return `${artifact.text}\n\n[truncated to first ${REPORT_ARTIFACT_PREVIEW_MAX_BYTES} bytes from ${artifact.originalBytes} bytes; canonical exported file remains complete]`;
}

function renderRawArtifact(name: string, artifact: ArtifactText, missing: string): string {
  return `<details class="raw-file">
  <summary>${escapeHtml(name)}${artifact.truncated ? " (preview truncated)" : ""}</summary>
  <pre><code>${escapeHtml(artifactDisplayText(artifact, missing))}</code></pre>
</details>`;
}

function renderRawVault(status: ArtifactText, iterationsJsonl: ArtifactText, eventsJsonl: ArtifactText, transcripts: string[]): string {
  return `${renderArtifactLinks(transcripts)}
${renderRawArtifact("status.json", status, "No status.json exported.")}
${renderRawArtifact("iterations.jsonl", iterationsJsonl, "No iterations.jsonl exported.")}
${renderRawArtifact("events.jsonl", eventsJsonl, "No events.jsonl exported.")}`;
}

function css(): string {
  return `:root {
  --paper: #f3efe6;
  --sheet: #fffaf0;
  --sheet-2: #f8f1e4;
  --ink: #1e252b;
  --muted: #68737d;
  --rule: #c9beb0;
  --rule-strong: #2b3137;
  --rail: #8f241d;
  --good-bg: #e6f2e7;
  --good-ink: #17643a;
  --warn-bg: #fff1cc;
  --warn-ink: #7a4a00;
  --bad-bg: #fae1dc;
  --bad-ink: #9f1d17;
  --info-bg: #e2edf8;
  --info-ink: #245d8f;
  --neutral-bg: #ebe6dc;
  --neutral-ink: #505860;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --serif: ui-serif, Georgia, Cambria, serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background:
    repeating-linear-gradient(0deg, rgba(30,37,43,.028) 0, rgba(30,37,43,.028) 1px, transparent 1px, transparent 28px),
    linear-gradient(90deg, rgba(143,36,29,.08), transparent 34%),
    var(--paper);
  color: var(--ink);
  font-family: var(--sans);
}
a { color: var(--rail); text-decoration-thickness: .08em; text-underline-offset: .18em; }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--rail); outline-offset: 3px; }
code, .mono { font-family: var(--mono); }
.dossier-page { max-width: 1280px; margin: 0 auto; padding: 32px; display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 28px; }
.toc { position: sticky; top: 24px; align-self: start; padding: 18px; border: 1px solid var(--rule); background: rgba(255,250,240,.74); box-shadow: 0 8px 0 rgba(30,37,43,.05); }
.toc-kicker { margin: 0 0 14px; color: var(--rail); font-family: var(--mono); font-size: 11px; font-weight: 800; letter-spacing: .12em; }
.toc a { display: block; padding: 8px 0; border-top: 1px solid rgba(201,190,176,.72); color: var(--ink); text-decoration: none; font-size: 13px; }
.dossier { counter-reset: dossier-section; min-width: 0; }
.cover, .section { background: var(--sheet); border: 1px solid var(--rule); box-shadow: 0 18px 50px rgba(30,37,43,.10); }
.cover { position: relative; display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; padding: 34px; border-top: 7px solid var(--rule-strong); }
.cover::before { content: ""; position: absolute; inset: 16px auto 16px 18px; width: 3px; background: var(--rail); opacity: .9; }
.eyebrow { margin: 0 0 10px; color: var(--rail); font-family: var(--mono); font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
h1 { margin: 0; font: 700 clamp(34px, 5vw, 60px)/.95 var(--serif); letter-spacing: -.04em; }
.lede { max-width: 760px; margin: 14px 0 0; color: var(--muted); line-height: 1.55; }
.task-path { margin: 18px 0 0; padding-left: 14px; border-left: 3px solid var(--rule); color: var(--ink); overflow-wrap: anywhere; }
.stamp { flex: 0 0 auto; transform: rotate(-3deg); margin-top: 10px; padding: 10px 14px; border: 3px solid currentColor; font-family: var(--mono); font-size: 18px; letter-spacing: .12em; text-transform: uppercase; }
.stamp-good { color: var(--good-ink); } .stamp-info { color: var(--info-ink); } .stamp-warn { color: var(--warn-ink); } .stamp-bad { color: var(--bad-ink); } .stamp-neutral { color: var(--neutral-ink); }
.section { margin-top: 18px; padding: 24px; }
.section h2 { margin: 0 0 14px; font: 700 24px/1.1 var(--serif); }
.section h2::before { counter-increment: dossier-section; content: counter(dossier-section, decimal-leading-zero) " / "; color: var(--rail); font-family: var(--mono); font-size: 15px; }
.section-note { margin: -4px 0 16px; color: var(--muted); line-height: 1.45; }
.verdict { margin: 0; padding: 18px 18px 18px 22px; border-left: 5px solid var(--rail); background: var(--sheet-2); font: 700 20px/1.35 var(--serif); }
.fact-grid, .mini-facts { display: grid; gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
.fact-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 16px; }
.fact-grid div, .mini-facts div { background: var(--sheet-2); padding: 12px; min-width: 0; }
dt { color: var(--muted); font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
dd { margin: 6px 0 0; overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 2px; border: 1px solid currentColor; font-family: var(--mono); font-size: 12px; font-weight: 800; text-transform: uppercase; }
.status-good { color: var(--good-ink); background: var(--good-bg); }
.status-info { color: var(--info-ink); background: var(--info-bg); }
.status-warn { color: var(--warn-ink); background: var(--warn-bg); }
.status-bad { color: var(--bad-ink); background: var(--bad-bg); }
.status-neutral { color: var(--neutral-ink); background: var(--neutral-bg); }
.split-blocks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 14px; }
.evidence-block { border: 1px solid var(--rule); background: var(--sheet-2); padding: 14px; }
.evidence-block h3, .evidence-block h4 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--rail); }
.plain-list, .file-list { margin: 0; padding-left: 18px; }
.file-list li + li, .plain-list li + li { margin-top: 4px; }
.iteration-card { border: 1px solid var(--rule); background: linear-gradient(90deg, rgba(143,36,29,.08), transparent 9px), var(--sheet-2); padding: 18px; }
.iteration-card + .iteration-card { margin-top: 14px; }
.iteration-head { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.iteration-head h3 { margin: 0; font: 700 21px/1.1 var(--serif); }
.mini-facts { grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 14px 0; }
.iteration-summary { margin: 10px 0; color: var(--muted); }
.evidence-details { margin-top: 12px; }
summary { cursor: pointer; color: var(--rail); font-weight: 800; }
.callout { margin: 12px 0; padding: 12px 14px; border-left: 5px solid currentColor; }
.callout-good { color: var(--good-ink); background: var(--good-bg); } .callout-info { color: var(--info-ink); background: var(--info-bg); } .callout-warn { color: var(--warn-ink); background: var(--warn-bg); } .callout-bad { color: var(--bad-ink); background: var(--bad-bg); } .callout-neutral { color: var(--neutral-ink); background: var(--neutral-bg); }
.table-wrap { overflow-x: auto; border: 1px solid var(--rule); background: var(--sheet-2); }
.ledger-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ledger-table caption { text-align: left; padding: 10px 12px; color: var(--muted); font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.ledger-table th { text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--rule-strong); font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.ledger-table td { padding: 11px 12px; border-top: 1px solid var(--rule); vertical-align: top; }
.artifact-links { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.artifact-links a { display: inline-block; padding: 6px 9px; border: 1px solid var(--rule); background: var(--sheet-2); font-family: var(--mono); font-size: 12px; text-decoration: none; }
.raw-file { border: 1px solid var(--rule); background: var(--sheet-2); }
.raw-file + .raw-file { margin-top: 10px; }
.raw-file summary { padding: 12px 14px; border-bottom: 1px solid var(--rule); }
pre { margin: 0; padding: 14px; overflow: auto; background: #29251f; color: #f6ead8; font-size: 12px; line-height: 1.45; }
.empty { color: var(--muted); }
@media (max-width: 900px) { .dossier-page { display: block; padding: 18px; } .toc { position: static; margin-bottom: 18px; } .cover { display: block; } .stamp { display: inline-block; margin-top: 18px; } .fact-grid, .mini-facts, .split-blocks { grid-template-columns: 1fr; } }
@media print { body { background: white; } .dossier-page { display: block; max-width: none; padding: 0; } .toc { display: none; } .cover, .section { box-shadow: none; break-inside: avoid; } a { color: black; } }`;
}

function buildHtml(artifactsDir: string, statusArtifact: ArtifactText, iterationsArtifact: ArtifactText, eventsArtifact: ArtifactText, iterationLines: string[], eventLines: string[], totalIterations: number, totalEvents: number): string {
  const statusText = statusArtifact.text;
  const status = parseObject(statusText) ?? {};
  const parsedIterations = parseJsonl(iterationLines, totalIterations);
  const parsedEvents = parseJsonl(eventLines, totalEvents);
  const iterations = parsedIterations.records;
  const events = parsedEvents.records;
  const currentStatus = status.status ?? latest(iterations)?.status ?? "unknown";
  const lastIteration = latest(iterations);
  const gate = gateView(lastIteration);
  const transcripts = listTranscripts(artifactsDir);
  const duration = durationBetween(status.startedAt, status.completedAt);
  const currentIteration = status.currentIteration ?? lastIteration?.iteration ?? iterationLines.length;
  const maxIterations = status.maxIterations ?? "?";
  const taskPath = stringValue(status.taskDir, "Task path not recorded");

  const overviewFacts = renderFactGrid([
    { label: "Case ID", value: stringValue(status.loopToken, "unrecorded") },
    { label: "Terminal status", value: statusBadge(currentStatus), html: true },
    { label: "Iterations", value: `${String(currentIteration)} / ${String(maxIterations)} (${totalIterations} record${totalIterations === 1 ? "" : "s"} exported)` },
    { label: "Events recorded", value: String(totalEvents) },
    { label: "Started", value: formatTime(status.startedAt) },
    { label: "Completed", value: formatTime(status.completedAt) },
    { label: "Duration", value: duration },
    { label: "Transcripts", value: String(transcripts.length) },
  ]);

  const identityFacts = renderFactGrid([
    { label: "Loop token", value: stringValue(status.loopToken, "unrecorded") },
    { label: "Task directory", value: stringValue(status.taskDir, "unrecorded") },
    { label: "Working directory", value: stringValue(status.cwd, "unrecorded") },
    { label: "RALPH.md", value: stringValue(status.ralphPath, "unrecorded") },
  ]);

  const gateFacts = renderFactGrid([
    { label: "Completion gate", value: statusBadge(gate.text), html: true },
    { label: "Promise observed", value: boolWord(promiseSeen(lastIteration)) },
    { label: "Durable progress", value: boolWord(durableProgressObserved(lastIteration)) },
    { label: "No-progress streak", value: String(lastIteration?.noProgressStreak ?? "—") },
  ]);

  const malformedNotes = [
    parsedIterations.invalidLines > 0 ? renderCallout("warn", `${parsedIterations.invalidLines} iterations.jsonl line(s) could not be parsed. Raw artifact text is preserved below.`) : "",
    parsedEvents.invalidLines > 0 ? renderCallout("warn", `${parsedEvents.invalidLines} events.jsonl line(s) could not be parsed. Raw artifact text is preserved below.`) : "",
    parsedIterations.omittedLines > 0 ? renderCallout("warn", `${parsedIterations.omittedLines} iterations.jsonl line(s) omitted from parsed report cards after ${REPORT_JSONL_MAX_RECORDS} records; canonical exported file remains complete.`) : "",
    parsedEvents.omittedLines > 0 ? renderCallout("warn", `${parsedEvents.omittedLines} events.jsonl line(s) omitted from parsed event trace after ${REPORT_JSONL_MAX_RECORDS} records; canonical exported file remains complete.`) : "",
    iterationsArtifact.truncated ? renderCallout("warn", `iterations.jsonl inline preview truncated to ${REPORT_ARTIFACT_PREVIEW_MAX_BYTES} bytes; canonical exported file remains complete.`) : "",
    eventsArtifact.truncated ? renderCallout("warn", `events.jsonl inline preview truncated to ${REPORT_ARTIFACT_PREVIEW_MAX_BYTES} bytes; canonical exported file remains complete.`) : "",
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ralph Loop Dossier</title>
  <style>${css()}</style>
</head>
<body>
  <main class="page dossier-page">
    <nav class="toc" aria-label="Report sections">
      <p class="toc-kicker">RALPH // RUN LOGS</p>
      <a href="#summary">Operator summary</a>
      <a href="#identity">Run identity</a>
      <a href="#gate">Completion gate</a>
      <a href="#guardrails">Guardrails &amp; scope</a>
      <a href="#iterations">Iteration ledger</a>
      <a href="#files">File evidence</a>
      <a href="#events">Event trace</a>
      <a href="#raw">Raw evidence vault</a>
    </nav>

    <div class="dossier">
      <header class="cover">
        <div>
          <p class="eyebrow">Static audit packet</p>
          <h1>Ralph Loop Dossier</h1>
          <p class="lede">Generated from exported <code>status.json</code>, <code>iterations.jsonl</code>, and <code>events.jsonl</code>. Raw artifacts remain canonical.</p>
          <p class="task-path"><code>${escapeHtml(taskPath)}</code></p>
        </div>
        ${stamp(currentStatus)}
      </header>

      ${renderSection("summary", "Operator summary", `<p class="verdict">${escapeHtml(verdict(currentStatus, gate))}</p>\n${overviewFacts}\n${malformedNotes}`)}
      ${renderSection("identity", "Run identity", identityFacts)}
      ${renderSection("gate", "Completion gate", `${gateFacts}${gate.reasons.length > 0 ? renderCallout(gate.kind, `Blocking reasons: ${gate.reasons.join("; ")}`) : ""}`)}
      ${renderSection("guardrails", "Guardrails & scope", renderGuardrails(status))}
      ${renderSection("iterations", "Iteration ledger", renderIterationCards(iterations), "One ledger card per iteration. Status labels are derived from exported runner records.")}
      ${renderSection("files", "File evidence", renderFileEvidence(iterations), "Aggregate changed-file evidence from the iteration ledger.")}
      ${renderSection("events", "Event trace", renderEventTrace(events, parsedEvents.invalidLines), "Chronological runner events. Event names are preserved exactly as recorded.")}
      ${renderSection("raw", "Raw evidence vault", renderRawVault(statusArtifact, iterationsArtifact, eventsArtifact, transcripts), "Canonical copied artifacts and transcripts. Inline report previews are escaped and bounded for audit.")}
    </div>
  </main>
</body>
</html>
`;
}

export function generateStaticRunnerReport(artifactsDir: string, reportName = "report.html"): StaticRunnerReportResult {
  if (!reportName || reportName === "." || reportName === ".." || reportName !== basename(reportName)) {
    throw new Error("reportName must be a basename-only file name");
  }
  assertNoSymlinkedExistingPathSegments(artifactsDir, "artifactsDir path segment");
  const artifactsStat = lstatSync(artifactsDir);
  if (artifactsStat.isSymbolicLink() || !artifactsStat.isDirectory()) {
    throw new Error(`artifactsDir must be a regular directory: ${artifactsDir}`);
  }

  const status = readArtifact(join(artifactsDir, "status.json"));
  const iterationsPath = join(artifactsDir, "iterations.jsonl");
  const eventsPath = join(artifactsDir, "events.jsonl");
  const iterationsJsonl = readArtifact(iterationsPath);
  const eventsJsonl = readArtifact(eventsPath);
  const iterationsTail = iterationsJsonl.truncated
    ? readArtifact(iterationsPath, REPORT_ARTIFACT_PREVIEW_MAX_BYTES, "tail")
    : iterationsJsonl;
  const eventsTail = eventsJsonl.truncated
    ? readArtifact(eventsPath, REPORT_ARTIFACT_PREVIEW_MAX_BYTES, "tail")
    : eventsJsonl;
  const iterationLines = nonEmptyLines(iterationsTail.text);
  const eventLines = nonEmptyLines(eventsTail.text);
  const totalIterations = iterationsJsonl.truncated ? countNonEmptyLines(iterationsPath) : iterationLines.length;
  const totalEvents = eventsJsonl.truncated ? countNonEmptyLines(eventsPath) : eventLines.length;
  const reportPath = join(artifactsDir, reportName);
  const html = buildHtml(artifactsDir, status, iterationsJsonl, eventsJsonl, iterationLines, eventLines, totalIterations, totalEvents);

  writeFileSync(reportPath, html, { encoding: "utf8", flag: "wx" });
  return { reportPath, iterations: totalIterations, events: totalEvents };
}
