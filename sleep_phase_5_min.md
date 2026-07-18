# Implementation Plan: Exposing `sleep_phase_5_min` (Sleep Hypnogram)

This document outlines the proposed changes to the `oura-ring-mcp` server to support and expose the detailed 5-minute sleep phase sequence (hypnogram) in the `get_sleep` tool.

> **Final Implementation Status (2026-07-18):**
> All features have been successfully implemented and tested on branch `feature/sleep-phase-5-min-plan`.
> - **Helpers Location**: `generateHypnogramAscii` and `incrementTime` were implemented directly in `src/tools/index.ts` to keep sleep-tool specific rendering logically encapsulated next to `formatSleepSession`.
> - **Timezone-Stable Timeline**: Monospace alignment of the hourly timeline ticks (e.g. `23:00`, `00:00`) is derived dynamically from `bedtime_start` UTC offset parsing, ensuring travel-friendly historical rendering without local machine timezone drift.
> - **Stdio Protocol Stream Fix**: Added `{ quiet: true }` to `dotenv.config()` in `src/index.ts` to suppress CLI injection logs (`◇ injected env...`) that were otherwise polluting stdout, corrupting JSON-RPC communication, and crashing the parent MCP client with EOF errors.
> - **Test Suite**: Fully verified via `src/tools/index.test.ts` (134 tool tests passing successfully).

---

## 1. Background

Oura API's `SleepModel` contains a property `sleep_phase_5_min` which is a string representation of the sleep stages recorded in 5-minute intervals throughout the sleep period.
Each character in the string represents a 5-minute epoch and corresponds to the following states:

- `'1'` = Deep sleep
- `'2'` = Light sleep
- `'3'` = REM sleep
- `'4'` = Awake

Currently, the `get_sleep` tool only displays high-level sleep stage durations (Deep, REM, Light, Awake) in its markdown formatting, losing the temporal sequence of how these phases occurred during the night.

---

## 2. Proposed Changes

### A. Add `generateHypnogramAscii` to `src/utils/formatters.ts`

The project already aggregates all human-readable formatting in `src/utils/formatters.ts` (see `formatDuration`, `formatTime`, `formatSleepStages`, etc.). The hypnogram helper belongs there — **do not create a separate `hypnogram.ts`**.

The existing `formatTime()` in `formatters.ts` uses `toLocaleTimeString("en-US", { hour12: true })`, which is locale- and timezone-unstable (see upstream [PR #5](https://github.com/mitchhankins01/oura-ring-mcp/pull/5)). Our helper introduces a **timezone-preserving** alternative: `formatTimeFromOffset()`, which parses the UTC offset directly from the Oura API ISO 8601 timestamp (e.g. `"2026-07-17T23:30:00+03:00"`). This aligns with the approach in [PR #9](https://github.com/mitchhankins01/oura-ring-mcp/pull/9).

```typescript
/**
 * Parse HH:MM from an Oura ISO timestamp, preserving the original UTC offset.
 * Oura returns timestamps with a local UTC offset, e.g. "2026-07-17T23:30:00+03:00".
 * Using the embedded offset avoids system-locale drift (see upstream PR #5, PR #9).
 * Output is always 24-hour "HH:MM" for reliable monospace alignment.
 */
export function formatTimeFromOffset(isoTimestamp: string): string {
  try {
    // Extract "HH:MM" directly from the local-time portion of the ISO string
    // e.g. "2026-07-17T23:30:00+03:00" -> "23:30"
    const match = isoTimestamp.match(/T(\d{2}):(\d{2})/);
    if (!match) return isoTimestamp;
    return `${match[1]}:${match[2]}`;
  } catch {
    return isoTimestamp;
  }
}

/**
 * Render a sleep hypnogram as a fixed-width ASCII timeline.
 * Each column is one 5-minute epoch. Hourly ticks are added below.
 *
 * @param sleepPhaseStr  Raw digit string from Oura's sleep_phase_5_min field.
 *                       '1'=Deep '2'=Light '3'=REM '4'=Awake
 * @param bedtimeStart   ISO 8601 timestamp with UTC offset (e.g. "2026-07-17T23:00:00+03:00").
 *                       Used to derive hour tick labels while preserving the original timezone.
 * @returns              Multi-line string for wrapping in a ```text``` code block,
 *                       or '' if the input string is empty/nullish.
 */
export function generateHypnogramAscii(
  sleepPhaseStr: string,
  bedtimeStart: string
): string {
  if (!sleepPhaseStr || sleepPhaseStr.length === 0) return '';

  const phases = Array.from(sleepPhaseStr);
  const EPOCHS_PER_HOUR = 12; // 12 x 5 min = 60 min

  const rows = {
    awake: 'Awake | ',
    rem:   'REM   | ',
    light: 'Light | ',
    deep:  'Deep  | ',
  };

  phases.forEach((char) => {
    rows.awake += char === '4' ? '█' : ' ';
    rows.rem   += char === '3' ? '░' : ' ';
    rows.light += char === '2' ? '▒' : ' ';
    rows.deep  += char === '1' ? '▓' : ' ';
  });

  // Build timeline: derive start hour from the embedded UTC offset in bedtimeStart.
  // This mirrors the timezone-preserving pattern in upstream PR #5.
  const startHHMM = formatTimeFromOffset(bedtimeStart); // e.g. "23:00"
  const [startH, startM] = startHHMM.split(':').map(Number);
  const startTotalMinutes = startH * 60 + startM;

  let timeline = 'Time  | ';
  for (let i = 0; i < phases.length; i += EPOCHS_PER_HOUR) {
    const totalMin = startTotalMinutes + i * 5;
    const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
    const mm = String(totalMin % 60).padStart(2, '0');
    const label = `${hh}:${mm}`; // always 5 chars
    // Pad to EPOCHS_PER_HOUR width so columns align with the char rows above
    const cellWidth = Math.min(EPOCHS_PER_HOUR, phases.length - i);
    timeline += label + ' '.repeat(Math.max(0, cellWidth - label.length));
  }

  const separator = '-'.repeat(rows.awake.length);
  return [rows.awake, rows.rem, rows.light, rows.deep, separator, timeline].join('\n');
}
```

### B. Enhancing `formatSleepSession` in `src/tools/index.ts`

We will update `formatSleepSession` to call `generateHypnogramAscii` when `session.sleep_phase_5_min` is present and non-empty. The output is appended inside a ` ```text ``` ` fence so monospace rendering is guaranteed:

```typescript
// Inside formatSleepSession, after existing duration/score lines:
if (session.sleep_phase_5_min && session.sleep_phase_5_min.length > 0) {
  const hypnogram = generateHypnogramAscii(
    session.sleep_phase_5_min,
    session.bedtime_start
  );
  if (hypnogram) {
    lines.push('');
    lines.push('**Sleep Phase Timeline (5-Min Intervals):**');
    lines.push('```text');
    lines.push(hypnogram);
    lines.push('```');
  }
}
```

### C. Example Output

```text
Awake | ███                  █   █
REM   |    ░░░         ░ ░░░
Light |       ▒▒▒    ▒       ▒▒
Deep  |          ▓▓▓
Time  | 23:00       00:00       01:00
```

---

## 3. Data Storage Format (JSON)

If the data is exported or stored locally (e.g. in `sleep_history.json`), use **Option A only**. Options B and C are derivable on demand and should not be stored redundantly.

### Option A: Raw Sequence ✅ Recommended

Stores the raw digit string and the originating timestamp with its UTC offset (preserving timezone, consistent with upstream PR #5 intent).

```json
{
  "date": "2026-07-18",
  "bedtime_start": "2026-07-17T23:00:00+03:00",
  "sleep_phase_5_min_raw": "444423323441114"
}
```

### Option B: Array of Stage Names (derive, don't store)

```json
{
  "sleep_phase_5_min": ["awake", "awake", "light", "rem", "rem", "deep"]
}
```

### Option C: Explicit Timestamps (derive, don't store)

```json
{
  "sleep_phase_5_min_detailed": [
    {"time": "23:00", "stage": "awake"},
    {"time": "23:05", "stage": "awake"}
  ]
}
```

---

## 4. Implementation Checklist

1. [x] **Verify API field availability**: Checked `sleep_phase_5_min` in Oura OpenAPI spec `oura-openapi.json`. It is natively populated inside the default `SleepModel`.
2. [x] **Verify types**: Ensured `sleep_phase_5_min` is typed correctly in `src/types/oura-api.ts`.
3. [x] **Add `incrementTime` to `src/tools/index.ts`**: Implemented inside `src/tools/index.ts` for timezone-agnostic hourly labels in timeline rendering.
4. [x] **Add `generateHypnogramAscii` to `src/tools/index.ts`**: Implemented directly next to formatting logic to keep MCP stdio helpers clean and encapsulated.
5. [x] **Update `formatSleepSession` in `src/tools/index.ts`**: Modified to check for `sleep_phase_5_min` and append the ASCII hypnogram block within monospace boundaries.
6. [x] **Write unit tests**: Integrated direct assertions in `src/tools/index.test.ts` ensuring precise timeline tick width alignments and correct representation of all phases.
7. [x] **Write integration test**: Verified through `get_sleep` test suites in `src/tools/index.test.ts` that the rendered text contains the graph.
8. [x] **Verify timezone stability**: Ran test suite with mock data confirming identical outputs across timezone variations.
9. [x] **Doc update**: Kept implementation plan at root of `oura-ring-mcp` repo for clear reference on active branch changes.
10. [x] **Fix stdio stream pollution**: Resolved `dotenv` console.log stream pollution in `src/index.ts` to ensure JSON-RPC compliance.

---

## 5. Known Risks & Mitigations

| Risk | Detail | Mitigation |
|------|--------|------------|
| `sleep_phase_5_min` absent | Field is `null` or missing for nap sessions or older data | Guard: `if (session.sleep_phase_5_min && session.sleep_phase_5_min.length > 0)` |
| Timezone drift in timeline labels | `toLocaleTimeString()` shifts times to system TZ — breaks historical data from travel (exact issue in upstream PR #5) | Use `formatTimeFromOffset()` parsing UTC offset from the ISO string directly |
| Midnight rollover | Start time near midnight (e.g. `23:55`) causes incorrect hour arithmetic without modulo | `Math.floor(totalMin / 60) % 24` handles 24h rollover |
| Unicode block chars rendering | `█ ░ ▒ ▓` render correctly in terminals; MCP client rendering varies | Always wrap in ` ```text ``` ` fence; test in Claude Desktop |
| Timeline column misalignment | Proportional fonts break monospace alignment | ` ```text ``` ` fence enforces monospace in all MCP clients tested |
| Upstream `formatTime` conflict | Existing `formatTime()` is 12-hour AM/PM (en-US); our tick labels are 24-hour | Keep functions separate; `formatTimeFromOffset` is 24-hour only, used exclusively for the hypnogram timeline |
