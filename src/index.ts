#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { currentLang, setAskedLang, t } from "./i18n.js";

import {
  AuthError, PORT, connectAuto, connectManual, credentials, currentMode, ensureAuth, forgetToken,
  hasApiKey, isConnected, manualInstructions, recentLog,
} from "./auth.js";

const BASE = "https://api.trello.com/1";

type Params = Record<string, string | number | boolean | undefined>;

async function trello(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  params: Params = {},
  opts: { retry?: boolean; body?: unknown } = {}
): Promise<unknown> {
  const retry = opts.retry ?? true;
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(30_000),
    ...(opts.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(opts.body) } : {}),
  };
  await ensureAuth();
  const { apiKey, token } = credentials();
  const url = new URL(BASE + path);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  let res = await fetch(url, init);
  // Trello rate limit (429): wait as the server asks (or back off) and retry up to 3 times.
  for (let attempt = 1; res.status === 429 && attempt <= 3; attempt++) {
    const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
    console.error(`Trello rate limit hit, retrying in ${wait}s (attempt ${attempt}/3)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await fetch(url, init);
  }
  const text = await res.text();
  if (res.status === 401 && retry) {
    // Token revoked/expired: drop it and re-run the browser authorization once.
    forgetToken();
    return trello(method, path, params, { ...opts, retry: false });
  }
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = new McpServer(
  { name: "trello", version: "1.3.0" },
  {
    capabilities: { logging: {} },
    instructions:
      "Always reply to the user in the language they write in (if you cannot tell, use the system language, otherwise English). " +
      "Pass that language as the optional `lang` argument (ISO 639-1, e.g. en, ru, uk) on every tool call so that the server's own " +
      "messages (connection instructions, progress log, browser page) come back in the same language. " +
      "If Trello is not connected, ask the user whether they prefer automatic or manual connection, then call trello_connect.",
  }
);

// Every tool gets an optional `lang` argument; it is stripped before the handler runs and remembered for the session.
const LANG_ARG = z.string().optional().describe(
  "ISO 639-1 code of the language the user is writing in (e.g. en, ru, uk). Always pass it: server messages are returned in this language."
);
{
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: any, handler: any) =>
    original(name, { ...config, inputSchema: { ...(config.inputSchema ?? {}), lang: LANG_ARG } }, (args: any, extra: any) => {
      const { lang, ...rest } = args ?? {};
      if (lang) setAskedLang(lang);
      return handler(rest, extra);
    });
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

// Wraps a handler: serializes the result as JSON text and turns errors into tool errors.
function tool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T): Promise<Result> => {
    try {
      const data = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      };
    }
  };
}

// ---------- Connection ----------
server.registerTool(
  "trello_status",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Show Trello connection status: whether the API key and token are set, the auth mode, and the recent connection log.",
    inputSchema: {},
  },
  async () => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        connected: isConnected(),
        apiKeyConfigured: hasApiKey(),
        defaultAuthMode: currentMode() ?? t("statusModeUnset"),
        language: currentLang(),
        authCallbackPort: PORT,
        recentLog: recentLog(),
        hint: isConnected() ? undefined : t("statusHint"),
      }, null, 2),
    }],
  })
);

server.registerTool(
  "trello_connect",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      "Connect to Trello. mode=auto: opens the browser, the user clicks Allow, the token is captured and saved automatically. " +
      "mode=manual: without `token` returns step-by-step instructions; with `token` verifies and saves it. " +
      "Ask the user which mode they prefer before calling.",
    inputSchema: {
      mode: z.enum(["auto", "manual"]),
      token: z.string().optional().describe("manual mode only: the token the user copied from Trello"),
      force: z.boolean().default(false).describe("reconnect even if already connected"),
    },
  },
  async ({ mode, token, force }, extra): Promise<Result> => {
    const lines: string[] = [];
    // Stream each step to the client as a log notification, and keep it for the final answer.
    const log = (msg: string) => {
      lines.push(msg);
      void extra.sendNotification({ method: "notifications/message", params: { level: "info", logger: "trello", data: msg } }).catch(() => {});
    };
    try {
      if (isConnected() && !force) {
        return { content: [{ type: "text", text: t("alreadyConnected") }] };
      }
      if (force && isConnected()) forgetToken();
      if (mode === "auto") {
        await connectAuto(log);
      } else if (token) {
        await connectManual(token, log);
      } else {
        return { content: [{ type: "text", text: manualInstructions() }] };
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: [...lines, e instanceof Error ? e.message : String(e)].join("\n") }],
      };
    }
  }
);

// ---------- Boards ----------
server.registerTool(
  "list_boards",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "List the boards of the current Trello user.",
    inputSchema: { filter: z.enum(["open", "closed", "all"]).default("open") },
  },
  tool(async ({ filter }) =>
    trello("GET", "/members/me/boards", { filter, fields: "name,desc,url,closed" })
  )
);

server.registerTool(
  "get_board",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Get a board's details.",
    inputSchema: { boardId: z.string() },
  },
  tool(async ({ boardId }) =>
    trello("GET", `/boards/${boardId}`, { fields: "name,desc,url,closed,idOrganization" })
  )
);

server.registerTool(
  "create_board",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Create a new board.",
    inputSchema: { name: z.string(), desc: z.string().optional() },
  },
  tool(async ({ name, desc }) => trello("POST", "/boards", { name, desc }))
);

// ---------- Lists ----------
server.registerTool(
  "get_lists",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Get the lists on a board.",
    inputSchema: { boardId: z.string(), filter: z.enum(["open", "closed", "all"]).default("open") },
  },
  tool(async ({ boardId, filter }) => trello("GET", `/boards/${boardId}/lists`, { filter }))
);

server.registerTool(
  "create_list",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Create a list on a board.",
    inputSchema: { boardId: z.string(), name: z.string(), pos: z.string().optional() },
  },
  tool(async ({ boardId, name, pos }) =>
    trello("POST", "/lists", { idBoard: boardId, name, pos: pos ?? "bottom" })
  )
);

server.registerTool(
  "archive_list",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Archive (close) a list.",
    inputSchema: { listId: z.string() },
  },
  tool(async ({ listId }) => trello("PUT", `/lists/${listId}/closed`, { value: true }))
);

// ---------- Cards ----------
server.registerTool(
  "get_cards",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description:
      "Get the cards in a list, or on a board (provide exactly one of listId/boardId). Returns an array. " +
      "For big boards paginate with `limit` and `offset`: the result is then {total, offset, returned, hasMore, cards}; " +
      "call again with offset += limit while hasMore is true. `filter`: open (default), closed (archived) or all. " +
      "`compact` drops descriptions and labels to save space. Reads up to 1000 cards.",
    inputSchema: {
      listId: z.string().optional(),
      boardId: z.string().optional(),
      filter: z.enum(["open", "closed", "all"]).default("open"),
      limit: z.number().int().min(1).max(1000).optional().describe("Page size; enables paginated output"),
      offset: z.number().int().min(0).optional().describe("How many cards to skip (with limit)"),
      compact: z.boolean().default(false),
    },
  },
  tool(async ({ listId, boardId, filter, limit, offset, compact }) => {
    if (!!listId === !!boardId) throw new Error("Provide exactly one of listId or boardId.");
    const path = listId ? `/lists/${listId}/cards/${filter}` : `/boards/${boardId}/cards/${filter}`;
    const fields = compact ? "name,due,dueComplete,idList,closed,url" : "name,desc,due,dueComplete,start,idList,labels,url,closed";
    const all = (await trello("GET", path, { fields, limit: 1000 })) as unknown[];
    if (limit === undefined && offset === undefined) return all;
    const start = offset ?? 0;
    const cards = limit === undefined ? all.slice(start) : all.slice(start, start + limit);
    return { total: all.length, offset: start, returned: cards.length, hasMore: start + cards.length < all.length, cards };
  })
);

server.registerTool(
  "get_card",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Get a card's full details, including checklists and members.",
    inputSchema: { cardId: z.string() },
  },
  tool(async ({ cardId }) =>
    trello("GET", `/cards/${cardId}`, { checklists: "all", members: true, attachments: true, customFieldItems: true })
  )
);

server.registerTool(
  "create_card",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Create a card in a list.",
    inputSchema: {
      listId: z.string(),
      name: z.string(),
      desc: z.string().optional(),
      due: z.string().optional().describe("ISO 8601 date"),
      start: z.string().optional().describe("Start date, ISO 8601"),
      pos: z.string().optional().describe("top, bottom, or a number"),
      idLabels: z.string().optional().describe("Comma-separated label ids"),
      idMembers: z.string().optional().describe("Comma-separated member ids"),
    },
  },
  tool(async ({ listId, ...rest }) => trello("POST", "/cards", { idList: listId, ...rest }))
);

server.registerTool(
  "update_card",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      "Update a card: rename, change description/due/start date, move to another list (and, with boardId, to another board), or archive.",
    inputSchema: {
      cardId: z.string(),
      name: z.string().optional(),
      desc: z.string().optional(),
      due: z.string().optional(),
      start: z.string().optional().describe("Start date, ISO 8601"),
      dueComplete: z.boolean().optional(),
      listId: z.string().optional().describe("Move card to this list"),
      boardId: z.string().optional().describe("Move card to this board (also pass listId on that board)"),
      closed: z.boolean().optional().describe("true to archive"),
    },
  },
  tool(async ({ cardId, listId, boardId, ...rest }) =>
    trello("PUT", `/cards/${cardId}`, { idList: listId, idBoard: boardId, ...rest })
  )
);

server.registerTool(
  "delete_card",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description: "Permanently delete a card. This cannot be undone; prefer update_card with closed=true.",
    inputSchema: { cardId: z.string() },
  },
  tool(async ({ cardId }) => trello("DELETE", `/cards/${cardId}`))
);

server.registerTool(
  "add_comment",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Add a comment to a card.",
    inputSchema: { cardId: z.string(), text: z.string() },
  },
  tool(async ({ cardId, text }) => trello("POST", `/cards/${cardId}/actions/comments`, { text }))
);

server.registerTool(
  "search",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Search Trello for cards and boards.",
    inputSchema: {
      query: z.string(),
      modelTypes: z.string().default("cards,boards").describe("Comma-separated: cards,boards,organizations,members"),
      limit: z.number().int().min(1).max(1000).default(20).describe("Max cards per page"),
      page: z.number().int().min(0).default(0).describe("Card results page (0-based)"),
      boardId: z.string().optional().describe("Restrict the search to one board"),
    },
  },
  tool(async ({ query, modelTypes, limit, page, boardId }) =>
    trello("GET", "/search", {
      query, modelTypes, cards_limit: limit, cards_page: page,
      card_fields: "name,desc,idList,idBoard,url", idBoards: boardId,
    })
  )
);

// ---------- Labels ----------
server.registerTool(
  "get_labels",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Get the labels defined on a board.",
    inputSchema: { boardId: z.string() },
  },
  tool(async ({ boardId }) => trello("GET", `/boards/${boardId}/labels`))
);

// ---------- Checklists ----------
server.registerTool(
  "create_checklist",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Add a checklist to a card, optionally with items.",
    inputSchema: {
      cardId: z.string(),
      name: z.string(),
      items: z.array(z.string()).optional(),
    },
  },
  tool(async ({ cardId, name, items }) => {
    const cl = (await trello("POST", "/checklists", { idCard: cardId, name })) as { id: string };
    for (const item of items ?? []) {
      await trello("POST", `/checklists/${cl.id}/checkItems`, { name: item });
    }
    return cl;
  })
);

// ---------- Boards (more) ----------
server.registerTool(
  "update_board",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Rename a board, change its description, or close (archive) / reopen it.",
    inputSchema: { boardId: z.string(), name: z.string().optional(), desc: z.string().optional(), closed: z.boolean().optional() },
  },
  tool(async ({ boardId, ...rest }) => trello("PUT", `/boards/${boardId}`, rest))
);

server.registerTool(
  "delete_board",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description: "PERMANENTLY delete a board with all its lists and cards. Cannot be undone; prefer update_board with closed=true.",
    inputSchema: { boardId: z.string() },
  },
  tool(async ({ boardId }) => trello("DELETE", `/boards/${boardId}`))
);

server.registerTool(
  "get_board_members",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "List the members of a board (ids are needed for assign_member).",
    inputSchema: { boardId: z.string() },
  },
  tool(async ({ boardId }) => trello("GET", `/boards/${boardId}/members`, { fields: "fullName,username" }))
);

// ---------- Lists (more) ----------
server.registerTool(
  "update_list",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Rename a list, change its position (top, bottom, or a number), or archive/unarchive it.",
    inputSchema: {
      listId: z.string(),
      name: z.string().optional(),
      pos: z.string().optional().describe("top, bottom, or a number"),
      closed: z.boolean().optional(),
    },
  },
  tool(async ({ listId, ...rest }) => trello("PUT", `/lists/${listId}`, rest))
);

// ---------- Labels (more) ----------
server.registerTool(
  "create_label",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Create a label on a board.",
    inputSchema: {
      boardId: z.string(),
      name: z.string(),
      color: z.enum(["green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black"]).optional(),
    },
  },
  tool(async ({ boardId, name, color }) => trello("POST", "/labels", { idBoard: boardId, name, color }))
);

server.registerTool(
  "add_label",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Attach an existing label to a card.",
    inputSchema: { cardId: z.string(), labelId: z.string() },
  },
  tool(async ({ cardId, labelId }) => trello("POST", `/cards/${cardId}/idLabels`, { value: labelId }))
);

server.registerTool(
  "remove_label",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Detach a label from a card (the label itself stays on the board).",
    inputSchema: { cardId: z.string(), labelId: z.string() },
  },
  tool(async ({ cardId, labelId }) => trello("DELETE", `/cards/${cardId}/idLabels/${labelId}`))
);

// ---------- Checklists (more) ----------
server.registerTool(
  "add_checklist_item",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Add an item to an existing checklist.",
    inputSchema: { checklistId: z.string(), name: z.string(), checked: z.boolean().optional() },
  },
  tool(async ({ checklistId, name, checked }) => trello("POST", `/checklists/${checklistId}/checkItems`, { name, checked }))
);

server.registerTool(
  "set_checkitem_state",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Mark a checklist item complete or incomplete.",
    inputSchema: { cardId: z.string(), checkItemId: z.string(), state: z.enum(["complete", "incomplete"]) },
  },
  tool(async ({ cardId, checkItemId, state }) => trello("PUT", `/cards/${cardId}/checkItem/${checkItemId}`, { state }))
);

server.registerTool(
  "delete_checklist",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description: "Delete a checklist from a card. Cannot be undone.",
    inputSchema: { checklistId: z.string() },
  },
  tool(async ({ checklistId }) => trello("DELETE", `/checklists/${checklistId}`))
);

// ---------- Cards (more) ----------
server.registerTool(
  "add_attachment",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Attach a URL (link) to a card.",
    inputSchema: { cardId: z.string(), url: z.string().url(), name: z.string().optional() },
  },
  tool(async ({ cardId, url, name }) => trello("POST", `/cards/${cardId}/attachments`, { url, name }))
);

server.registerTool(
  "get_comments",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Get the comments on a card, newest first. Page with `limit` and `before` (id of the last comment of the previous page).",
    inputSchema: { cardId: z.string(), limit: z.number().int().min(1).max(1000).optional(), before: z.string().optional() },
  },
  tool(async ({ cardId, limit, before }) => {
    const actions = (await trello("GET", `/cards/${cardId}/actions`, { filter: "commentCard,copyCommentCard", limit, before })) as {
      id: string; date: string; data: { text: string }; memberCreator?: { username: string };
    }[];
    return actions.map((a) => ({ id: a.id, date: a.date, author: a.memberCreator?.username, text: a.data.text }));
  })
);

server.registerTool(
  "assign_member",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Assign a board member to a card (get ids from get_board_members).",
    inputSchema: { cardId: z.string(), memberId: z.string() },
  },
  tool(async ({ cardId, memberId }) => trello("POST", `/cards/${cardId}/idMembers`, { value: memberId }))
);

// ---------- Copy / move ----------
server.registerTool(
  "copy_card",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Copy a card (with checklists, labels, attachments, comments, members) into a list, possibly on another board.",
    inputSchema: { cardId: z.string(), listId: z.string().describe("Destination list"), name: z.string().optional(), pos: z.string().optional() },
  },
  tool(async ({ cardId, listId, name, pos }) =>
    trello("POST", "/cards", {
      idList: listId, idCardSource: cardId, name, pos,
      keepFromSource: "attachments,checklists,comments,customFields,due,start,labels,members,stickers",
    })
  )
);

server.registerTool(
  "copy_list",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Copy a list with all its cards onto a board (the same or another one).",
    inputSchema: { listId: z.string(), boardId: z.string().describe("Destination board"), name: z.string().optional() },
  },
  tool(async ({ listId, boardId, name }) =>
    trello("POST", "/lists", { idBoard: boardId, idListSource: listId, name: name ?? "Copy" })
  )
);

server.registerTool(
  "copy_board",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Copy a board. With includeCards=true (default) the cards are copied too.",
    inputSchema: { boardId: z.string(), name: z.string(), includeCards: z.boolean().default(true) },
  },
  tool(async ({ boardId, name, includeCards }) =>
    trello("POST", "/boards", { name, idBoardSource: boardId, keepFromSource: includeCards ? "cards" : "none" })
  )
);

// ---------- Members ----------
server.registerTool(
  "invite_member",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      "Invite a person to a board by email. SIDE EFFECT: Trello sends an invitation email to that address, " +
      "so only call this when the user explicitly asked for this exact invitation.",
    inputSchema: {
      boardId: z.string(),
      email: z.string().email(),
      fullName: z.string().optional(),
      type: z.enum(["normal", "admin", "observer"]).default("normal"),
    },
  },
  tool(async ({ boardId, email, fullName, type }) =>
    trello("PUT", `/boards/${boardId}/members`, { email, fullName: fullName ?? email.split("@")[0], type })
  )
);

server.registerTool(
  "remove_member_from_board",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description: "Remove a member from a board (they lose access to it).",
    inputSchema: { boardId: z.string(), memberId: z.string() },
  },
  tool(async ({ boardId, memberId }) => trello("DELETE", `/boards/${boardId}/members/${memberId}`))
);

server.registerTool(
  "unassign_member",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Remove a member from a card (they stay on the board).",
    inputSchema: { cardId: z.string(), memberId: z.string() },
  },
  tool(async ({ cardId, memberId }) => trello("DELETE", `/cards/${cardId}/idMembers/${memberId}`))
);

// ---------- Cover ----------
server.registerTool(
  "set_cover",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Set a card's cover: a colour, an existing attachment as an image, or remove the cover (remove=true).",
    inputSchema: {
      cardId: z.string(),
      color: z.enum(["green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black"]).optional(),
      attachmentId: z.string().optional().describe("Id of an image attachment of this card"),
      size: z.enum(["normal", "full"]).default("normal"),
      remove: z.boolean().default(false),
    },
  },
  tool(async ({ cardId, color, attachmentId, size, remove }) => {
    const n = [color, attachmentId, remove || undefined].filter(Boolean).length;
    if (n !== 1) throw new Error("Provide exactly one of color, attachmentId, remove=true.");
    const cover = remove ? { color: null, idAttachment: null } : color ? { color, size } : { idAttachment: attachmentId, size };
    return trello("PUT", `/cards/${cardId}`, {}, { body: { cover } });
  })
);

// ---------- Custom fields (needs the Custom Fields Power-Up on the board; enabled automatically) ----------
const CUSTOM_FIELDS_PLUGIN = "56d5e249a98895a9797bebb9";

type FieldDef = { id: string; type: string; name: string; options?: { id: string; value: { text: string } }[] };

server.registerTool(
  "get_custom_fields",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "List the custom fields defined on a board (empty if the Custom Fields Power-Up is not enabled).",
    inputSchema: { boardId: z.string() },
  },
  tool(async ({ boardId }) => trello("GET", `/boards/${boardId}/customFields`))
);

server.registerTool(
  "create_custom_field",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Create a custom field on a board (enables the Custom Fields Power-Up first if needed). For type=list pass `options`.",
    inputSchema: {
      boardId: z.string(),
      name: z.string(),
      type: z.enum(["text", "number", "date", "checkbox", "list"]),
      options: z.array(z.string()).optional().describe("Choices for type=list"),
    },
  },
  tool(async ({ boardId, name, type, options }) => {
    if (type === "list" && !options?.length) throw new Error("type=list needs options.");
    const body = {
      idModel: boardId, modelType: "board", name, type, pos: "bottom",
      ...(type === "list" ? { options: options!.map((text, i) => ({ value: { text }, pos: (i + 1) * 1024 })) } : {}),
    };
    try {
      return await trello("POST", "/customFields", {}, { body });
    } catch {
      await trello("POST", `/boards/${boardId}/boardPlugins`, { idPlugin: CUSTOM_FIELDS_PLUGIN });
      return trello("POST", "/customFields", {}, { body });
    }
  })
);

server.registerTool(
  "set_custom_field",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      "Set a custom field value on a card. `value` is a string: text as is; number as digits; date as ISO 8601; checkbox as true/false; " +
      "list as the option's text. Empty string clears the value.",
    inputSchema: { cardId: z.string(), fieldId: z.string(), value: z.string() },
  },
  tool(async ({ cardId, fieldId, value }) => {
    const def = (await trello("GET", `/customFields/${fieldId}`)) as FieldDef;
    let body: unknown;
    if (value === "") body = { value: "" };
    else if (def.type === "text") body = { value: { text: value } };
    else if (def.type === "number") body = { value: { number: String(Number(value)) } };
    else if (def.type === "date") body = { value: { date: new Date(value).toISOString() } };
    else if (def.type === "checkbox") body = { value: { checked: String(value === "true") } };
    else {
      const opt = def.options?.find((o) => o.value.text === value);
      if (!opt) throw new Error(`No such option "${value}". Options: ${def.options?.map((o) => o.value.text).join(", ")}`);
      body = { idValue: opt.id };
    }
    return trello("PUT", `/cards/${cardId}/customField/${fieldId}/item`, {}, { body });
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Trello MCP server running on stdio");
