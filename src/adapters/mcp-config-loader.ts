/**
 * MCP Config Loader — .mcp.json auto-discovery with consent bypass hardening.
 *
 * Reads .mcp.json from the project working directory at session-create time
 * and configures the agent's available MCP tools. This makes BeamCode a
 * first-class citizen of project-level toolchains.
 *
 * Security hardening (CVE-2026-21852 mitigation):
 *   - Blocklists dangerous override settings (autoApprove, trustAllServers)
 *   - Requires explicit user consent before activating project-scoped servers
 *   - Validates server configurations against known safe patterns
 *
 * @module Adapters
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../interfaces/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  /** Server command or URL. */
  command?: string;
  url?: string;
  /** Arguments to pass to the server command. */
  args?: string[];
  /** Environment variables to set. */
  env?: Record<string, string>;
  /** Server-specific configuration. */
  settings?: Record<string, unknown>;
}

export interface MCPConfigFile {
  /** Configuration format version. */
  version?: string;
  /** Map of server name → configuration. */
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface ValidatedMCPConfig {
  /** Servers that passed validation. */
  servers: Record<string, MCPServerConfig>;
  /** Servers that were blocked with reasons. */
  blocked: Array<{ name: string; reason: string }>;
  /** Whether user consent is required before activation. */
  requiresConsent: boolean;
  /** Path to the config file that was loaded. */
  configPath: string;
}

// ---------------------------------------------------------------------------
// Blocklisted settings (CVE-2026-21852)
// ---------------------------------------------------------------------------

/**
 * Settings that MUST NEVER be passed through from .mcp.json to the agent.
 * These can override safeguards and auto-approve all MCP servers.
 */
const BLOCKLISTED_SETTINGS = new Set([
  "autoApprove",
  "trustAllServers",
  "autoApproveAll",
  "skipConsentPrompt",
  "bypassSafeguards",
  "allowAllTools",
  "disableSandbox",
  "autoTrust",
]);

/**
 * Blocklisted environment variable names that could escalate privileges.
 */
const BLOCKLISTED_ENV_VARS = new Set([
  "CLAUDE_AUTO_APPROVE",
  "CLAUDE_TRUST_ALL",
  "MCP_AUTO_APPROVE",
  "MCP_SKIP_CONSENT",
  "BEAMCODE_BYPASS_CONSENT",
]);

/**
 * Command patterns that should not be allowed in .mcp.json.
 */
const BLOCKLISTED_COMMAND_PATTERNS = [
  /rm\s+-rf/i,
  /curl\s+.*\|\s*sh/i,
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /--no-verify/i,
  /--force/i,
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate .mcp.json from the given working directory.
 * Returns null if no config file exists.
 */
export async function loadMCPConfig(
  cwd: string,
  logger?: Logger,
): Promise<ValidatedMCPConfig | null> {
  const configPath = join(cwd, ".mcp.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    // No .mcp.json — totally normal, not an error.
    return null;
  }

  let config: MCPConfigFile;
  try {
    config = JSON.parse(raw) as MCPConfigFile;
  } catch (err) {
    logger?.warn?.("Invalid .mcp.json: failed to parse JSON", {
      component: "mcp-config-loader",
      path: configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return validateConfig(config, configPath, logger);
}

/**
 * Validate an MCP config against security rules.
 */
function validateConfig(
  config: MCPConfigFile,
  configPath: string,
  logger?: Logger,
): ValidatedMCPConfig {
  const servers: Record<string, MCPServerConfig> = {};
  const blocked: Array<{ name: string; reason: string }> = [];
  const mcpServers = config.mcpServers ?? {};

  for (const [name, serverConfig] of Object.entries(mcpServers)) {
    const issues = validateServer(name, serverConfig);

    if (issues.length > 0) {
      for (const issue of issues) {
        blocked.push({ name, reason: issue });
        logger?.warn?.(`Blocked MCP server "${name}": ${issue}`, {
          component: "mcp-config-loader",
          server: name,
        });
      }
    } else {
      // Strip any blocklisted settings that slipped through
      const sanitized = sanitizeConfig(serverConfig);
      servers[name] = sanitized;
    }
  }

  return {
    servers,
    blocked,
    requiresConsent: Object.keys(servers).length > 0,
    configPath,
  };
}

/**
 * Validate a single server configuration.
 * Returns an array of issues (empty = valid).
 */
function validateServer(name: string, config: MCPServerConfig): string[] {
  const issues: string[] = [];

  // Check blocklisted settings
  if (config.settings) {
    for (const key of Object.keys(config.settings)) {
      if (BLOCKLISTED_SETTINGS.has(key)) {
        issues.push(
          `Contains blocklisted setting "${key}" (CVE-2026-21852 mitigation)`,
        );
      }
    }
  }

  // Check blocklisted env vars
  if (config.env) {
    for (const key of Object.keys(config.env)) {
      if (BLOCKLISTED_ENV_VARS.has(key)) {
        issues.push(
          `Contains blocklisted env var "${key}" (privilege escalation risk)`,
        );
      }
    }
  }

  // Check command patterns
  if (config.command) {
    for (const pattern of BLOCKLISTED_COMMAND_PATTERNS) {
      if (pattern.test(config.command)) {
        issues.push(
          `Command matches blocklisted pattern: ${pattern.source}`,
        );
      }
    }
  }

  // Check args for suspicious patterns
  if (config.args) {
    const argsStr = config.args.join(" ");
    for (const pattern of BLOCKLISTED_COMMAND_PATTERNS) {
      if (pattern.test(argsStr)) {
        issues.push(
          `Arguments match blocklisted pattern: ${pattern.source}`,
        );
      }
    }
  }

  return issues;
}

/**
 * Remove blocklisted settings from a server config.
 */
function sanitizeConfig(config: MCPServerConfig): MCPServerConfig {
  const sanitized = { ...config };

  if (sanitized.settings) {
    const cleanSettings = { ...sanitized.settings };
    for (const key of BLOCKLISTED_SETTINGS) {
      delete cleanSettings[key];
    }
    sanitized.settings = cleanSettings;
  }

  if (sanitized.env) {
    const cleanEnv = { ...sanitized.env };
    for (const key of BLOCKLISTED_ENV_VARS) {
      delete cleanEnv[key];
    }
    sanitized.env = cleanEnv;
  }

  return sanitized;
}

/**
 * Format a consent prompt message for the user.
 * Called by the Web UI before launching sessions with project-scoped MCP servers.
 */
export function formatConsentPrompt(config: ValidatedMCPConfig): string {
  const serverNames = Object.keys(config.servers);
  const blockedNames = config.blocked.map((b) => b.name);

  let prompt = `This project has an .mcp.json file at:\n  ${config.configPath}\n\n`;

  if (serverNames.length > 0) {
    prompt += `The following MCP servers will be activated:\n`;
    for (const name of serverNames) {
      const srv = config.servers[name];
      prompt += `  - ${name}`;
      if (srv.command) prompt += ` (${srv.command})`;
      if (srv.url) prompt += ` (${srv.url})`;
      prompt += "\n";
    }
  }

  if (blockedNames.length > 0) {
    prompt += `\nThe following servers were BLOCKED for security reasons:\n`;
    for (const entry of config.blocked) {
      prompt += `  - ${entry.name}: ${entry.reason}\n`;
    }
  }

  prompt += "\nDo you want to proceed?";
  return prompt;
}
