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
We will update `formatSleepSession` to check if `session.sleep_phase_5_min` is present. If it is, we will generate an ASCII-art hypnogram timeline representing the sleep cycle over time.

### B. ASCII Hypnogram Formatting Helper
A helper function `generateHypnogramAscii(sleepPhaseStr: string, bedtimeStartStr: string): string` will be added to parse the string and map each character to a vertical alignment:

```typescript
function generateHypnogramAscii(sleepPhaseStr: string, bedtimeStart: string): string {
  const phases = Array.from(sleepPhaseStr);
  const startTime = new Date(bedtimeStart);
  
  // Rows for different sleep stages
  const rows = {
    awake: "Awake | ",
    rem:   "REM   | ",
    light: "Light | ",
    deep:  "Deep  | ",
  };

  phases.forEach((char) => {
    rows.awake += (char === '4') ? "█" : " ";
    rows.rem   += (char === '3') ? "░" : " ";
    rows.light += (char === '2') ? "▒" : " ";
    rows.deep  += (char === '1') ? "▓" : " ";
  });

  // Calculate timeline ticks (every 1 hour)
  let timeline = "Time  | ";
  const totalMinutes = phases.length * 5;
  for (let i = 0; i < phases.length; i += 12) { // 12 epochs of 5 mins = 1 hour
    const tickTime = new Date(startTime.getTime() + i * 5 * 60 * 1000);
    const timeStr = tickTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    
    // Pad to match spacing
    timeline += timeStr;
    const remainingToNextTick = Math.min(12, phases.length - i) - timeStr.length;
    if (remainingToNextTick > 0) {
      timeline += " ".repeat(remainingToNextTick);
    }
  }

  return [
    rows.awake,
    rows.rem,
    rows.light,
    rows.deep,
    "-".repeat(rows.awake.length),
    timeline
  ].join("\n");
}
```

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
Time  | 23:30 00:30 01:30 02:30
```
```

---

## 3. Data Storage Format (JSON)

If the data is exported or stored locally (e.g. in `sleep_history.json`), the sleep phase timeline will be structured in one of the following formats inside the JSON objects:

### Option A: Raw Sequence (Selected)
Stores the raw digit string and the starting timestamp. The timestamp of each interval can be calculated programmatically by adding `index * 5` minutes to `bedtime_start`.
```json
{
  "date": "2026-07-18",
  "bedtime_start": "2026-07-17T19:35:00Z",
  "sleep_phase_5_min_raw": "444423323441114"
}
```

### Option B: Array of Stage Names
An array of human-readable stage names mapped from the digits:
- `1` -> `"deep"`
- `2` -> `"light"`
- `3` -> `"rem"`
- `4` -> `"awake"`

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
An array of objects mapping each 5-minute interval explicitly to its timestamp and stage:
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

1. [ ] **Verify Types**: Ensure `sleep_phase_5_min` type matches generated schema types in `src/client.ts` and `src/types/oura-api.ts`.
2. [ ] **Implement Formatter**: Write `generateHypnogramAscii` helper function in `src/tools/index.ts`.
3. [ ] **Update formatSleepSession**: Call the helper function and append its output to the sleep session markdown.
4. [ ] **Write Tests**: Add a test case in `src/tools/index.test.ts` to mock a sleep session containing `sleep_phase_5_min` and assert it is parsed and rendered correctly in the test response.

