# Implementation Plan: Exposing `sleep_phase_5_min` (Sleep Hypnogram)

This document outlines the proposed changes to the `oura-ring-mcp` server to support and expose the detailed 5-minute sleep phase sequence (hypnogram) in the `get_sleep` tool.

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

### A. Enhancing `formatSleepSession` in `src/tools/index.ts`
We will update `formatSleepSession` to check if `session.sleep_phase_5_min` is present and non-empty. If it is, we will generate an ASCII-art hypnogram timeline representing the sleep cycle over time.

### B. ASCII Hypnogram Formatting Helper
A helper function `generateHypnogramAscii(sleepPhaseStr: string, bedtimeStartStr: string): string` will be added to `src/utils/hypnogram.ts` (keeping `src/tools/index.ts` focused on tool logic). The function parses the string and maps each character to a vertical alignment:

```typescript
function formatHour(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function generateHypnogramAscii(sleepPhaseStr: string, bedtimeStart: string): string {
  if (!sleepPhaseStr || sleepPhaseStr.length === 0) return '';

  const phases = Array.from(sleepPhaseStr);
  const startTime = new Date(bedtimeStart);
  const CELL_WIDTH = 12; // epochs per hour = cell width in chars

  // Rows for different sleep stages
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

  // Build timeline with fixed CELL_WIDTH columns per hour tick
  let timeline = 'Time  | ';
  for (let i = 0; i < phases.length; i += CELL_WIDTH) {
    const tickTime = new Date(startTime.getTime() + i * 5 * 60 * 1000);
    const timeStr = formatHour(tickTime); // always "HH:MM" = 5 chars
    const remaining = Math.min(CELL_WIDTH, phases.length - i) - timeStr.length;
    timeline += timeStr + (remaining > 0 ? ' '.repeat(remaining) : '');
  }

  const separator = '-'.repeat(rows.awake.length);
  return [rows.awake, rows.rem, rows.light, rows.deep, separator, timeline].join('\n');
}
```

> **Note:** `formatHour` uses deterministic string padding instead of `toLocaleTimeString()` to avoid ICU locale differences across Node.js environments and Docker containers.

### C. Integrating into the `get_sleep` Output
We will append the formatted ASCII graph to the markdown response inside a code block:

```markdown
**Sleep Phase Timeline (5-Min Intervals):**
```text
Awake | ███          █   █
REM   |    ░░░      ░ ░░░ 
Light |       ▒▒▒  ▒       ▒▒
Deep  |          ▓▓         
------------------------------
Time  | 23:30       00:30       01:30
```
```

---

## 3. Data Storage Format (JSON)

If the data is exported or stored locally (e.g. in `sleep_history.json`), the sleep phase timeline will be structured as follows.

### Option A: Raw Sequence (Selected)
Stores the raw digit string and the starting timestamp. The timestamp of each interval can be calculated programmatically by adding `index * 5` minutes to `bedtime_start`. This is the recommended format: it is the smallest representation, is lossless, and Options B and C can be derived from it without data duplication.

```json
{
  "date": "2026-07-18",
  "bedtime_start": "2026-07-17T19:35:00Z",
  "sleep_phase_5_min_raw": "444423323441114"
}
```

### Option B: Array of Stage Names
An array of human-readable stage names mapped from the digits. Useful for readability but redundant if Option A is stored.

```json
{
  "date": "2026-07-18",
  "sleep_phase_5_min": [
    "awake", "awake", "awake", "awake", "light",
    "rem", "rem", "light", "rem", "awake",
    "awake", "deep", "deep", "deep", "awake"
  ]
}
```

### Option C: Explicit Timestamps (Detailed)
An array of objects mapping each 5-minute interval explicitly to its timestamp and stage. Most verbose; derive on demand rather than store.

```json
{
  "date": "2026-07-18",
  "sleep_phase_5_min_detailed": [
    {"time": "19:35", "stage": "awake"},
    {"time": "19:40", "stage": "awake"},
    {"time": "19:45", "stage": "awake"},
    {"time": "19:50", "stage": "awake"},
    {"time": "19:55", "stage": "light"}
  ]
}
```

---

## 4. Implementation Checklist

1. [ ] **Verify API detail level**: Confirm `src/client.ts` requests `detail_type=full` (or equivalent) so that `sleep_phase_5_min` is included in the API response — the field may be omitted on default/summary requests.
2. [ ] **Verify Types**: Ensure `sleep_phase_5_min` type matches generated schema types in `src/client.ts` and `src/types/oura-api.ts`.
3. [ ] **Create `src/utils/hypnogram.ts`**: Implement `formatHour` and `generateHypnogramAscii` as a standalone utility module, consistent with the existing `src/utils/` conventions.
4. [ ] **Update `formatSleepSession`**: Guard with `if (session.sleep_phase_5_min && session.sleep_phase_5_min.length > 0)` before calling the helper. Append the hypnogram output to the sleep session markdown.
5. [ ] **Write Tests**: Add unit tests in `src/utils/hypnogram.test.ts` covering:
   - Normal multi-hour session
   - Single epoch (edge case)
   - Empty string (must return `''` without throwing)
   - All-awake session (only awake row populated)
   - Missing `bedtime_start` (should handle gracefully)
6. [ ] **Integration test**: Add a test in `src/tools/index.test.ts` mocking a full sleep session with `sleep_phase_5_min` and asserting the rendered markdown contains the hypnogram block.
7. [ ] **Move this document to `docs/`**: Before opening a PR, move `sleep_phase_5_min.md` → `docs/sleep_phase_5_min.md` to keep the repository root clean.

---

## 5. Known Risks & Mitigations

| Risk | Detail | Mitigation |
|------|--------|------------|
| `sleep_phase_5_min` absent | Field may be `null` or missing for nap sessions or older data | Guard clause in `formatSleepSession` before calling helper |
| Unicode block chars rendering | `█ ░ ▒ ▓` render correctly in terminals but MCP clients vary | Test explicitly in Claude Desktop and target MCP clients |
| Timeline misalignment | Fixed `CELL_WIDTH = 12` assumes monospace font — proportional fonts will misalign | Always wrap output in a ` ```text ``` ` code block |
| ICU locale in Docker | `toLocaleTimeString()` behaves differently without full ICU data | Use `formatHour()` with manual `padStart` instead |
