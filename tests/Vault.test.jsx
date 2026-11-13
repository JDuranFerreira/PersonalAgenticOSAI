// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const { fsListMock, fsReadMock } = vi.hoisted(() => ({
  fsListMock: vi.fn(),
  fsReadMock: vi.fn(),
}));

vi.mock("../src/utils/api", () => ({
  fsList: (...args) => fsListMock(...args),
  fsRead: (...args) => fsReadMock(...args),
  fsSearch: vi.fn(async () => ({ results: [] })),
  fsRawUrl: (file) => `/raw/${file}`,
}));
vi.mock("../src/components/ResizeHandle.jsx", () => ({ default: () => null }));

import Vault from "../src/components/Vault.jsx";

beforeEach(() => {
  fsListMock.mockReset();
  fsReadMock.mockReset();
  fsReadMock.mockResolvedValue({ content: "# Existing note", size: 15 });
});

afterEach(() => cleanup());

describe("Vault folder navigation", () => {
  it("does not preview previous-folder entries under the newly selected path", async () => {
    fsListMock.mockImplementation((folder) => {
      if (folder === "Vault") {
        return Promise.resolve({ entries: [
          { name: "old-folder-note.md", type: "file", size: 15 },
          { name: "Notes", type: "dir" },
        ] });
      }
      // Leave the destination request pending so stale entries remain present,
      // reproducing the race that previously generated false 404 requests.
      return new Promise(() => {});
    });

    const { container } = render(<Vault />);
    await waitFor(() => expect(container.querySelector(".vault-folder-chip")).toBeTruthy());
    const folder = container.querySelector(".vault-folder-chip");
    await waitFor(() => expect(fsReadMock).toHaveBeenCalledWith("Vault/old-folder-note.md"));

    fsReadMock.mockClear();
    fireEvent.click(folder);

    await waitFor(() => expect(fsListMock).toHaveBeenCalledWith("Vault/Notes"));
    expect(fsReadMock).not.toHaveBeenCalledWith("Vault/Notes/old-folder-note.md");
  });
});
