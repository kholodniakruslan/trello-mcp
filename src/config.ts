import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const CONFIG_DIR = join(homedir(), ".config", "trello-mcp");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type AuthMode = "auto" | "manual";

export interface TrelloConfig {
  apiKey?: string;
  token?: string;
  authMode?: AuthMode;
  lang?: string;
}

export function loadConfig(): TrelloConfig {
  let file: TrelloConfig = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  const mode = process.env.TRELLO_AUTH_MODE || file.authMode;
  return {
    apiKey: process.env.TRELLO_API_KEY || file.apiKey,
    token: process.env.TRELLO_TOKEN || file.token,
    authMode: mode === "auto" || mode === "manual" ? mode : undefined,
    lang: process.env.TRELLO_LANG || file.lang,
  };
}
