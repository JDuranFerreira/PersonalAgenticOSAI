import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditGitHubSafety, isOriginAllowed, isPathWithinRoots, LOCAL_HOST } from "../server/security.js";

describe("local server security", () => {
  it("allows only the local UI origins and binds to loopback", () => {
    expect(LOCAL_HOST).toBe("127.0.0.1");
    expect(isOriginAllowed("http://localhost:5174")).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:5174")).toBe(true);
    expect(isOriginAllowed("https://attacker.example")).toBe(false);
    expect(isOriginAllowed(undefined)).toBe(true);
  });

  it("rejects symlink paths that resolve outside an allowed root", () => {
    const scratch = process.env.TMPDIR || process.cwd();
    const root = mkdtempSync(path.join(scratch, "agenticos-secure-root-"));
    const outside = mkdtempSync(path.join(scratch, "agenticos-outside-"));
    try {
      mkdirSync(path.join(root, "inside"));
      writeFileSync(path.join(outside, "secret.txt"), "secret");
      try {
        symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return;
        throw error;
      }
      expect(isPathWithinRoots(path.join(root, "inside", "new.txt"), [root])).toBe(true);
      expect(isPathWithinRoots(path.join(root, "escape", "secret.txt"), [root])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports credential locations without returning matching secret values", () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || process.cwd(), "agenticos-audit-"));
    const secret = ["sk-this-is-a-super-", "secret-value-never-return-it"].join("");
    const privateEmail = ["private.person", "@samplemail.net"].join("");
    const privatePath = ["C:", "\\\\", "Users", "\\\\", "Jose", "\\\\", "project"].join("");
    try {
      writeFileSync(path.join(root, ".gitignore"), ".env\n.env.*\n*.env\n*.pem\n*.key\ncredentials/\nsecrets/\nnode_modules/\ndist/\n");
      writeFileSync(path.join(root, "config.js"), `const apiKey = "${secret}";\n// contact: ${privateEmail}\n// local: ${privatePath}\n`);
      writeFileSync(path.join(root, ".env.local"), `OPENROUTER_API_KEY=${secret}\n`);
      mkdirSync(path.join(root, "node_modules"));
      writeFileSync(path.join(root, "node_modules", "ignored.js"), `const apiKey = "${secret}";\n`);

      const result = auditGitHubSafety(root);
      const serialized = JSON.stringify(result);

      expect(result.gitignorePresent).toBe(true);
      expect(Object.values(result.protections).every(Boolean)).toBe(true);
      expect(result.findings.some((finding) => finding.file === "config.js" && finding.line === 1)).toBe(true);
      expect(result.findings.some((finding) => finding.category === "Personal email address" && finding.line === 2)).toBe(true);
      expect(result.findings.some((finding) => finding.category === "Personal Windows user path" && finding.line === 3)).toBe(true);
      expect(result.findings.some((finding) => finding.file === ".env.local")).toBe(true);
      expect(result.findings.some((finding) => finding.file.includes("node_modules"))).toBe(false);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(privateEmail);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
