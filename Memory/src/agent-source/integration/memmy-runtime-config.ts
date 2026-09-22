/** Memmy runtime config helpers. */
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { deriveWorkspaceHostId } from "../../contracts/index.js";
import { getOrCreateInstallationId } from "../../cli/analytics.js";

export interface MemmyMemoryServiceConfig {
  endpoint: string;
  token: string;
  userId: string;
  workspaceHostId: string;
}

/** Reads Memmy memory service endpoint and token from the local config file. */
export async function readMemmyMemoryServiceConfig(configPath: string): Promise<MemmyMemoryServiceConfig> {
  const content = await readTextFile(configPath);
  const parsed = content.trim() ? YAML.parse(content) : {};
  const root = toMutableRecord(parsed);
  const memmyMemory = toMutableRecord(root.memmyMemory);
  const storage = toMutableRecord(memmyMemory.storage);
  const legacyStorage = toMutableRecord(root.storage);
  const app = toMutableRecord(root.app);
  const credentialUserId = jwtSubject(normalizeString(app.cloudUuid));
  const appUserId = normalizeUserId(app.userId, "app.userId", credentialUserId);
  const memoryUserId = normalizeUserId(memmyMemory.userId, "memmyMemory.userId", credentialUserId);
  if (!credentialUserId && appUserId && memoryUserId && appUserId !== memoryUserId) {
    throw new Error("Memmy config has conflicting app.userId and memmyMemory.userId values");
  }
  return {
    endpoint: normalizeString(storage.endpoint) ||
      normalizeString(memmyMemory.endpoint) ||
      normalizeString(legacyStorage.endpoint) ||
      "http://127.0.0.1:18960",
    token: normalizeString(storage.token) ||
      normalizeString(memmyMemory.token) ||
      normalizeString(legacyStorage.token),
    userId: credentialUserId || appUserId || memoryUserId || "local-user",
    workspaceHostId: deriveWorkspaceHostId(getOrCreateInstallationId())
  };
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUserId(value: unknown, field: string, credentialUserId: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    if (
      credentialUserId &&
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      String(value) === String(Number(credentialUserId))
    ) {
      return credentialUserId;
    }
    throw new Error(`${field} must be a string; numeric account IDs can lose precision`);
  }
  return value.trim();
}

function jwtSubject(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return isRecord(payload) && typeof payload.sub === "string" ? payload.sub.trim() : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
