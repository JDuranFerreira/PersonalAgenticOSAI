export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARS = 120_000;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml",
  ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".cs",
  ".go", ".rs", ".sql", ".sh", ".log", ".ini", ".toml", ".env",
]);

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

async function extractPdfText(file) {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerModule.default;
  const loadingTask = getDocument({ data: await file.arrayBuffer(), useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    const pages = [];
    const pageLimit = Math.min(document.numPages, 40);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      pages.push(text.items.map((item) => item.str || "").join(" "));
      if (pages.join("\n").length >= MAX_ATTACHMENT_TEXT_CHARS) break;
    }
    const result = pages.join("\n").slice(0, MAX_ATTACHMENT_TEXT_CHARS);
    return result || "No selectable text found; this PDF may be scanned or image-only.";
  } finally {
    await loadingTask.destroy();
  }
}

export async function prepareAttachment(file) {
  if (!file || typeof file.size !== "number") throw new Error("Invalid attachment");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} exceeds the 6 MB attachment limit`);

  const name = String(file.name || "attachment");
  const type = String(file.type || "application/octet-stream");
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  const attachment = { name, type, size: file.size, previewUrl: "", modelText: "", imagePart: null };

  if (type.toLowerCase().startsWith("image/")) {
    if (!/^image\/(png|jpeg|gif|webp)$/i.test(type)) {
      throw new Error("Supported image attachments are PNG, JPEG, GIF, or WebP.");
    }
    attachment.previewUrl = await readAsDataUrl(file);
    attachment.imagePart = { type: "image_url", image_url: { url: attachment.previewUrl } };
    return attachment;
  }

  if (type === "application/pdf" || extension === ".pdf") {
    attachment.modelText = await extractPdfText(file);
    return attachment;
  }

  if (type.startsWith("text/") || TEXT_EXTENSIONS.has(extension) || /json|xml|yaml/i.test(type)) {
    const text = await file.text();
    attachment.modelText = text.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
    if (text.length > MAX_ATTACHMENT_TEXT_CHARS) attachment.modelText += "\n[Attachment text truncated at 120,000 characters.]";
    return attachment;
  }

  attachment.modelText = `The file “${name}” (${type}, ${file.size} bytes) is attached, but this file type cannot be text-extracted.`;
  return attachment;
}
