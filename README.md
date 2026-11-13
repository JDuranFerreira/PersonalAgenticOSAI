# Agentic OS

A local React/Vite assistant interface with a Node/Express model proxy. The frontend runs on port `5174`; the proxy listens only on `127.0.0.1:5175`.

> **Repository scope:** publish this `AgenticOS` directory as its own GitHub repository. Do not initialize or publish the parent `C:\AIAssistant` directory. The sibling `C:\AIAssistant\AIAccess` contains personal Vault notes, calendar data, logs, routines, skills, and projects; it is local data, not source code. This repository's `.gitignore` cannot protect files outside `AgenticOS`.

## Requirements

- Node.js 20.19+ (Node 24 recommended)
- npm
- The backend uses fixed Windows directories for the project, AI Access content, and the read-only reference configuration

## Install and run

```sh
npm install
npm test
npm run lint
npm run build
```

Start the proxy and frontend in separate terminals:

```sh
node server/index.js
npm run dev
```

Open <http://localhost:5174>. On Windows, `scripts/start-agentic-os.ps1` starts both services and opens the page; use `-NoBrowser` to leave the browser closed.

The proxy reads provider credentials from the **read-only** reference file `C:/AgenticOS/config/.env`. Supported names include `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `NOUS_API_KEY` (or `HERMES_API_KEY`), `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`. Never commit that file or copy its values into this project.

## Chat behavior

- Text messages stream through the local proxy; the Stop button aborts the browser request and upstream provider request.
- Image attachments are sent as vision input; choose a vision-capable model. Text files are included as extracted text; PDFs have selectable text extracted locally. Other binary files appear by name/type but their contents are not extracted.
- Attachments are limited to 6 MB each, 5 per message, and 8 MB combined. Message history stores attachment metadata and extracted text, not image payloads.
- Markdown output is sanitized before rendering. Fenced code is syntax-highlighted and has a copy button.
- Conversation history is stored in browser `localStorage`.
- The plain Chat tab does not execute tools. Its approval prompt only asks the model to continue; use the Agents/Zazu workflow for supported tool actions.

## Local security

The proxy binds to IPv4 loopback and allows browser origins only from the local Vite UI. Do not change this to `0.0.0.0` or enable wildcard CORS: the proxy can access local files and manage user data. Filesystem paths are checked after resolving symlinks.

The **Security** tab runs a local pre-publish scan of this project for common credential patterns and checks that `.gitignore` protects local secrets and generated files. Findings include file names and line numbers only; matched values are never returned to the browser. This is a heuristic check, not a guarantee, and it does not upload or change anything on GitHub. Review your staged files before pushing. If a secret was ever committed, revoke/rotate it because deleting it does not remove it from Git history.

Provider credentials are read from the external `C:/AgenticOS/config/.env` file and are not needed in this repository. Keep real credentials out of source files and out of `.env.example`.

## Publish to GitHub and set up a clone

To create the first Git repository and publish only the Agentic OS source:

1. Create an **empty** GitHub repository named `AgenticOS`. Do not initialize it with a README, license, or `.gitignore`—this folder already contains those files.
2. Before staging, start the app and run **Security → Run audit**. Then, in PowerShell, initialize Git from the `AgenticOS` folder and inspect what will be committed:

```powershell
Set-Location C:\AIAssistant\AgenticOS
git init -b main
git add .
git status --short
git diff --cached --name-only
```

Review the staged files. They should be only the contents of `AgenticOS`, not the parent folder or `AIAccess`. Then commit and push (replace the URL with your own GitHub repository URL):

```powershell
git commit -m "Initial Agentic OS commit"
git remote add origin https://github.com/<your-account>/AgenticOS.git
git push -u origin main
```

Authenticate with Git Credential Manager or `gh auth login`. Never put a personal access token in source code, a remote URL, or a command that will be saved in shell history. If using GitHub Desktop, choose `C:\AIAssistant\AgenticOS` as the repository folder, not its parent.

To clone this repository on a Windows machine, use the expected source path and install the locked dependencies:

```powershell
New-Item -ItemType Directory -Force C:\AIAssistant | Out-Null
git clone https://github.com/<your-account>/AgenticOS.git C:\AIAssistant\AgenticOS
Set-Location C:\AIAssistant\AgenticOS
npm ci
```

The backend expects provider credentials in the external, local-only file `C:\AgenticOS\config\.env`. It recognizes `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `NOUS_API_KEY` (or `HERMES_API_KEY`), `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`; configure only providers you use. Keep real values in that external file or a secret manager—never in this repository or a committed `.env.example`. Ollama is optional for local models.

The app's Vault, calendar, routines, logs, installed skills, and projects are local data under the sibling folder `C:\AIAssistant\AIAccess`. Keep your own data there; do not copy it into the repository or upload it to GitHub.

Run the backend and frontend in separate PowerShell terminals from `C:\AIAssistant\AgenticOS`:

```powershell
# Terminal 1
node server/index.js
```

```powershell
# Terminal 2
npm run dev
```

Open <http://localhost:5174>. Alternatively, `scripts/start-agentic-os.ps1` starts both services and opens the app; use `-NoBrowser` to leave the browser closed. The helper writes logs under `AIAccess\Vault\Logs\AgenticOS`, outside the repository.

### Before every push

- In the app's **Security** tab, select **Run audit**. The scan stays local and reports file names and line numbers only; it never returns matching values to the UI.
- The audit scans this project only. It does **not** scan the external `AIAccess` or `C:\AgenticOS\config\.env` folders, and it does not inspect Git history. It is heuristic, not a guarantee.
- Review the staged file list yourself. `.gitignore` does not untrack files that were already committed. Enable GitHub secret scanning and push protection when available.
- If a real credential was committed at any point, revoke/rotate it; deleting it from the latest version does not remove it from Git history.
- Conversation history is stored in browser `localStorage`. Messages sent to cloud models are processed by the selected provider; don't include secrets or private information in prompts unless you intend to share them with that provider.

## Project layout

- `src/` — React UI, components, agents, and API client
- `server/` — local Express model and filesystem proxy
- `scripts/` — Windows startup helper
- `tests/` — Vitest and React Testing Library regression tests
