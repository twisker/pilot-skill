import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Get PILOT_HOME directory (read at call time, not module load time)
 */
function getPilotHome(): string {
  return process.env.PILOT_HOME || path.join(homedir(), ".pilot");
}

/**
 * Format today's date as YYYYMMDD in local timezone
 */
function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${date}`;
}

/**
 * Atomically write file to disk (write to tmp with unique suffix, then rename)
 * Ensures durability and prevents partial writes under concurrent access.
 * @param filePath Target file path
 * @param content File content as string
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dirPath = path.dirname(filePath);

  // Ensure directory exists
  mkdirSync(dirPath, { recursive: true });

  // Generate unique tmp filename: ${filePath}.${pid}.${random}.tmp
  const randomSuffix = randomBytes(4).toString("hex");
  const tmpPath = `${filePath}.${process.pid}.${randomSuffix}.tmp`;

  // Write to temporary file
  writeFileSync(tmpPath, content);

  // Atomically rename to final location
  renameSync(tmpPath, filePath);
}

/**
 * Create a new trip with directory tree and current-trip.json pointer
 * Returns absolute path to workspace/<trip-id>
 */
export function createTrip(slug: string): string {
  const pilotHome = getPilotHome();
  const dateStr = getTodayDateString();
  const tripId = `${slug}-${dateStr}`;
  const tripPath = path.join(pilotHome, "workspace", tripId);

  // Create directory tree
  mkdirSync(path.join(tripPath, "raw"), { recursive: true });
  mkdirSync(path.join(tripPath, "travelogues"), { recursive: true });
  mkdirSync(path.join(tripPath, "exports"), { recursive: true });

  // Write current-trip.json atomically
  const currentTripData = {
    trip_id: tripId,
    updated_at: new Date().toISOString(),
  };
  const currentTripPath = path.join(pilotHome, "current-trip.json");
  atomicWriteFileSync(
    currentTripPath,
    JSON.stringify(currentTripData, null, 2)
  );

  return tripPath;
}

/**
 * Get the absolute path to a trip directory (throws if doesn't exist)
 */
export function tripDir(tripId: string): string {
  const pilotHome = getPilotHome();
  const path_ = path.join(pilotHome, "workspace", tripId);

  if (!existsSync(path_)) {
    throw new Error(`Trip directory not found: ${path_}`);
  }

  return path_;
}

/**
 * Read JSON file from trip directory
 */
export function readJson<T>(tripId: string, relPath: string): T {
  const pilotHome = getPilotHome();
  const filePath = path.join(pilotHome, "workspace", tripId, relPath);
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Atomically write JSON file to trip directory (write to tmp, then rename)
 */
export function writeJson<T>(tripId: string, relPath: string, data: T): void {
  const pilotHome = getPilotHome();
  const filePath = path.join(pilotHome, "workspace", tripId, relPath);
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Get current trip ID from current-trip.json, or null if not set
 */
export function currentTrip(): string | null {
  const pilotHome = getPilotHome();
  const currentTripPath = path.join(pilotHome, "current-trip.json");

  if (!existsSync(currentTripPath)) {
    return null;
  }

  try {
    const content = readFileSync(currentTripPath, "utf-8");
    const data = JSON.parse(content) as { trip_id: string; updated_at: string };
    return data.trip_id;
  } catch {
    return null;
  }
}
