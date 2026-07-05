import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTrip,
  tripDir,
  readJson,
  writeJson,
  currentTrip,
} from "../lib/workspace";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Test with a temporary PILOT_HOME directory
let testPilotHome: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-test-"));
  process.env.PILOT_HOME = testPilotHome;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

describe("workspace", () => {
  it("createTrip creates directory tree and writes current-trip.json", () => {
    const tripPath = createTrip("test-trip");

    // Check that path matches format: workspace/<slug>-<yyyymmdd>
    expect(tripPath).toMatch(/workspace\/test-trip-\d{8}$/);
    expect(existsSync(tripPath)).toBe(true);

    // Check subdirectories exist
    expect(existsSync(path.join(tripPath, "raw"))).toBe(true);
    expect(existsSync(path.join(tripPath, "travelogues"))).toBe(true);
    expect(existsSync(path.join(tripPath, "exports"))).toBe(true);

    // Check current-trip.json exists and has correct structure
    const currentTripPath = path.join(testPilotHome, "current-trip.json");
    expect(existsSync(currentTripPath)).toBe(true);

    const content = JSON.parse(require("node:fs").readFileSync(currentTripPath, "utf-8"));
    expect(content.trip_id).toMatch(/test-trip-\d{8}$/);
    expect(content.updated_at).toBeDefined();
    // Verify it's valid ISO8601
    expect(new Date(content.updated_at).toISOString()).toBe(content.updated_at);
  });

  it("readJson and writeJson work together", () => {
    const tripPath = createTrip("test-trip");
    const testData = { name: "Test Journey", days: 10 };
    const relPath = "itinerary.json";

    // Write JSON
    writeJson(path.basename(tripPath), relPath, testData);

    // Read it back
    const read = readJson<typeof testData>(path.basename(tripPath), relPath);
    expect(read).toEqual(testData);
  });

  it("currentTrip returns null when no current-trip.json exists", () => {
    const result = currentTrip();
    expect(result).toBe(null);
  });

  it("tripDir throws error when directory does not exist", () => {
    expect(() => tripDir("nonexistent-20260101")).toThrow();
  });
});
