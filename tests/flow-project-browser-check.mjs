// Real Chromium check for the design board. Run after npm run build.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { FlowPublication } from "../apps/server/dist/flow-publication.js";
import { MAX_FILE_SIZE, connect, exampleProject as defaultProject, newBoard, newNode, parseProject } from "../apps/web/dist/flow-project.js";
import { BACKUP_KEY, MIGRATION_KEY, PROJECT_KEY, REPAIR_BACKUP_KEY, REPAIR_MARKER_KEY, SIMPLIFY_BACKUP_KEY, SIMPLIFY_MARKER_KEY } from "../apps/web/dist/flow-project-migration.js";
import { oldRelationsProject } from "./flow-project-repair-fixture.mjs";
import { exampleProject } from "./flow-project-fixture.mjs";

const project = exampleProject();
const root = project.boards[0];
const sandbox = newBoard("沙盒执行");
const qq = newBoard("QQ 星核");
const sandboxEntry = newNode("沙盒", 320, 340);
const [input, output] = [newNode("输入", 0, 0), newNode("输出", 320, 150)];
root.nodes.push(sandboxEntry);
sandbox.nodes.push(input, output);
sandbox.viewport = { x: 65, y: 55, scale: .9 };
connect(root, root.nodes[0], root.nodes[0].outputPorts[0], sandboxEntry, sandboxEntry.inputPorts[0]);
connect(sandbox, input, input.outputPorts[0], output, output.inputPorts[0]);
const context = newBoard("上下文流验收");
const qqContext = newNode("QQ 上下文", 0, 0);
const webContext = newNode("Web 上下文", 330, 0);
const merge = newNode("上下文拼接", 165, 195);
const shortTerm = newNode("完整短期上下文", 165, 380);
const compression = newNode("上下文压缩", 500, 370);
const pool = newNode("压缩上下文池", 500, 555);
const modelOutput = newNode("输出：模型", 165, 590);
context.nodes.push(qqContext, webContext, merge, shortTerm, compression, pool, modelOutput);
for (const [from, to] of [[merge, shortTerm], [shortTerm, modelOutput], [shortTerm, compression], [compression, pool], [pool, modelOutput]]) {
  connect(context, from, from.outputPorts[0], to, to.inputPorts[0]);
}
context.viewport = { x: 55, y: 40, scale: .75 };
project.boards.push(qq, sandbox, context);

const tempRoot = realpathSync(tmpdir());
const dir = mkdtempSync(join(tempRoot, "stardust-project-browser-"));
const profile = join(dir, "profile");
const legacyFile = join(dir, "v1.json");
const invalidFile = join(dir, "cycle.json");
const key = "stardust.flow-project.v1";
const model = {
  chatContext: async () => "mock",
  chatWithTools: async () => ({ content: "mock", toolCalls: [] }),
};
const server = createStardustServer({
  setupService: { getInitializationState: () => ({ initialized: true }) },
  modelService: model,
  extensionManager: new ExtensionManager(dir, model, []),
  conversationService: new ConversationService(model, ":memory:"),
  flowPublication: new FlowPublication(join(dir, "publication.json")),
});
let chrome, socket, send;

async function until(fn, description) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await fn();
    if (result) return result;
    await wait(50);
  }
  throw new Error(`等待超时：${description}`);
}

try {
  writeFileSync(legacyFile, JSON.stringify(project));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browserPath = process.env.STARDUST_TEST_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browserFlags = ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`];
  if (process.env.STARDUST_TEST_CHROME_NO_SANDBOX === "1") browserFlags.push("--no-sandbox");
  chrome = spawn(browserPath, [...browserFlags, "about:blank"], {
    windowsHide: true,
    stdio: "ignore",
  });
  let launchError;
  chrome.on("error", error => { launchError = error; });
  const port = await until(() => {
    if (launchError) throw launchError;
    try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }, "Chrome 启动");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await once(socket, "open");
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (fn, ...args) => {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const storage = () => evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)), key);
  const select = (selector, value) => evaluate((query, next) => {
    const input = document.querySelector(query);
    input.value = next;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value;
  }, selector, value);
  const fill = (selector, value) => evaluate((query, next) => {
    const input = document.querySelector(query);
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector, value);
  const boardSelect = '[aria-label="选择画板"]';
  const choose = id => select(boardSelect, id);
  const action = name => `#flow-board [data-action="${name}"]`;
  const card = id => `[data-node="${id}"]`;
  const dot = id => `[data-port="${id}"]`;
  const hit = id => `[data-edge="${id}"]`;
  const line = id => `${hit(id)} + .flow-design-wire`;
  const currentBoard = async id => (await storage()).boards.find(board => board.id === id);
  const edgeField = label => `.flow-inspector select[aria-label="${label}"]`;
  const picker = ".flow-project-picker";
  const options = `${picker} select`;
  const confirm = 'dialog[open] button[value="confirm"]';
  const titleInput = '.flow-inspector input[name="title"]';
  const group = ".flow-project-group button";
  const breadcrumbs = () => evaluate(() => Array.from(document.querySelectorAll(".flow-path button"), item => item.textContent));
  const visible = selector => evaluate(query => !!document.querySelector(query)?.getClientRects().length, selector);
  const waitFor = (selector, description = selector) => until(() => visible(selector), description);
  const mouse = (type, point, clickCount) => send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount });
  const move = point => send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 1 });
  const center = selector => evaluate(query => {
    const { x, y, width, height } = document.querySelector(query).getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  }, selector);
  async function click(selector, { label, double = false, scroll = true } = {}) {
    const point = await evaluate((query, text, shouldScroll) => {
      const target = Array.from(document.querySelectorAll(query)).find(element => !text || element.textContent.trim() === text);
      if (!target) throw new Error(`找不到 ${text ?? query}`);
      if (shouldScroll) target.scrollIntoView({ block: "nearest" });
      const rect = target.getBoundingClientRect();
      const y = rect.y + rect.height / 2;
      const x = [rect.x + rect.width / 2, rect.x + rect.width * .05].find(value => target.contains(document.elementFromPoint(value, y)));
      if (x === undefined) throw new Error(`无法点击 ${text ?? query}`);
      return { x, y };
    }, selector, label ?? null, scroll);
    for (let count = 1; count <= (double ? 2 : 1); count++) {
      await mouse("mousePressed", point, count);
      await mouse("mouseReleased", point, count);
    }
  }
  const clickCard = (id, double = false, part = ".flow-node-title") => click(`${card(id)} ${part}`, { double, scroll: false });
  const setPortSide = async (id, side) => assert.equal(await select(`[data-edit-port="${id}"] select`, side), side);
  const setEdgeValue = async (label, value) => assert.equal(await select(edgeField(label), value), value);
  const drawPath = id => evaluate(selector => document.querySelector(selector).getAttribute("d"), hit(id));
  const readAttribute = (selector, name) => evaluate((query, attr) => document.querySelector(query)?.getAttribute(attr), selector, name);
  async function clickEdge(id, gap) {
    const point = await evaluate((query, pattern) => {
      const element = document.querySelector(query);
      const middle = element.getTotalLength() / 2;
      const length = pattern ? Math.floor(middle / pattern[0]) * pattern[0] + pattern[1] : middle;
      const p = element.getPointAtLength(length).matrixTransform(element.getScreenCTM());
      if (document.elementFromPoint(p.x, p.y) !== element) throw new Error("连线命中区不可点击");
      return { x: p.x, y: p.y };
    }, hit(id), gap ?? null);
    await mouse("mousePressed", point, 1);
    await mouse("mouseReleased", point, 1);
    assert.match(await readAttribute(line(id), "class"), /is-selected/);
    assert.equal(await readAttribute(".flow-inspector", "aria-label"), "编辑连线");
  }
  async function assertAnchors(edge) {
    const endpoints = await evaluate(selector => {
      const path = document.querySelector(selector);
      return [0, path.getTotalLength()].map(length => {
        const point = path.getPointAtLength(length).matrixTransform(path.getScreenCTM());
        return { x: point.x, y: point.y };
      });
    }, hit(edge.id));
    for (const [index, portId] of [edge.fromPortId, edge.toPortId].entries()) {
      const port = await center(dot(portId));
      assert.ok(Math.hypot(endpoints[index].x - port.x, endpoints[index].y - port.y) < .6, "SVG 端点与端口中心应对齐");
    }
  }
  async function dragWire(from, to, { accepted, offsetY = 0, releaseCapture = false }) {
    const start = await center(dot(from)), end = await center(dot(to));
    end.y += offsetY;
    const elementAt = point => evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return { tag: element?.tagName, class: element?.getAttribute("class"), port: element?.getAttribute("data-port") };
    }, point);
    assert.equal((await elementAt(start)).port, from, JSON.stringify(await elementAt(start)));
    if (!offsetY) assert.equal((await elementAt(end)).port, to, JSON.stringify(await elementAt(end)));
    if (releaseCapture) {
      await evaluate(() => {
        const canvas = document.querySelector(".flow-canvas");
        canvas.addEventListener("pointerdown", event => { canvas.dataset.testPointer = String(event.pointerId); }, { once: true });
      });
    }
    await mouse("mousePressed", start, 1);
    if (releaseCapture) {
      await move({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
      await waitFor(".flow-wire.is-preview");
      assert.equal(await evaluate(() => {
        const canvas = document.querySelector(".flow-canvas");
        const pointerId = Number(canvas.dataset.testPointer);
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
        return canvas.hasPointerCapture(pointerId);
      }), false);
    }
    await move(end);
    if (accepted) {
      await until(async () => /is-target/.test(await readAttribute(dot(to), "class")), "有效输入端口命中");
      assert.match(await readAttribute(".flow-wire.is-preview", "d"), /^M /);
    } else {
      if (await readAttribute(dot(from), "data-port-kind") === "output") await waitFor(".flow-wire.is-preview");
      assert.doesNotMatch(await readAttribute(dot(to), "class"), /is-target/);
    }
    await mouse("mouseReleased", end, 1);
    assert.equal(await visible(".flow-wire.is-preview"), false);
  }
  async function pressKey(key, code, modifiers = 0) {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, windowsVirtualKeyCode: code, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers });
  }
  async function setFile(filename) {
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: '#flow-board input[type="file"]' });
    await send("DOM.setFileInputFiles", { nodeId, files: [filename] });
  }
  async function importFile(filename) {
    await setFile(filename);
    await waitFor(confirm);
    await click(confirm);
    await until(() => evaluate(() => document.querySelector(".flow-design-status").textContent.includes("工程导入成功")), "工程导入");
  }
  async function renameNode(name) {
    await waitFor(titleInput);
    await fill(titleInput, name);
    await click('.flow-inspector button[type="submit"]', { label: "保存修改" });
  }
  async function associate(target, { replacing = false } = {}) {
    await click(group, { label: "关联已有画板" });
    const expected = replacing ? "替换关联" : "确认关联";
    if (replacing) assert.match(await evaluate(selector => document.querySelector(selector).textContent, picker), /替换当前关联.*原画板会保留/);
    await fill(`${picker} input`, "无匹配画板");
    assert.ok(await visible(`${picker} .flow-project-picker-empty`));
    assert.ok(await evaluate(selector => document.querySelector(selector).disabled, confirm));
    await fill(`${picker} input`, target.name);
    assert.equal(await select(options, target.id), target.id);
    await click(confirm, { label: expected });
    await until(() => evaluate(name => document.querySelector(".flow-project-group p")?.textContent === `已关联「${name}」`, target.name), "关联生效");
  }
  async function exerciseContextConnections() {
    await choose(context.id);
    const original = await currentBoard(context.id);
    const [joinEdge, mainEdge, compressionEdge, poolEdge, modelEdge] = original.edges;
    await clickCard(merge.id);
    await setPortSide(merge.inputPorts[0].id, "top");
    await click(".flow-inspector button", { label: "新增输入端口" });
    const secondInput = (await currentBoard(context.id)).nodes.find(node => node.id === merge.id).inputPorts[1];
    await setPortSide(secondInput.id, "top");
    await setPortSide(merge.outputPorts[0].id, "bottom");
    await click(action("dismiss"));
    const firstAnchor = await center(dot(merge.inputPorts[0].id)), secondAnchor = await center(dot(secondInput.id));
    assert.equal(firstAnchor.y, secondAnchor.y);
    assert.ok(secondAnchor.x - firstAnchor.x > 16);

    for (const [node, edits] of [
      [qqContext, [[qqContext.outputPorts[0], "bottom"]]],
      [webContext, [[webContext.outputPorts[0], "bottom"]]],
      [shortTerm, [[shortTerm.inputPorts[0], "top"], [shortTerm.outputPorts[0], "bottom"]]],
      [compression, [[compression.inputPorts[0], "top"], [compression.outputPorts[0], "bottom"]]],
      [pool, [[pool.inputPorts[0], "top"], [pool.outputPorts[0], "left"]]],
      [modelOutput, [[modelOutput.inputPorts[0], "top"]]],
    ]) {
      await clickCard(node.id);
      for (const [port, side] of edits) await setPortSide(port.id, side);
      await click(action("dismiss"));
    }
    const beforeDrag = await currentBoard(context.id);
    assert.deepEqual(beforeDrag.edges, original.edges);
    assert.deepEqual(beforeDrag.nodes.map(node => node.position), original.nodes.map(node => node.position));
    assert.deepEqual(beforeDrag.viewport, original.viewport);

    await dragWire(qqContext.outputPorts[0].id, merge.inputPorts[0].id, { accepted: true, releaseCapture: true });
    await click(action("minus"));
    await dragWire(webContext.outputPorts[0].id, secondInput.id, { accepted: true, offsetY: -7 });
    const connected = await currentBoard(context.id);
    const [qqLink, webLink] = connected.edges.slice(-2);
    assert.equal(qqLink.toPortId, merge.inputPorts[0].id);
    assert.equal(webLink.toPortId, secondInput.id);
    await dragWire(qqContext.outputPorts[0].id, merge.inputPorts[0].id, { accepted: false });
    await dragWire(qqContext.outputPorts[0].id, webContext.outputPorts[0].id, { accepted: false });
    await dragWire(secondInput.id, merge.inputPorts[0].id, { accepted: false });
    assert.equal((await currentBoard(context.id)).edges.length, connected.edges.length);

    await clickEdge(mainEdge.id);
    await setEdgeValue("连接语义", "data");
    assert.equal(await readAttribute(line(mainEdge.id), "data-line-style"), "solid");
    assert.equal(await readAttribute(line(mainEdge.id), "data-path-style"), "bezier");
    await click(action("dismiss"));
    await clickEdge(compressionEdge.id);
    await setEdgeValue("线型", "dashed");
    await setEdgeValue("连接语义", "optional");
    assert.equal(await readAttribute(line(compressionEdge.id), "data-line-style"), "dashed");
    assert.match(await evaluate(selector => document.querySelector(selector).textContent, `${hit(compressionEdge.id)} title`), /可选关系/);
    await click(action("dismiss"));
    await clickEdge(compressionEdge.id, [17, 13]);
    await setEdgeValue("路径风格", "orthogonal");
    assert.match(await drawPath(compressionEdge.id), /^M .* L /);
    await setEdgeValue("线型", "dotted");
    assert.equal((await currentBoard(context.id)).edges.find(edge => edge.id === compressionEdge.id).semantic, "optional");
    await click(action("dismiss"));
    await clickEdge(compressionEdge.id, [8, 4]);
    const wireColors = [];
    for (const theme of ["dark", "light"]) {
      const [stroke, dash] = await evaluate((next, selector) => {
        document.documentElement.dataset.theme = next;
        const style = getComputedStyle(document.querySelector(selector));
        return [style.stroke, style.strokeDasharray];
      }, theme, line(compressionEdge.id));
      assert.notEqual(dash, "none");
      wireColors.push(stroke);
    }
    assert.notEqual(...wireColors);
    await click(action("dismiss"));

    const initialPath = await drawPath(compressionEdge.id);
    const start = await center(`${card(compression.id)} .flow-node-title`);
    assert.equal(await evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-node]")?.dataset.node, start), compression.id);
    const moved = { x: start.x + 25, y: start.y + 10 };
    await mouse("mousePressed", start, 1);
    await move(moved);
    await until(async () => (await drawPath(compressionEdge.id)) !== initialPath, "拖动卡片时连线实时更新");
    await mouse("mouseReleased", moved, 1);
    const movedPath = await drawPath(compressionEdge.id);
    await assertAnchors(compressionEdge);
    const panStart = await evaluate(() => {
      const { left, top } = document.querySelector(".flow-canvas").getBoundingClientRect();
      return { x: left + 15, y: top + 15 };
    });
    await mouse("mousePressed", panStart, 1);
    const panEnd = { x: panStart.x + 30, y: panStart.y + 20 };
    const viewportBeforePan = (await currentBoard(context.id)).viewport;
    await move(panEnd);
    await mouse("mouseReleased", panEnd, 1);
    const panned = (await currentBoard(context.id)).viewport;
    assert.notEqual(panned.x, viewportBeforePan.x);
    assert.notEqual(panned.y, viewportBeforePan.y);
    await click(action("plus"));
    assert.ok((await currentBoard(context.id)).viewport.scale > panned.scale);
    assert.equal(await drawPath(compressionEdge.id), movedPath);
    for (const edge of [qqLink, webLink, joinEdge, mainEdge, compressionEdge, poolEdge, modelEdge]) await assertAnchors(edge);

    await clickEdge(webLink.id);
    await setEdgeValue("路径风格", "orthogonal");
    await click(".flow-inspector button", { label: "删除连线" });
    assert.ok(!(await currentBoard(context.id)).edges.some(edge => edge.id === webLink.id));
    await dragWire(webContext.outputPorts[0].id, secondInput.id, { accepted: true });
    return compressionEdge;
  }

  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${origin}/#/model/flow` });
  await waitFor("#flow-board .flow-canvas");

  const sourceBytes = process.env.STARDUST_M5C0_SOURCE
    ? readFileSync(process.env.STARDUST_M5C0_SOURCE, "utf8")
    : JSON.stringify(project, null, 2);
  if (process.env.STARDUST_M5C0_SOURCE) {
    const source = parseProject(JSON.parse(sourceBytes));
    const rebuilt = defaultProject();
    assert.deepEqual(rebuilt.boards.map(item => item.id), source.boards.map(item => item.id));
    for (const originalBoard of source.boards) {
      const rebuiltBoard = rebuilt.boards.find(item => item.id === originalBoard.id);
      for (const originalNode of originalBoard.nodes) {
        if (originalNode.id === "3e8c54f5-9853-4cc8-9764-e2efe4a82578") continue;
        assert.ok(rebuiltBoard.nodes.some(item => item.id === originalNode.id), `保留原节点 ${originalNode.title}`);
      }
    }
  }
  await evaluate((projectKey, backupKey, markerKey, source) => {
    localStorage.setItem(projectKey, source);
    localStorage.removeItem(backupKey);
    localStorage.removeItem(markerKey);
    localStorage.setItem("stardust.test.unrelated", "preserve");
  }, PROJECT_KEY, BACKUP_KEY, MIGRATION_KEY, sourceBytes);
  const injected = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const set = Storage.prototype.setItem; Object.defineProperty(Storage.prototype, "setItem", { configurable: true, writable: true, value(key, value) { if (key === ${JSON.stringify(BACKUP_KEY)}) throw new Error("test quota"); return set.call(this, key, value); } }); })();`,
  });
  await send("Page.reload", { ignoreCache: true });
  try {
    await until(() => evaluate(() => document.querySelector(".flow-design-status")?.textContent.includes("原存储已保留")), "备份失败时保护工程");
  } catch (error) {
    console.error("迁移页面状态", await evaluate(() => ({
      status: document.querySelector(".flow-design-status")?.textContent,
      canvas: !!document.querySelector(".flow-canvas"),
      marker: localStorage.getItem("stardust.flow-project.v1.m5-c0.migration"),
      backup: localStorage.getItem("stardust.flow-project.v1.m5-c0.backup") !== null,
    })));
    throw error;
  }
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), PROJECT_KEY), sourceBytes);
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), BACKUP_KEY), null);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.identifier });
  await send("Page.reload", { ignoreCache: true });
  await until(() => evaluate(() => document.querySelector(".flow-design-status")?.textContent.includes("已备份原设计")), "一次性替换");
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), BACKUP_KEY), sourceBytes);
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), MIGRATION_KEY), "complete");
  assert.equal(await evaluate(() => localStorage.getItem("stardust.test.unrelated")), "preserve");
  assert.deepEqual(await storage(), defaultProject());
  if (process.env.STARDUST_M5C0_CAPTURE) {
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.STARDUST_M5C0_CAPTURE, Buffer.from(screenshot.data, "base64"));
  }
  await click(action("add-node"));
  await renameNode("迁移后用户修改");
  const editedDefault = await storage();
  await send("Page.reload", { ignoreCache: true });
  await waitFor("#flow-board .flow-canvas");
  assert.deepEqual(await storage(), editedDefault);
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), BACKUP_KEY), sourceBytes);

  const prior = oldRelationsProject();
  prior.boards[0].nodes[0].title = "用户修改过的 QQ 入口";
  const savedPosition = { x: 620, y: 110 };
  prior.boards.find(board => board.name === "QQ 星核").nodes.find(node => node.title === "QQ 上下文来源").position = savedPosition;
  const beforeRepair = JSON.stringify(prior);
  await evaluate((projectKey, repairKey, markerKey, simplifyBackup, simplifyMarker, value) => {
    localStorage.setItem(projectKey, value);
    localStorage.removeItem(repairKey);
    localStorage.removeItem(markerKey);
    localStorage.removeItem(simplifyBackup);
    localStorage.removeItem(simplifyMarker);
  }, PROJECT_KEY, REPAIR_BACKUP_KEY, REPAIR_MARKER_KEY, SIMPLIFY_BACKUP_KEY, SIMPLIFY_MARKER_KEY, beforeRepair);
  await send("Page.reload", { ignoreCache: true });
  await until(() => evaluate(() => document.querySelector(".flow-design-status")?.textContent.includes("已备份原设计")), "修复已有画板");
  const repaired = await storage();
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), REPAIR_BACKUP_KEY), beforeRepair);
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), REPAIR_MARKER_KEY), "complete");
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), SIMPLIFY_MARKER_KEY), "complete");
  assert.ok(await evaluate(storageKey => localStorage.getItem(storageKey), SIMPLIFY_BACKUP_KEY));
  assert.equal(repaired.boards[0].nodes[0].title, "用户修改过的 QQ 入口");
  const repairedQQ = repaired.boards.find(board => board.name === "QQ 星核");
  assert.deepEqual(repairedQQ.nodes.find(node => node.title === "输出：QQ 上下文").position, savedPosition);
  const hasEdge = (board, from, to) => board.edges.some(edge =>
    edge.fromNodeId === board.nodes.find(node => node.title === from)?.id
      && edge.toNodeId === board.nodes.find(node => node.title === to)?.id);
  assert.ok(hasEdge(repairedQQ, "输入过滤", "输出：QQ 上下文"));
  assert.ok(hasEdge(repairedQQ, "Core 工具调用", "QQ msg Tool"));
  assert.ok(hasEdge(repairedQQ, "QQ msg Tool", "QQ 消息发送"));
  assert.ok(hasEdge(repairedQQ, "输入：主流程回复", "QQ 消息发送"));
  assert.ok(!repairedQQ.nodes.some(node => node.title === "沙盒能力引用"));
  assert.ok(!repaired.boards.find(board => board.name === "上下文").nodes.some(node => node.title === "Web Global Context"));
  const repairedSandbox = repaired.boards.find(board => board.name === "沙盒执行");
  assert.ok(hasEdge(repairedSandbox, "沙盒 Tool", "执行参数"));
  assert.ok(hasEdge(repairedSandbox, "执行参数", "审批辅助模型"));
  assert.ok(hasEdge(repairedSandbox, "审批辅助模型", "Core 权限与审批"));
  if (process.env.STARDUST_M5C0_CAPTURE) {
    for (const [board, suffix] of [[repairedQQ, "qq"], [repairedSandbox, "sandbox"]]) {
      await choose(board.id);
      await click(action("fit"));
      const screenshot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${process.env.STARDUST_M5C0_CAPTURE}.${suffix}.png`, Buffer.from(screenshot.data, "base64"));
    }
  }
  const repairedSaved = await storage();
  await send("Page.reload", { ignoreCache: true });
  await waitFor("#flow-board .flow-canvas");
  assert.deepEqual(await storage(), repairedSaved);
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), REPAIR_BACKUP_KEY), beforeRepair);

  await importFile(legacyFile);
  assert.deepEqual(await storage(), project);
  assert.equal(await readAttribute(dot(root.nodes[0].inputPorts[0].id), "data-side"), "left");
  assert.equal(await readAttribute(dot(root.nodes[0].outputPorts[0].id), "data-side"), "right");
  assert.match(await drawPath(root.edges[0].id), /^M .* C /);
  assert.equal(await readAttribute(line(root.edges[0].id), "data-line-style"), "solid");
  await assertAnchors(root.edges[0]);
  await clickCard(sandboxEntry.id);
  await associate(sandbox);
  assert.deepEqual((await storage()).boards.find(board => board.id === sandbox.id), sandbox);

  await choose(qq.id);
  await click(action("add-node"));
  await renameNode("沙盒使用");
  const qqEntryId = (await storage()).boards.find(board => board.id === qq.id).nodes[0].id;
  await associate(sandbox);
  await click(action("dismiss"));
  await clickCard(qqEntryId, true);
  assert.deepEqual(await breadcrumbs(), ["QQ 星核", "沙盒执行"]);
  await clickCard(input.id);
  await renameNode("共享输入");
  await setPortSide(input.outputPorts[0].id, "bottom");
  await click(group, { label: "关联已有画板" });
  const eligible = await evaluate(selector => Array.from(document.querySelector(selector).options, option => option.value), options);
  for (const id of [root.id, qq.id, sandbox.id]) assert.ok(!eligible.includes(id));
  await click('dialog[open] button[value="cancel"]');
  await click(action("dismiss"));
  await clickCard(output.id);
  await setPortSide(output.inputPorts[0].id, "top");
  await click(action("dismiss"));
  await clickEdge(sandbox.edges[0].id);
  await setEdgeValue("线型", "dashed");
  await setEdgeValue("路径风格", "orthogonal");
  await setEdgeValue("连接语义", "feedback");
  await click('[data-trail="0"]');
  assert.deepEqual(await breadcrumbs(), ["QQ 星核"]);

  await choose(root.id);
  await clickCard(sandboxEntry.id, true);
  assert.deepEqual(await breadcrumbs(), ["主流程", "沙盒执行"]);
  assert.equal(await evaluate(selector => document.querySelector(selector).textContent, `${card(input.id)} .flow-node-title`), "共享输入");
  await click(action("delete-board"));
  assert.deepEqual(await evaluate(() => Array.from(document.querySelectorAll("dialog[open] li"), item => item.textContent)),
    ["「主流程」 → 「沙盒」", "「QQ 星核」 → 「沙盒使用」"]);
  await click(confirm, { label: "关闭" });
  await click(action("rename-board"));
  await fill('dialog[open] input', "沙盒执行已重命名");
  await click(confirm);
  await until(async () => (await breadcrumbs()).at(-1) === "沙盒执行已重命名", "画板重命名");
  await click('[data-trail="0"]');
  assert.deepEqual(await breadcrumbs(), ["主流程"]);
  assert.equal(await evaluate(selector => document.querySelector(selector).textContent, `${card(sandboxEntry.id)} .flow-group-target`), "沙盒执行已重命名");

  const themedColors = theme => evaluate((next, selector) => {
    document.documentElement.dataset.theme = next;
    return [getComputedStyle(document.querySelector(selector)).backgroundColor, getComputedStyle(document.querySelector(".flow-canvas")).backgroundColor];
  }, theme, `${card(sandboxEntry.id)} .flow-group-head`);
  const dark = await themedColors("dark");
  const light = await themedColors("light");
  assert.notEqual(dark[0], light[0]);
  assert.notEqual(dark[1], light[1]);

  await clickCard(sandboxEntry.id);
  await pressKey("d", 68, 2);
  const copied = await storage();
  const copiedEntry = copied.boards[0].nodes.at(-1);
  const copiedBoard = copied.boards.find(board => board.id === copiedEntry.childBoardId);
  assert.notEqual(copiedEntry.id, sandboxEntry.id);
  assert.notEqual(copiedBoard.id, sandbox.id);
  assert.notEqual(copiedBoard.edges[0].id, sandbox.edges[0].id);
  assert.equal(copiedBoard.nodes[0].outputPorts[0].side, "bottom");
  assert.equal(copiedBoard.nodes[1].inputPorts[0].side, "top");
  assert.equal(copiedBoard.edges[0].semantic, "feedback");
  assert.deepEqual(copiedBoard.edges[0].appearance, { lineStyle: "dashed", pathStyle: "orthogonal" });
  assert.ok(!copied.boards[0].edges.some(edge => edge.toNodeId === copiedEntry.id));
  await click(group, { label: "进入画板 ↗" });
  await clickCard(copiedBoard.nodes[0].id);
  await renameNode("仅副本修改");
  await click('[data-trail="0"]');
  await clickCard(sandboxEntry.id, true, ".flow-node-head");
  assert.equal(await evaluate(selector => document.querySelector(selector).textContent, `${card(input.id)} .flow-node-title`), "共享输入");
  await click('[data-trail="0"]');

  const compressionLink = await exerciseContextConnections();
  await choose(root.id);
  await click(action("export"));
  const download = join(dir, `${project.projectName}.json`);
  const exported = await until(() => {
    try { return JSON.parse(readFileSync(download, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }, "导出的 JSON 文件");
  assert.deepEqual(exported, await storage());
  await choose(qq.id);
  await send("Page.reload", { ignoreCache: true });
  await until(async () => (await breadcrumbs()).join() === "主流程", "刷新后的根画板");
  assert.deepEqual(await storage(), exported);
  await choose(context.id);
  assert.equal(await readAttribute(line(compressionLink.id), "data-line-style"), "dotted");
  assert.equal(await readAttribute(dot(shortTerm.outputPorts[0].id), "data-side"), "bottom");
  await assertAnchors(compressionLink);
  await importFile(download);
  assert.deepEqual(await storage(), exported);
  await choose(context.id);
  await assertAnchors(compressionLink);
  assert.equal(exported.boards[0].nodes.find(node => node.id === sandboxEntry.id).childBoardId, sandbox.id);
  assert.equal(exported.boards.find(board => board.id === qq.id).nodes[0].childBoardId, sandbox.id);

  const cyclic = structuredClone(exported);
  cyclic.boards.find(board => board.id === sandbox.id).nodes[0].childBoardId = root.id;
  writeFileSync(invalidFile, JSON.stringify(cyclic));
  await setFile(invalidFile);
  await until(() => evaluate(() => document.querySelector(".flow-design-status").textContent.includes("循环画板引用")), "循环工程被拒绝");
  assert.equal(await visible(confirm), false);
  assert.deepEqual(await storage(), exported);
  const malformed = structuredClone(exported);
  malformed.boards.find(board => board.id === context.id).edges[0].appearance = { pathStyle: "invalid" };
  writeFileSync(invalidFile, JSON.stringify(malformed));
  await setFile(invalidFile);
  await until(() => evaluate(() => document.querySelector(".flow-design-status").textContent.includes("工程格式无效")), "非法路径风格被拒绝");
  assert.deepEqual(await storage(), exported);
  writeFileSync(invalidFile, Buffer.alloc(MAX_FILE_SIZE + 1));
  await setFile(invalidFile);
  await until(() => evaluate(() => document.querySelector(".flow-design-status").textContent.includes("5 MB")), "文件大小限制");
  assert.deepEqual(await storage(), exported);

  await choose(qq.id);
  await clickCard(qqEntryId);
  await waitFor(`${group}:first-of-type`);
  await associate(project.boards[1], { replacing: true });
  const originalDefinition = exported.boards.find(board => board.id === sandbox.id);
  assert.deepEqual((await storage()).boards.find(board => board.id === sandbox.id), originalDefinition);
  await associate(originalDefinition, { replacing: true });
  await click(group, { label: "解除节点组关联" });
  assert.equal((await storage()).boards.find(board => board.id === qq.id).nodes[0].childBoardId, undefined);
  assert.deepEqual((await storage()).boards.find(board => board.id === sandbox.id), originalDefinition);
  await click(group, { label: "创建节点组" });
  assert.deepEqual(await breadcrumbs(), ["QQ 星核", "沙盒使用"]);
  assert.equal((await storage()).boards.length, exported.boards.length + 1);

  await choose(root.id);
  await clickCard(sandboxEntry.id, false, ".flow-node-head");
  await pressKey("Delete", 46);
  const afterDelete = await storage();
  assert.ok(!afterDelete.boards[0].nodes.some(node => node.id === sandboxEntry.id));
  assert.ok(!afterDelete.boards[0].edges.some(edge => edge.toNodeId === sandboxEntry.id));
  assert.deepEqual(afterDelete.boards.find(board => board.id === sandbox.id), originalDefinition);
  await choose(sandbox.id);
  await click(action("delete-board"));
  await click(confirm);
  await until(async () => !(await storage()).boards.some(board => board.id === sandbox.id), "删除无引用画板");
  assert.ok((await storage()).boards.some(board => board.id === copiedBoard.id));

  const unreadable = "invalid-project-bytes";
  await evaluate((storageKey, value) => localStorage.setItem(storageKey, value), key, unreadable);
  await click(action("fit"));
  assert.match(await evaluate(() => document.querySelector(".flow-design-status").textContent), /此页面之外/);
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), key), unreadable);
  await send("Page.reload", { ignoreCache: true });
  await until(() => evaluate(() => document.querySelector(".flow-design-status")?.textContent.includes("原存储已保留")), "不可读存储保护");
  await click(action("add-node"));
  await click(action("fit"));
  assert.equal(await evaluate(storageKey => localStorage.getItem(storageKey), key), unreadable);
  console.log("Chrome 验收通过：四向端口与预览命中、线型与语义、折线选择和删除、坐标同步、主题、JSON 往返及 M5-A 共享与复制。");
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await Promise.race([send("Browser.close").catch(() => {}), wait(1000)]);
    socket.close();
  }
  if (chrome && chrome.exitCode === null && chrome.pid) {
    await Promise.race([once(chrome, "exit"), wait(1500)]);
    if (chrome.exitCode === null && chrome.kill()) await once(chrome, "exit");
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.equal(dirname(realpathSync(dir)), tempRoot);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
