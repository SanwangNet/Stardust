import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initializePeopleUI } from "../apps/web/dist/people-ui.js";

// Minimal DOM for exercising the real controller in Node. It does not emulate layout or native focus trapping.
function fixture(t, respond) {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tag = tag; }
    attributes = new Map();
    children = [];
    dataset = {};
    hidden = false;
    value = "";
    #text = "";
    set textContent(value) { this.replaceChildren(); this.#text = value; }
    get textContent() { return this.#text + this.children.map(item => item.textContent).join(""); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...children) {
      for (const child of children) child.parent = this;
      this.children.push(...children);
    }
    before(item) {
      item.parent = this.parent;
      this.parent.children.splice(this.parent.children.indexOf(this), 0, item);
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parent = undefined;
      this.children = [];
      this.#text = "";
      this.append(...children);
    }
    get childElementCount() { return this.children.length; }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    querySelector(tag) { return this.querySelectorAll(tag)[0] ?? null; }
    contains(item) { for (; item; item = item.parent) if (item === this) return true; return false; }
    get isConnected() { return body.contains(this); }
    focus() { document.activeElement = this; }
    click() { if (!this.disabled && !this.hidden) this.dispatchEvent(new Event("click")); }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  class Textarea extends Element { constructor() { super("textarea"); } }
  const body = new Element("body"), page = new Element("section"), dialog = new Element("dialog");
  body.append(page, dialog);
  dialog.id = "people-dialog";
  function mount(parent, tag, suffix) {
    const element = new Element(tag);
    element.id = `people-${suffix}`;
    parent.append(element);
    return element;
  }
  for (const [tag, id] of [["input","query"],["select","state"],["label","state-label"],["p","status"],["div","list"],["div","pagination"],
    ["button","tab-person"],["button","tab-space"],["button","refresh"],["form","search"]]) mount(page, tag, id);
  for (const [tag, id] of [["h2","title"],["p","summary"],["span","avatar"],["div","nav"],["div","actions"],["div","content"],["p","status"],["div","discard"],["button","close"]]) mount(dialog, tag, `dialog-${id}`);
  const document = {
    createElement: tag => tag === "textarea" ? new Textarea() : new Element(tag),
    getElementById: id => {
      const find = element => element.id === id ? element : element.children.map(find).find(Boolean);
      return find(body);
    },
    querySelector: () => page,
    activeElement: null,
  };
  const get = id => document.getElementById(`people-${id}`);
  get("state").value = "active";
  const calls = [];
  const window = new EventTarget(), location = { hash: "#/model/people" };
  const fetch = async (input, options) => {
    const url = new URL(input, "http://localhost");
    calls.push({ url, options });
    if (url.pathname === "/api/v1/control-session") return Response.json({ token: "test-session" });
    const response = await respond(url, options);
    return response instanceof Response ? response : Response.json(response);
  };
  const overrides = { document, window, location, fetch, HTMLTextAreaElement: Textarea };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(overrides)) Object.defineProperty(globalThis, key, { value, configurable: true });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const find = (text, root = dialog) => {
    const found = root.querySelectorAll("button").find(button => button.textContent === text);
    assert.ok(found, `missing button ${text}`);
    return found;
  };
  initializePeopleUI();
  return { get, dialog, calls, document, find };
}

const pageOf = (items, offset = 0, hasMore = false) => ({ items, offset, hasMore, limit: 20 });
const person = (id, displayName, extra = {}) => ({ id, displayName, manualName: displayName, identityCount: 1, spaceCount: 0, status: "provisional", version: 4, providers: "qq", ...extra });
const group = { id: "group-safe-id", displayName: null, providerId: "qq", memberCount: 1, externalId: "raw-group-openid" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("cards keep search, filter and pagination when reopening a dialog", async t => {
  const a = person("person-safe-id", null, { mergedIntoId: "person-other", externalId: "raw-qq-openid" });
  const ui = fixture(t, url => {
    if (url.pathname === "/api/v1/people") {
      const at = Number(url.searchParams.get("offset"));
      return pageOf([a], at, at === 0);
    }
    if (url.pathname.endsWith("/spaces")) return pageOf([]);
    return { person: a };
  });
  await tick();
  ui.get("query").value = "同名";
  ui.get("search").dispatchEvent(new Event("submit", { cancelable: true }));
  ui.get("state").value = "merged";
  ui.get("state").dispatchEvent(new Event("change"));
  await tick();
  ui.find("下一页", ui.get("pagination")).click();
  await tick();
  const card = ui.get("list").children[0];
  assert.equal(card.className, "people-card");
  assert.match(card.textContent, /未知姓名.*已合并/);
  assert.doesNotMatch(card.textContent, /raw-qq-openid|person-safe-id/);
  assert.match(ui.get("pagination").textContent, /^上一页第 21–21 条$/);
  const url = ui.calls.at(-1).url;
  assert.equal(url.searchParams.get("state"), "merged");
  assert.equal(url.searchParams.get("q"), "同名");
  card.click();
  await tick();
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.document.activeElement, ui.get("dialog-title"));
  const key = new Event("keydown", { cancelable: true });
  Object.defineProperty(key, "key", { value: "ArrowRight" });
  ui.find("资料").dispatchEvent(key);
  assert.equal(ui.document.activeElement.textContent, "身份");
  ui.find("群组").click();
  await tick();
  assert.match(ui.get("dialog-content").textContent, /尚无群组记录/);
  assert.equal(ui.get("dialog-content").querySelectorAll("button").length, 0);
  ui.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.document.activeElement, card);
  assert.equal(ui.get("query").value, "同名");
  assert.equal(ui.get("state").value, "merged");
  assert.match(ui.get("pagination").textContent, /21–21/);
});

test("group cards open observed members and late detail responses cannot replace a new person", async t => {
  const first = person("person-a", "甲"), second = person("person-b", "乙");
  let deliver;
  const delayed = new Promise(resolve => { deliver = resolve; });
  const ui = fixture(t, url => {
    const path = url.pathname;
    if (path === "/api/v1/people") return pageOf([first, second]);
    if (path === "/api/v1/spaces") return pageOf([group]);
    if (path.endsWith(group.id)) return { space: group };
    if (path.endsWith("/members")) return pageOf([{ personId: "person-a", displayName: "群昵称", personName: "甲", identityType: "qq_group_member" }]);
    if (path.endsWith("/person-a")) return delayed;
    return { person: second };
  });
  await tick();
  ui.get("tab-space").click();
  await tick();
  const card = ui.get("list").children[0];
  assert.match(card.textContent, /未命名群组.*QQ 群聊.*已观察成员/);
  assert.doesNotMatch(card.textContent, /raw-group-openid/);
  assert.equal(ui.get("pagination").hidden, true);
  card.click();
  await tick();
  ui.find("已观察成员").click();
  await tick();
  ui.get("dialog-content").querySelector("button").click();
  ui.get("dialog-close").click();
  ui.get("tab-person").click();
  await tick();
  ui.get("list").children[1].click();
  await tick();
  deliver({ person: first });
  await tick();
  assert.equal(ui.get("dialog-title").textContent, "乙");
  assert.equal(ui.calls.find(call => call.url.pathname.endsWith("/person-a")).options.signal.aborted, true);
});

test("dirty edits require explicit discard and failed writes retain input and version", async t => {
  const first = person("person-a", "甲");
  let respondToWrite;
  const ui = fixture(t, (url, options) => {
    if (url.pathname === "/api/v1/people") return pageOf([first]);
    if (options.method === "PATCH") return new Promise(resolve => { respondToWrite = resolve; });
    return { person: first };
  });
  await tick();
  ui.get("list").children[0].click();
  await tick();
  ui.find("编辑资料").click();
  const input = ui.get("dialog-content").querySelector("input");
  input.value = "新名称";
  input.dispatchEvent(new Event("input"));
  ui.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.document.activeElement.textContent, "继续编辑");
  ui.find("继续编辑").click();
  ui.find("保存").click();
  assert.equal(ui.get("dialog-close").disabled, true);
  ui.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert.equal(ui.dialog.open, true);
  assert.deepEqual(JSON.parse(ui.calls.at(-1).options.body), { manualName: "新名称", note: null, version: 4 });
  respondToWrite(Response.json({ error: "CONFLICT" }, { status: 409 }));
  await tick();
  assert.match(ui.get("dialog-status").textContent, /已变化/);
  assert.equal(input.value, "新名称");
  ui.get("dialog-close").click();
  ui.find("放弃修改").click();
  assert.equal(ui.dialog.open, false);
});

test("merge confirmation submits only the preview for the current selection", async t => {
  const a = person("person-a", "甲"), b = person("person-b", "乙"), c = person("person-c", "丙");
  let sendOldPreview;
  const ui = fixture(t, (url, options) => {
    const path = url.pathname;
    if (path === "/api/v1/people") return pageOf([a, b, c]);
    if (path === "/api/v1/people/merge/preview") {
      const target = JSON.parse(options.body).targetId;
      const result = { source: a, target: target === b.id ? b : c, identities: [], spaceCount: 0, membershipCount: 0, fingerprint: `signed-${target}` };
      return target === b.id ? new Promise(resolve => { sendOldPreview = () => resolve({ result }); }) : { result };
    }
    if (path === "/api/v1/people/merge") return { result: { auditId: "audit-id" } };
    return { person: path.endsWith(b.id) ? b : path.endsWith(c.id) ? c : a };
  });
  await tick();
  ui.get("list").children[0].click();
  await tick();
  ui.find("合并人物").click();
  await tick();
  const choose = name => ui.dialog.querySelectorAll("button").find(button => button.className === "people-candidate" && button.textContent.startsWith(name)).click();
  choose("乙");
  await tick();
  ui.find("生成合并预览").click();
  choose("丙");
  await tick();
  sendOldPreview();
  await tick();
  assert.ok(!ui.dialog.querySelectorAll("button").some(button => button.textContent === "确认合并"));
  ui.find("生成合并预览").click();
  await tick();
  assert.match(ui.get("dialog-content").textContent, /操作预览.*目标人物丙/);
  ui.get("dialog-content").querySelectorAll("textarea").at(-1).value = "人工核对";
  ui.find("确认合并").click();
  await tick();
  const commit = ui.calls.find(item => item.url.pathname === "/api/v1/people/merge");
  assert.deepEqual(JSON.parse(commit.options.body), { sourceId: a.id, targetId: c.id, options: { nameChoice: "target", noteChoice: "target" }, fingerprint: `signed-${c.id}`, reason: "人工核对" });
});

test("split, identity actions and history keep their original confirmation contracts", async t => {
  const owner = person("person-a", "甲"), target = person("person-b", "乙");
  const id = "identity-a", info = { id, personId: owner.id, identityType: "qq_group_member", linkMethod: "manual_confirmation", linkVersion: 6, displayName: "群昵称", spaceCount: 1 };
  const ui = fixture(t, (url, options) => {
    const path = url.pathname;
    if (path === "/api/v1/people") return pageOf([owner, target]);
    if (path.endsWith("/identities")) return pageOf([info]);
    if (path.endsWith("/audit")) return pageOf([{ id: "audit-a", operation: "person_merge", before: { identities: [id] }, after: {}, canUndo: true }]);
    if (path === `/api/v1/identities/${id}`) return { identity: info };
    if (path.endsWith("/split/preview")) return { result: { source: owner, target: null, identities: [info], spaceCount: 1, membershipCount: 1, fingerprint: "signed-split" } };
    if (options.method === "POST") return { result: {} };
    return { person: owner };
  });
  const lastBody = path => JSON.parse(ui.calls.findLast(item => item.url.pathname.endsWith(path)).options.body);
  const confirm = async (label, reason) => {
    ui.get("dialog-content").querySelectorAll("textarea").at(-1).value = reason;
    ui.find(label).click();
    await tick();
  };
  await tick();
  ui.get("list").children[0].click();
  await tick();
  ui.find("批量拆分身份").click();
  await tick();
  const check = ui.get("dialog-content").querySelectorAll("input").find(input => input.type === "checkbox");
  check.checked = true;
  check.dispatchEvent(new Event("change"));
  ui.find("创建新的待确认人物").click();
  ui.find("生成拆分预览").click();
  await tick();
  await confirm("确认拆分", "人工拆分");
  assert.deepEqual(lastBody("/split"), { sourceId: owner.id, targetId: null, identities: [id], fingerprint: "signed-split", reason: "人工拆分" });

  ui.find("身份").click();
  await tick();
  assert.match(ui.get("dialog-content").textContent, /群昵称.*QQ 群成员身份/);
  ui.find("关联到其他人物").click();
  await tick();
  ui.dialog.querySelectorAll("button").find(button => button.className === "people-candidate").click();
  await confirm("确认关联", "人工关联");
  assert.deepEqual(lastBody("/reassign"), { targetPersonId: target.id, version: 6, reason: "人工关联" });
  ui.find("解除人工关联").click();
  await tick();
  await confirm("确认解除", "人工解除");
  assert.deepEqual(lastBody("/detach"), { version: 6, reason: "人工解除" });

  ui.find("历史").click();
  await tick();
  ui.find("撤销合并").click();
  await confirm("确认撤销", "纠正合并");
  assert.deepEqual(lastBody("/merge/audit-a/undo"), { reason: "纠正合并" });
});

test("published markup keeps the directory grid separate from the native modal", () => {
  const html = readFileSync(new URL("../apps/web/dist/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../apps/web/dist/style.css", import.meta.url), "utf8");
  assert.match(html, /id="people-list" class="people-grid"/);
  assert.match(html, /<dialog id="people-dialog"[^>]+aria-labelledby="people-dialog-title"/);
  assert.ok(html.indexOf('id="people-dialog"') > html.indexOf("</main>"));
  assert.doesNotMatch(html, /people-auth|people-token/);
  assert.match(css, /\.people-page:not\(\[hidden\]\)\) > \.page-heading \{ position: static; \}/);
});
