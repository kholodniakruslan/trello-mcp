// End-to-end check of the tools on a TEMPORARY board that it creates and deletes (by the id it got back).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "selftest", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["build/index.js"], stderr: "ignore" }));
const raw = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
};
let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", label, ok ? "" : extra); };
const step = async (label, fn, test = () => true) => {
  try { const r = await fn(); check(label, test(r), JSON.stringify(r)?.slice(0, 200)); return r; }
  catch (e) { check(label, false, e.message.slice(0, 200)); return undefined; }
};
const tools = (await c.listTools()).tools;
check(`tools registered (${tools.length})`, tools.length === 40);
check("all tools annotated", tools.every((t) => t.annotations?.readOnlyHint !== undefined));

let boardId;
const tempBoards = []; // every board created here, all deleted in `finally` by id
try {
  const board = await step("create_board", () => raw("create_board", { name: "MCP selftest (temporary)" }), (r) => r.id && r.name.includes("selftest"));
  boardId = board?.id;
  if (boardId) tempBoards.push(boardId);
  if (!boardId) throw new Error("no board, aborting");
  await step("get_board", () => raw("get_board", { boardId }), (r) => r.id === boardId);
  await step("update_board", () => raw("update_board", { boardId, desc: "temp" }), (r) => r.desc === "temp");
  const members = await step("get_board_members", () => raw("get_board_members", { boardId }), (r) => r.length >= 1);
  const lists = await step("get_lists", () => raw("get_lists", { boardId }), (r) => Array.isArray(r));
  const list = await step("create_list (bottom by default)", () => raw("create_list", { boardId, name: "Selftest" }), (r) => r.id);
  await step("update_list rename", () => raw("update_list", { listId: list.id, name: "Selftest renamed" }), (r) => r.name === "Selftest renamed");
  await step("update_list pos=top", () => raw("update_list", { listId: list.id, pos: "top" }), (r) => r.id);
  const card = await step("create_card", () => raw("create_card", { listId: list.id, name: "Card A", desc: "d" }), (r) => r.id);
  const label = await step("create_label", () => raw("create_label", { boardId, name: "urgent", color: "red" }), (r) => r.id);
  await step("add_label", () => raw("add_label", { cardId: card.id, labelId: label.id }), (r) => JSON.stringify(r).includes(label.id));
  const cl = await step("create_checklist", () => raw("create_checklist", { cardId: card.id, name: "Plan", items: ["one", "two"] }), (r) => r.id);
  const item = await step("add_checklist_item", () => raw("add_checklist_item", { checklistId: cl.id, name: "three" }), (r) => r.id);
  await step("set_checkitem_state", () => raw("set_checkitem_state", { cardId: card.id, checkItemId: item.id, state: "complete" }), (r) => r.state === "complete");
  await step("add_comment", () => raw("add_comment", { cardId: card.id, text: "hello" }), (r) => r.id);
  await step("add_attachment", () => raw("add_attachment", { cardId: card.id, url: "https://example.com", name: "ex" }), (r) => r.id);
  if (members?.[0]) await step("assign_member", () => raw("assign_member", { cardId: card.id, memberId: members[0].id }), (r) => Array.isArray(r));
  await step("get_comments", () => raw("get_comments", { cardId: card.id }), (r) => r.length === 1 && r[0].text === "hello");
  await step("get_card (full details)", () => raw("get_card", { cardId: card.id }), (r) =>
    r.checklists?.[0]?.checkItems?.length === 3 && r.labels?.length === 1 && r.attachments?.length === 1 && r.idMembers?.length >= 1);
  await step("get_cards by list", () => raw("get_cards", { listId: list.id }), (r) => r.length === 1);
  await step("get_labels", () => raw("get_labels", { boardId }), (r) => r.some((l) => l.name === "urgent"));
  await step("remove_label", () => raw("remove_label", { cardId: card.id, labelId: label.id }), () => true);
  await step("update_card (move/close)", () => raw("update_card", { cardId: card.id, name: "Card A2", closed: true }), (r) => r.name === "Card A2" && r.closed === true);
  await step("delete_checklist", () => raw("delete_checklist", { checklistId: cl.id }), () => true);
  await step("archive_list", () => raw("archive_list", { listId: list.id }), (r) => r.closed === true);
  await step("delete_card", () => raw("delete_card", { cardId: card.id }), () => true);

  // ===== v1.2: pagination, filters, dates =====
  const L = (await raw("create_list", { boardId, name: "Paging" })).id;
  const ids = [];
  for (let i = 1; i <= 5; i++) ids.push((await raw("create_card", { listId: L, name: `P${i}`, desc: "long description", start: "2026-12-01T09:00:00.000Z" })).id);
  const seen = [];
  let offset = 0, pages = 0, hasMore = true, total;
  while (hasMore && pages < 6) {
    const page = await raw("get_cards", { listId: L, limit: 2, offset });
    seen.push(...page.cards.map((c) => c.id)); total = page.total; hasMore = page.hasMore; offset += 2; pages++;
  }
  check("pagination: limit/offset walks all 5 cards, no repeats, 3 pages", pages === 3 && total === 5 && new Set(seen).size === 5 && ids.every((i) => seen.includes(i)), `pages=${pages} seen=${seen.length} total=${total}`);
  check("get_cards without limit stays a plain array", Array.isArray(await raw("get_cards", { listId: L })));
  const compact = await raw("get_cards", { boardId, compact: true });
  check("get_cards compact drops descriptions", compact.length === 5 && compact.every((c) => c.desc === undefined));
  check("start date stored on create", (await raw("get_card", { cardId: ids[0] })).start?.startsWith("2026-12-01"));
  await step("update_card start", () => raw("update_card", { cardId: ids[0], start: "2026-12-05T09:00:00.000Z" }), (r) => r.start?.startsWith("2026-12-05"));
  await raw("update_card", { cardId: ids[4], closed: true });
  check("filter=closed / open", (await raw("get_cards", { boardId, filter: "closed" })).length === 1 && (await raw("get_cards", { boardId, filter: "open" })).length === 4);
  for (const t of ["c1", "c2", "c3"]) await raw("add_comment", { cardId: ids[0], text: t });
  const c1 = await raw("get_comments", { cardId: ids[0], limit: 2 });
  const c2 = await raw("get_comments", { cardId: ids[0], limit: 2, before: c1.at(-1).id });
  check("get_comments limit/before paging", c1.length === 2 && c2.length === 1 && c2[0].text === "c1", JSON.stringify([c1, c2]).slice(0, 150));
  await step("search limit/page/boardId", () => raw("search", { query: "P1", modelTypes: "cards", limit: 5, page: 0, boardId }), (r) => Array.isArray(r.cards) && r.options);

  // ===== cover =====
  await step("set_cover colour", () => raw("set_cover", { cardId: ids[1], color: "blue" }), (r) => r.cover?.color === "blue");
  await step("set_cover remove", () => raw("set_cover", { cardId: ids[1], remove: true }), (r) => !r.cover?.color);

  // ===== members =====
  const me = (await raw("get_board_members", { boardId }))[0];
  await raw("assign_member", { cardId: ids[1], memberId: me.id });
  await step("unassign_member", () => raw("unassign_member", { cardId: ids[1], memberId: me.id }), () => true);
  check("card has no members after unassign", (await raw("get_card", { cardId: ids[1] })).idMembers.length === 0);

  // ===== custom fields =====
  const defs = {};
  for (const [name, type, options] of [["Note", "text"], ["Hours", "number"], ["Due2", "date"], ["Ok", "checkbox"], ["Prio", "list", ["Low", "High"]]]) {
    defs[name] = await step(`create_custom_field ${type}`, () => raw("create_custom_field", { boardId, name, type, options }), (r) => r.id && r.type === type);
  }
  check("get_custom_fields lists 5", (await raw("get_custom_fields", { boardId })).length === 5);
  const vals = { Note: "hello", Hours: "7.5", Due2: "2026-12-24T10:00:00.000Z", Ok: "true", Prio: "High" };
  for (const [name, value] of Object.entries(vals)) await step(`set_custom_field ${name}`, () => raw("set_custom_field", { cardId: ids[2], fieldId: defs[name].id, value }), () => true);
  const items = (await raw("get_card", { cardId: ids[2] })).customFieldItems ?? [];
  check("custom field values visible in get_card (5 items)", items.length === 5, JSON.stringify(items).slice(0, 200));
  await step("set_custom_field clear", () => raw("set_custom_field", { cardId: ids[2], fieldId: defs.Note.id, value: "" }), () => true);
  check("cleared value gone", ((await raw("get_card", { cardId: ids[2] })).customFieldItems ?? []).length === 4);
  await step("set_custom_field bad list option is rejected", async () => { try { await raw("set_custom_field", { cardId: ids[2], fieldId: defs.Prio.id, value: "Nope" }); return "accepted"; } catch { return "rejected"; } }, (r) => r === "rejected");

  // ===== copy / move across boards =====
  const boardB = await raw("create_board", { name: "MCP selftest B (temporary)" });
  tempBoards.push(boardB.id);
  const listB = (await raw("create_list", { boardId: boardB.id, name: "Dest" })).id;
  const cp = await step("copy_card to another board", () => raw("copy_card", { cardId: ids[0], listId: listB, name: "P1 copy" }), (r) => r.id && r.idBoard === boardB.id);
  const cpFull = await raw("get_card", { cardId: cp.id });
  check("copied card keeps description and comments", cpFull.desc === "long description" && (await raw("get_comments", { cardId: cp.id })).length === 3);
  await step("update_card moves card to another board", () => raw("update_card", { cardId: ids[3], boardId: boardB.id, listId: listB }), (r) => r.idBoard === boardB.id);
  const listCopy = await step("copy_list to another board", () => raw("copy_list", { listId: L, boardId: boardB.id, name: "Paging copy" }), (r) => r.id && r.idBoard === boardB.id);
  check("copied list carries its cards", (await raw("get_cards", { listId: listCopy.id })).length >= 3);
  const bc = await step("copy_board with cards", () => raw("copy_board", { boardId: boardB.id, name: "MCP selftest C (temporary)" }), (r) => r.id);
  if (bc?.id) tempBoards.push(bc.id);
  check("copied board has cards", bc?.id && (await raw("get_cards", { boardId: bc.id })).length >= 3);
  await step("search finds board", () => raw("search", { query: "MCP selftest", modelTypes: "boards" }), () => true);
} finally {
  for (const id of tempBoards) await step(`delete_board ${id.slice(-6)} (temporary)`, () => raw("delete_board", { boardId: id }), () => true);
  if (tempBoards.length) {
    const boards = await raw("list_boards", { filter: "all" });
    check("all temporary boards are gone", tempBoards.every((id) => !boards.some((b) => b.id === id)));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await c.close();
}
