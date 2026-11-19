import { PORT_SIDES, portSide, type DesignNode, type PathStyle, type Port, type PortKind, type PortSide } from "./flow-project.js";

type Point = { x: number; y: number };
type Bounds = { left: number; right: number; top: number; bottom: number };
export type PortPosition = Point & { port: Port; kind: PortKind; side: PortSide; bounds: Bounds };
export const CARD_WIDTH = 234;
export const CARD_HEIGHT = 126;
const outward: Record<PortSide, Point> = {
  left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
};

export function layoutNode(node: DesignNode) {
  const sides: Record<PortSide, { port: Port; kind: PortKind }[]> = { left: [], right: [], top: [], bottom: [] };
  for (const port of node.inputPorts) sides[portSide(port, "input")].push({ port, kind: "input" });
  for (const port of node.outputPorts) sides[portSide(port, "output")].push({ port, kind: "output" });
  const width = Math.max(CARD_WIDTH, (Math.max(sides.top.length, sides.bottom.length) + 1) * 22);
  const height = Math.max(CARD_HEIGHT, 44 + Math.max(sides.left.length, sides.right.length) * 26);
  const { x, y } = node.position;
  const bounds = { left: x, right: x + width, top: y, bottom: y + height };
  const ports = new Map<string, PortPosition>();
  for (const side of PORT_SIDES) {
    const bucket = sides[side];
    const normal = outward[side];
    bucket.forEach(({ port, kind }, index) => {
      const step = (index + 1) / (bucket.length + 1);
      ports.set(port.id, {
        port, kind, side, bounds,
        x: x + width * (normal.x ? (normal.x + 1) / 2 : step),
        y: y + height * (normal.y ? (normal.y + 1) / 2 : step),
      });
    });
  }
  return { width, height, bounds, ports };
}

const advance = (point: Point, vector: Point, distance: number): Point => ({ x: point.x + vector.x * distance, y: point.y + vector.y * distance });
const projection = (from: Point, to: Point, axis: Point) => (to.x - from.x) * axis.x + (to.y - from.y) * axis.y;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const coords = (point: Point) => `${point.x} ${point.y}`;
const cubic = (a: Point, p: Point, q: Point, b: Point) => `M ${coords(a)} C ${coords(p)}, ${coords(q)}, ${coords(b)}`;
const line = (points: Point[]) => `M ${points.map(coords).join(" L ")}`;

export function freeWirePreview(from: PortPosition, end: Point): string {
  const length = Math.min(160, Math.hypot(end.x - from.x, end.y - from.y) * .45);
  return cubic(from, advance(from, outward[from.side], length), end, end);
}

function clearSegment(a: Point, b: Point, box: Bounds): boolean {
  if (a.x === b.x) {
    return a.x <= box.left || a.x >= box.right || Math.min(a.y, b.y) >= box.bottom || Math.max(a.y, b.y) <= box.top;
  }
  return a.y <= box.top || a.y >= box.bottom || Math.min(a.x, b.x) >= box.right || Math.max(a.x, b.x) <= box.left;
}

function lead(port: PortPosition, other: Bounds): Point {
  const normal = outward[port.side];
  const horizontal = normal.x !== 0;
  const inRange = horizontal ? port.y > other.top && port.y < other.bottom : port.x > other.left && port.x < other.right;
  const gap = horizontal
    ? (normal.x > 0 ? other.left - port.x : port.x - other.right)
    : (normal.y > 0 ? other.top - port.y : port.y - other.bottom);
  return advance(port, normal, inRange && gap >= 0 ? Math.min(22, gap / 2) : 22);
}

function compact(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const next of points) {
    const last = result.at(-1), prior = result.at(-2);
    if (last && distance(last, next) === 0) continue;
    if (last && prior && ((prior.x === last.x && last.x === next.x && (last.y - prior.y) * (next.y - last.y) > 0)
      || (prior.y === last.y && last.y === next.y && (last.x - prior.x) * (next.x - last.x) > 0))) result.pop();
    result.push(next);
  }
  return result;
}

function orthogonalRoute(from: PortPosition, to: PortPosition): Point[] {
  const a = lead(from, to.bounds), b = lead(to, from.bounds);
  const boxes = [from.bounds, to.bounds];
  const xs = new Set([(a.x + b.x) / 2, a.x, b.x, ...boxes.flatMap(box => [box.left - 16, box.right + 16])]);
  const ys = new Set([(a.y + b.y) / 2, a.y, b.y, ...boxes.flatMap(box => [box.top - 16, box.bottom + 16])]);
  let best: Point[] | undefined;
  let bestCost = Infinity;

  function consider(turns: Point[]): void {
    const path = compact([from, a, ...turns, b, to]);
    if (path.length < 2 || projection(from, path[1]!, outward[from.side]) <= 0
      || projection(to, path.at(-2)!, outward[to.side]) <= 0) return;
    let cost = (path.length - 2) * 12;
    for (let i = 1; i < path.length; i++) {
      const start = path[i - 1]!, end = path[i]!, previous = path[i - 2];
      // Collinear segments remaining after compaction would reverse at the turn.
      if (previous && ((previous.x === start.x && start.x === end.x) || (previous.y === start.y && start.y === end.y))) return;
      if (boxes.some(box => !clearSegment(start, end, box))) return;
      cost += distance(start, end);
    }
    if (cost < bestCost) { best = path; bestCost = cost; }
  }

  if (a.x === b.x || a.y === b.y) consider([]);
  for (const x of xs) consider([{ x, y: a.y }, { x, y: b.y }]);
  for (const y of ys) consider([{ x: a.x, y }, { x: b.x, y }]);
  if (best) return best;

  // Try an extra corner along the outside of the two endpoint cards.
  for (const x of xs) for (const y of ys) {
    consider([{ x, y: a.y }, { x, y }, { x: b.x, y }]);
    consider([{ x: a.x, y }, { x, y }, { x, y: b.y }]);
  }
  // An anchor covered by the other card can make an exterior route impossible.
  return best ?? compact([from, a, { x: a.x, y: b.y }, b, to]);
}

function roundedPath(points: Point[], boxes: Bounds[]): string {
  if (points.length < 3) return line(points);
  let path = `M ${coords(points[0]!)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const corner = points[i]!, previous = points[i - 1]!, next = points[i + 1]!;
    const before = distance(corner, previous), after = distance(corner, next);
    const radius = Math.min(20, before / 2, after / 2);
    const start = advance(corner, { x: (previous.x - corner.x) / before, y: (previous.y - corner.y) / before }, radius);
    const end = advance(corner, { x: (next.x - corner.x) / after, y: (next.y - corner.y) / after }, radius);
    const cutsCard = boxes.some(box => Math.min(start.x, end.x) < box.right && Math.max(start.x, end.x) > box.left
      && Math.min(start.y, end.y) < box.bottom && Math.max(start.y, end.y) > box.top);
    path += cutsCard ? ` L ${coords(corner)}` : ` L ${coords(start)} Q ${coords(corner)}, ${coords(end)}`;
  }
  return `${path} L ${coords(points.at(-1)!)}`;
}

export function wirePath(from: PortPosition, to: PortPosition, style: PathStyle): string {
  if (style === "orthogonal") return line(orthogonalRoute(from, to));
  const a = outward[from.side], b = outward[to.side];
  const da = projection(from, to, a), db = projection(to, from, b);
  const opposite = a.x * b.x + a.y * b.y === -1;
  if (da >= 0 && db >= 0 && (!opposite || da > 0)) {
    // The cubic's control polygon stays in the exterior half-plane of each card.
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const minimum = from.side === "right" && to.side === "left" ? 65 : 10;
    const preferred = Math.min(200, Math.max(minimum, distance * .42));
    const length = opposite ? Math.min(preferred, da) : Math.min(preferred, distance);
    return cubic(from, advance(from, a, length), advance(to, b, length), to);
  }
  return roundedPath(orthogonalRoute(from, to), [from.bounds, to.bounds]);
}
