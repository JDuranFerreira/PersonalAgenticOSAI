// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", async () => {
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  return { default: pathToFileURL(resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")).href };
});
import { prepareAttachment } from "../src/utils/attachments.js";

function makePdf(text) {
  const content = `BT /F1 18 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new File([pdf], "memo.pdf", { type: "application/pdf" });
}

describe("attachment preparation", () => {
  it("extracts text from text attachments for the model prompt", async () => {
    const prepared = await prepareAttachment(new File(["first line\nsecond line"], "note.txt", { type: "text/plain" }));
    expect(prepared.name).toBe("note.txt");
    expect(prepared.modelText).toContain("first line\nsecond line");
  });

  it("encodes images as model-compatible image URL parts", async () => {
    const prepared = await prepareAttachment(new File([new Uint8Array([137, 80, 78, 71])], "tiny.png", { type: "image/png" }));
    expect(prepared.previewUrl).toMatch(/^data:image\/png;base64,/);
    expect(prepared.imagePart.type).toBe("image_url");
    expect(prepared.imagePart.image_url.url).toBe(prepared.previewUrl);
  });

  it("rejects SVG and other active image formats instead of previewing them", async () => {
    const file = new File(["<svg onload=alert(1) />"], "graphic.svg", { type: "image/svg+xml" });
    await expect(prepareAttachment(file)).rejects.toThrow(/PNG, JPEG, GIF, or WebP/);
  });

  it("extracts selectable text from PDF attachments", async () => {
    const prepared = await prepareAttachment(makePdf("Hello PDF"));
    expect(prepared.modelText).toContain("Hello PDF");
  });

  it("rejects a single attachment larger than the safe request limit", async () => {
    const file = { name: "large.txt", type: "text/plain", size: 6 * 1024 * 1024 + 1 };
    await expect(prepareAttachment(file)).rejects.toThrow(/6 MB/);
  });
});
