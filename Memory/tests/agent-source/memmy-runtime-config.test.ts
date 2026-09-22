import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMemmyMemoryServiceConfig } from "../../src/agent-source/integration/memmy-runtime-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Memmy integration runtime config", () => {
  it("preserves account ids larger than the JavaScript safe integer range as strings", async () => {
    const path = config([
      "app:",
      '  userId: "2099683346800345089"',
      "memmyMemory:",
      '  userId: "2099683346800345089"',
      ""
    ]);

    await expect(readMemmyMemoryServiceConfig(path)).resolves.toMatchObject({
      userId: "2099683346800345089"
    });
  });

  it("rejects numeric and conflicting account owner fields", async () => {
    await expect(readMemmyMemoryServiceConfig(config([
      "app:",
      "  userId: 2099683346800345089",
      ""
    ]))).rejects.toThrow("app.userId must be a string");

    await expect(readMemmyMemoryServiceConfig(config([
      "app:",
      '  userId: "owner-a"',
      "memmyMemory:",
      '  userId: "owner-b"',
      ""
    ]))).rejects.toThrow("conflicting app.userId and memmyMemory.userId");
  });

  it("uses the credential subject to repair a previously rounded string id at installation", async () => {
    const exactUserId = "2099683346800345089";
    const credential = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: exactUserId })).toString("base64url"),
      "signature"
    ].join(".");

    await expect(readMemmyMemoryServiceConfig(config([
      "app:",
      `  cloudUuid: ${credential}`,
      '  userId: "2099683346800345000"',
      "memmyMemory:",
      '  userId: "2099683346800345000"',
      ""
    ]))).resolves.toMatchObject({ userId: exactUserId });
  });
});

function config(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-runtime-config-"));
  roots.push(root);
  const path = join(root, "config.yaml");
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}
