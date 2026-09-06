import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const code = app.slice(app.indexOf("function renderEdges(){"), app.indexOf("let edgeAnimUntil="));
type Point = { x: number; y: number };
type Box = { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number };

// Sample the actual SVG path, including rounded corners and the original cubic curves.
function sample(d: string): Point[] {
  const tokens = d.match(/[MHVQC]|-?\d+(?:\.\d+)?/g)!;
  const points: Point[] = [];
  let at: Point = { x: 0, y: 0 }, i = 0;
  const number = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M") { at = { x: number(), y: number() }; points.push(at); continue; }
    const start = at;
    let end: Point, c1: Point | undefined, c2: Point | undefined;
    if (command === "H") end = { x: number(), y: at.y };
    else if (command === "V") end = { x: at.x, y: number() };
    else if (command === "Q") { c1 = { x: number(), y: number() }; end = { x: number(), y: number() }; }
    else if (command === "C") { c1 = { x: number(), y: number() }; c2 = { x: number(), y: number() }; end = { x: number(), y: number() }; }
    else throw new Error(`Unsupported SVG command ${command}`);
    for (let step = 1; step <= 200; step++) {
      const t = step / 200, u = 1 - t;
      const value = (axis: "x" | "y") => c2
        ? u ** 3 * start[axis] + 3 * u ** 2 * t * c1![axis] + 3 * u * t ** 2 * c2[axis] + t ** 3 * end[axis]
        : c1 ? u ** 2 * start[axis] + 2 * u * t * c1[axis] + t ** 2 * end[axis]
        : u * start[axis] + t * end[axis];
      points.push({ x: value("x"), y: value("y") });
    }
    at = end;
  }
  return points;
}

function render(mode: string, queueWidth: number, withQueue = true) {
  const paths: Record<string, string>[] = [];
  const boxes = new Map<string, Box>();
  const gateway: Box = { offsetLeft: mode === "tree" ? 32 : 40, offsetTop: mode === "tree" ? 40 : 180, offsetWidth: 210, offsetHeight: 70 };
  const parentX = queueWidth === 260 ? 360 : 460;
  const tasks: any[] = [40, 300, 610].map((top, i) => {
    const id = `T-${i}`;
    boxes.set(`node-${id}`, { offsetLeft: parentX, offsetTop: top, offsetWidth: 320, offsetHeight: 124 });
    return { id, status: "run", sub: false };
  });
  const child = { id: "T-1.1", parent: "T-1", status: "run", sub: true };
  boxes.set(`node-${child.id}`, { offsetLeft: parentX + 400, offsetTop: 370, offsetWidth: 300, offsetHeight: 112 });
  tasks.push(child);
  const queue = withQueue ? [0, 1, 2].map(i => {
    const id = `Q-${i}`;
    boxes.set(`node-${id}`, { offsetLeft: gateway.offsetLeft, offsetTop: gateway.offsetTop + gateway.offsetHeight + 40 + i * 108, offsetWidth: queueWidth, offsetHeight: 90 });
    return { id, status: "queue", sub: false };
  }) : [];
  tasks.push(...queue);
  runInNewContext(code + "\nrenderEdges();", {
    S: { layout: mode, tasks: new Map(tasks.map(t => [t.id, t])), sel: null },
    gwEl: gateway, famOf: () => new Set(), graphTasks: () => tasks, queuedTasks: () => queue,
    edgeCls: () => "edge", drawIn() {}, edgesSvg: { textContent: "", append(path: any) { paths.push(path.attrs); } },
    document: { getElementById: (id: string) => boxes.get(id), createElementNS: () => ({ attrs: {}, setAttribute(this: any, key: string, value: string) { this.attrs[key] = value; } }) },
  });
  return { paths, boxes, queue, gateway };
}

test("gateway routes avoid every queue card in tree and radial layouts, including wider cards", () => {
  for (const mode of ["tree", "radial"]) for (const width of [260, 340]) {
    const { paths, boxes, queue, gateway } = render(mode, width);
    for (const path of paths.slice(0, 3)) {
      const points = sample(path.d!);
      for (const q of queue) {
        const box = boxes.get(`node-${q.id}`)!;
        const hits = points.filter(p => p.x >= box.offsetLeft && p.x <= box.offsetLeft + box.offsetWidth
          && p.y >= box.offsetTop && p.y <= box.offsetTop + box.offsetHeight);
        expect(hits).toHaveLength(0);
      }
      // The long vertical segment runs in the clear gutter, not over the queue's title.
      const ys = points.filter(p => p.y > gateway.offsetTop + gateway.offsetHeight + 40);
      if (ys.length) expect(Math.min(...ys.map(p => p.x))).toBeGreaterThanOrEqual(gateway.offsetLeft + width + 24 - 1e-6);
    }
  }
});

test("parent-child and queue-free gateway edges retain their cubic anchors", () => {
  for (const mode of ["tree", "radial"]) {
    const { paths, boxes } = render(mode, 260);
    const p = boxes.get("node-T-1")!, child = boxes.get("node-T-1.1")!;
    const x1 = p.offsetLeft + p.offsetWidth, x2 = child.offsetLeft, cx = Math.round((x1 + x2) / 2);
    const y1 = p.offsetTop + (mode === "tree" ? 22 : p.offsetHeight / 2);
    const y2 = child.offsetTop + (mode === "tree" ? 22 : child.offsetHeight / 2);
    expect(paths[3]!.d).toBe(`M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`);
    const plain = render(mode, 260, false);
    for (const path of plain.paths) expect(path.d).toContain(" C");
  }
});
