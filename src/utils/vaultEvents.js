/* ==========================================================================
   Agentic OS — Vault navigation events
   Zazu opens a note with [[NAVIGATE: vault:Notes/agents.md]]. If the Vault
   is already mounted it receives VAULT_OPEN_EVENT; otherwise it picks the
   pending path up from sessionStorage when it mounts.
   ========================================================================== */
export const VAULT_OPEN_EVENT = "agentic_os_vault_open";
export const VAULT_PENDING_KEY = "agentic_os_vault_pending";
