import assert from "node:assert/strict";
import { test } from "node:test";
import { freeWirePreview, layoutNode, wirePath } from "../apps/web/dist/flow-project-geometry.js";
import { newId, newNode, PORT_SIDES } from "../apps/web/dist/flow-project.js";

const directions = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const position = ({ x, y }) => [x, y];
const dot = ([x, y], [u, v]) => x * u + y * v;
const subtract = ([x, y], [u, v]) => [x - u, y - v];
const inside = ([x, y], box) => x > box.left && x < box.right && y > box.top && y < box.bottom;
const interpolate = ([x, y], [u, v], t) => [x + t * (u - x), y + t * (v - y)];

function commands(path) {
  return path.split(/ (?=[MLCQ] )/).map(segment => {
    const op = segment[0];
    const values = segment.slice(2).split(/[, ]+/).map(Number);
    assert.ok(values.every(Number.isFinite), path);
    const points = [];
    for (let i = 0; i < values.length; i += 2) points.push(values.slice(i, i + 2));
    return { op, points };
  });
}

function anchoredPath(path, from, to, style) {
  const parts = commands(path);
  assert.deepEqual(parts[0].points[0], position(from), path);
  assert.deepEqual(parts.at(-1).points.at(-1), position(to), path);
  const start = subtract(parts[1].points[0], position(from));
  const end = subtract(parts.at(-1).points.at(-2) ?? parts.at(-2).points.at(-1), position(to));
  for (const [vector, anchor] of [[start, from], [end, to]]) {
    assert.ok(dot(vector, directions[anchor.side]) > 0, path);
    assert.equal(dot(vector, directions[anchor.side]) ** 2, dot(vector, vector), path);
  }
  let previous = position(from);
  for (const { op, points } of parts.slice(1)) {
    const end = points.at(-1);
    if (style === "orthogonal") {
      assert.equal(op, "L");
      assert.ok((previous[0] === end[0]) !== (previous[1] === end[1]), path);
    }
    for (let step = 1; step < 24; step++) {
      const t = step / 24;
      let polygon = [previous, ...points];
      while (polygon.length > 1) polygon = polygon.slice(1).map((point, index) => interpolate(polygon[index], point, t));
      assert.ok(!inside(polygon[0], from.bounds) && !inside(polygon[0], to.bounds), path);
    }
    previous = end;
  }
}

test("port layout separates spatial side from input/output and grows to keep offsets stable", () => {
  const node = newNode("layout", 20, -30);
  const [input] = node.inputPorts, [output] = node.outputPorts;
  const original = layoutNode(node);
  assert.equal(original.width, 234);
  assert.equal(original.height, 126);
  assert.deepEqual(position(original.ports.get(input.id)), [20, 33]);
  assert.deepEqual(position(original.ports.get(output.id)), [254, 33]);

  input.side = "right";
  output.side = "top";
  node.inputPorts.push({ id: newId(), name: "lower", side: "bottom" });
  node.outputPorts.push({ id: newId(), name: "left", side: "left" });
  const four = layoutNode(node);
  assert.deepEqual([...four.ports.values()].map(anchor => [anchor.side, anchor.kind, ...position(anchor)]), [
    ["left", "output", 20, 33], ["right", "input", 254, 33],
    ["top", "output", 137, -30], ["bottom", "input", 137, 96],
  ]);
  input.side = "top";
  const extraPorts = Array.from({ length: 12 }, () => ({ id: newId(), name: "top", side: "top" }));
  node.inputPorts.push(...extraPorts);
  const wide = layoutNode(node);
  const top = [...wide.ports.values()].filter(anchor => anchor.side === "top");
  assert.deepEqual(top.map(anchor => anchor.port), [input, ...extraPorts, output]);
  assert.ok(wide.width > original.width);
  for (let i = 1; i < top.length; i++) assert.ok(top[i].x - top[i - 1].x >= 16);
  for (const port of [...node.inputPorts, ...node.outputPorts]) port.side = "left";
  const tall = layoutNode(node);
  assert.ok(tall.height > original.height);
  const left = [...tall.ports.values()];
  for (let i = 1; i < left.length; i++) assert.ok(left[i].y - left[i - 1].y >= 16);
});

test("directional paths avoid both endpoint cards across horizontal, vertical and mixed layouts", () => {
  const from = newNode("source");
  const to = newNode("target");
  const sourcePort = from.outputPorts[0], targetPort = to.inputPorts[0];
  const layouts = [
    [520, 0], [-520, 0], [0, 380], [0, -380],
    [235, 32], [-235, -32], [22, 127], [-22, -127],
    [310, 195], [-310, 195], [-310, -195], [310, -195], [74000, 76000],
  ];
  for (const [x, y] of layouts) {
    to.position = { x, y };
    for (const output of PORT_SIDES) for (const input of PORT_SIDES) {
      sourcePort.side = output;
      targetPort.side = input;
      const start = layoutNode(from).ports.get(sourcePort.id), end = layoutNode(to).ports.get(targetPort.id);
      for (const style of ["bezier", "orthogonal"]) anchoredPath(wirePath(start, end, style), start, end, style);
    }
  }
});

test("wire anchors follow changes in position and side, and previews leave from the source side", () => {
  const from = newNode("source");
  const to = newNode("target", 400, 0);
  const sourcePort = from.outputPorts[0], targetPort = to.inputPorts[0];
  const start = () => layoutNode(from).ports.get(sourcePort.id);
  const end = () => layoutNode(to).ports.get(targetPort.id);
  const first = wirePath(start(), end(), "bezier");
  assert.equal(first, "M 234 63 C 303.72 63, 330.28 63, 400 63");
  to.position.y = 190;
  assert.notEqual(wirePath(start(), end(), "bezier"), first);
  sourcePort.side = "bottom";
  const preview = commands(freeWirePreview(start(), to.position));
  assert.equal(preview[1].points[0][0], start().x);
  assert.ok(preview[1].points[0][1] > start().y);
  assert.deepEqual(preview.at(-1).points.at(-1), position(to.position));
  anchoredPath(wirePath(start(), end(), "orthogonal"), start(), end(), "orthogonal");
});
