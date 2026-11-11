// Offline checks for localisation: dictionary parity and the language-selection priority (no Trello account needed).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictionaries, systemLang } from "../build/i18n.js";

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", label, ok ? "" : extra); };

// ---- 1. dictionaries ----
const langs = Object.keys(dictionaries);
const keys = Object.keys(dictionaries.en);
for (const l of langs) check(`dictionary ${l}: same keys as en`, JSON.stringify(Object.keys(dictionaries[l]).sort()) === JSON.stringify([...keys].sort()));
const sample = { port: 1111, cfg: "CFGPATH", url: "URLVALUE", user: "USERNAME", status: 401, body: "BODYTEXT", msg: "MSGTEXT", closed: true };
for (const k of keys) {
  const base = dictionaries.en[k](sample);
  const vars = Object.entries(sample).filter(([, v]) => typeof v !== "boolean" && base.includes(String(v))).map(([, v]) => String(v));
  for (const l of langs) {
    const out = dictionaries[l][k](sample);
    check(`${l}.${k}: non-empty, keeps all placeholders`, out.length > 0 && vars.every((v) => out.includes(v)), out.slice(0, 80));
  }
}
check("systemLang: unsupported system language falls back to en", systemLang({ LANG: "fr_FR.UTF-8" }) === "en");
check("systemLang: ru_RU.UTF-8 -> ru", systemLang({ LANG: "ru_RU.UTF-8" }) === "ru");
check("systemLang: LC_ALL beats LANG", systemLang({ LC_ALL: "uk_UA.UTF-8", LANG: "en_US.UTF-8" }) === "uk");

// ---- 2. priority, through the real server (config has only an API key, so no network is needed) ----
const home = mkdtempSync(join(tmpdir(), "trello-i18n-"));
mkdirSync(join(home, ".config", "trello-mcp"), { recursive: true });
writeFileSync(join(home, ".config", "trello-mcp", "config.json"), JSON.stringify({ apiKey: "0".repeat(32) }));
const MARK = { en: "MANUAL CONNECTION", ru: "РУЧНОЕ ПОДКЛЮЧЕНИЕ", uk: "РУЧНЕ ПІДКЛЮЧЕННЯ" };
const which = (text) => Object.entries(MARK).find(([, m]) => text.includes(m))?.[0] ?? "?";

async function session(env, calls) {
  const c = new Client({ name: "i18n", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["build/index.js"], stderr: "ignore", env: { PATH: process.env.PATH, HOME: home, ...env } }));
  const out = [];
  for (const args of calls) out.push(which((await c.callTool({ name: "trello_connect", arguments: { mode: "manual", ...args } })).content[0].text));
  await c.close();
  return out;
}
const cases = [
  ["system uk, nothing asked -> uk",            { LANG: "uk_UA.UTF-8" }, [{}], ["uk"]],
  ["system ru, nothing asked -> ru",            { LANG: "ru_RU.UTF-8" }, [{}], ["ru"]],
  ["system fr (no dictionary) -> en",           { LANG: "fr_FR.UTF-8" }, [{}], ["en"]],
  ["asked en beats system ru",                  { LANG: "ru_RU.UTF-8" }, [{ lang: "en" }], ["en"]],
  ["asked uk beats system en",                  { LANG: "en_US.UTF-8" }, [{ lang: "uk" }], ["uk"]],
  ["asked ru-RU is normalised to ru",           { LANG: "en_US.UTF-8" }, [{ lang: "ru-RU" }], ["ru"]],
  ["asked es (no dictionary) -> en, not system", { LANG: "ru_RU.UTF-8" }, [{ lang: "es" }], ["en"]],
  ["garbage lang is ignored -> system",         { LANG: "uk_UA.UTF-8" }, [{ lang: "??" }], ["uk"]],
  ["asked language is remembered next call",    { LANG: "en_US.UTF-8" }, [{ lang: "ru" }, {}], ["ru", "ru"]],
  ["latest asked language wins",                { LANG: "en_US.UTF-8" }, [{ lang: "ru" }, { lang: "uk" }], ["ru", "uk"]],
  ["pinned TRELLO_LANG beats asked",            { LANG: "en_US.UTF-8", TRELLO_LANG: "uk" }, [{ lang: "ru" }], ["uk"]],
];
for (const [label, env, calls, expected] of cases) {
  const got = await session(env, calls);
  check(label, JSON.stringify(got) === JSON.stringify(expected), `got ${got}`);
}

// ---- 3. every tool advertises the optional `lang` argument ----
{
  const c = new Client({ name: "i18n", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["build/index.js"], stderr: "ignore", env: { PATH: process.env.PATH, HOME: home } }));
  const tools = (await c.listTools()).tools;
  check(`all ${tools.length} tools have an optional lang argument`, tools.every((t) => t.inputSchema.properties?.lang && !(t.inputSchema.required ?? []).includes("lang")));
  check("server instructions mention lang", (c.getInstructions() ?? "").includes("`lang`"));
  await c.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
