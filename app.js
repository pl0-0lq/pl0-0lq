const fileInput = document.getElementById('gcodeFile');
const layerSelect = document.getElementById('layerSelect');
const meta = document.getElementById('meta');
const output = document.getElementById('gcodeOutput');
const downloadBtn = document.getElementById('downloadBtn');

const leftCanvas = document.getElementById('leftCanvas');
const rightCanvas = document.getElementById('rightCanvas');
const leftCtx = leftCanvas.getContext('2d');
const rightCtx = rightCanvas.getContext('2d');

const state = {
  rawLines: [],
  layers: [],
  activeLayer: null,
  startNodeIndex: null,
  endNodeIndex: null,
  rebuiltGcode: '',
};

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const text = await file.text();
  state.rawLines = text.split(/\r?\n/);
  state.layers = parseLayers(state.rawLines);

  if (!state.layers.length) {
    meta.textContent = '압출 이동(G1 + E증가) 레이어를 찾지 못했습니다.';
    layerSelect.disabled = true;
    return;
  }

  layerSelect.innerHTML = '';
  state.layers.forEach((layer, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `Layer ${layer.layerLabel ?? idx} (${layer.segments.length} segments)`;
    layerSelect.appendChild(opt);
  });

  layerSelect.disabled = false;
  layerSelect.value = '0';
  activateLayer(0);
  meta.textContent = `총 ${state.layers.length}개 레이어를 로드했습니다.`;
});

layerSelect.addEventListener('change', () => {
  activateLayer(Number(layerSelect.value));
});

leftCanvas.addEventListener('click', (event) => {
  if (!state.activeLayer) return;

  const p = eventToModelPoint(event, leftCanvas, state.activeLayer.bounds);
  const startIndex = nearestNodeIndex(state.activeLayer.nodes, p);
  state.startNodeIndex = startIndex;

  const rebuilt = rebuildLayerPath(state.activeLayer, startIndex);
  state.endNodeIndex = rebuilt.endNode;
  drawLayer(leftCtx, state.activeLayer, { start: state.startNodeIndex, end: state.endNodeIndex });
  drawPath(rightCtx, rebuilt.path, state.activeLayer.bounds, { start: state.startNodeIndex, end: state.endNodeIndex });

  state.rebuiltGcode = buildLayerGcode(rebuilt.path, state.activeLayer.segments[0]?.start?.z ?? 0);
  output.value = state.rebuiltGcode;
  downloadBtn.disabled = !state.rebuiltGcode;

  meta.textContent = `선택 시작점: #${state.startNodeIndex}, 자동 종료점: #${state.endNodeIndex}, 경로 길이: ${rebuilt.path.length}`;
});

downloadBtn.addEventListener('click', () => {
  if (!state.rebuiltGcode) return;

  const blob = new Blob([state.rebuiltGcode], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modified-layer.gcode';
  a.click();
  URL.revokeObjectURL(url);
});

function activateLayer(index) {
  state.activeLayer = state.layers[index];
  state.startNodeIndex = null;
  state.endNodeIndex = null;
  output.value = '';
  state.rebuiltGcode = '';
  downloadBtn.disabled = true;

  drawLayer(leftCtx, state.activeLayer);
  clearCanvas(rightCtx, rightCanvas);
}

function parseLayers(lines) {
  const layers = [];
  let currentLayer = { layerLabel: 0, segments: [] };
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let layerLabel = 0;

  for (const line of lines) {
    const layerMatch = line.match(/^;LAYER:(\d+)/);
    if (layerMatch) {
      if (currentLayer.segments.length) {
        layers.push(finalizeLayer(currentLayer));
      }
      layerLabel = Number(layerMatch[1]);
      currentLayer = { layerLabel, segments: [] };
      continue;
    }

    if (!line.startsWith('G0') && !line.startsWith('G1')) continue;

    const nx = readCoord(line, 'X', x);
    const ny = readCoord(line, 'Y', y);
    const nz = readCoord(line, 'Z', z);
    const ne = readCoord(line, 'E', e);
    const isExtrude = line.startsWith('G1') && ne > e && (nx !== x || ny !== y);

    if (isExtrude) {
      currentLayer.segments.push({
        start: { x, y, z },
        end: { x: nx, y: ny, z: nz },
        eDelta: ne - e,
      });
    }

    x = nx;
    y = ny;
    z = nz;
    e = ne;
  }

  if (currentLayer.segments.length) {
    layers.push(finalizeLayer(currentLayer));
  }

  return layers;
}

function finalizeLayer(layer) {
  const keyToIdx = new Map();
  const nodes = [];
  const edges = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  function getNode(p) {
    const key = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    if (!keyToIdx.has(key)) {
      keyToIdx.set(key, nodes.length);
      nodes.push({ x: p.x, y: p.y });
    }
    return keyToIdx.get(key);
  }

  layer.segments.forEach((seg, idx) => {
    const a = getNode(seg.start);
    const b = getNode(seg.end);
    edges.push({ a, b, segIndex: idx });

    minX = Math.min(minX, seg.start.x, seg.end.x);
    maxX = Math.max(maxX, seg.start.x, seg.end.x);
    minY = Math.min(minY, seg.start.y, seg.end.y);
    maxY = Math.max(maxY, seg.start.y, seg.end.y);
  });

  return {
    ...layer,
    nodes,
    edges,
    bounds: { minX, minY, maxX, maxY },
  };
}

function rebuildLayerPath(layer, requestedStart) {
  const adjacency = new Map();
  layer.nodes.forEach((_, i) => adjacency.set(i, []));

  layer.edges.forEach((edge, id) => {
    adjacency.get(edge.a).push({ to: edge.b, edgeId: id });
    adjacency.get(edge.b).push({ to: edge.a, edgeId: id });
  });

  const oddNodes = [...adjacency.entries()].filter(([, arr]) => arr.length % 2 === 1).map(([node]) => node);
  const start = oddNodes.includes(requestedStart)
    ? requestedStart
    : oddNodes.length
      ? oddNodes[0]
      : requestedStart;

  const end = chooseEndNode(start, layer.nodes, oddNodes, adjacency);

  const eulerEdges = hierholzer(layer.edges, adjacency, start);
  const path = [];

  if (eulerEdges.length === layer.edges.length) {
    let cursor = start;
    path.push(layer.nodes[cursor]);
    for (const eId of eulerEdges) {
      const edge = layer.edges[eId];
      cursor = edge.a === cursor ? edge.b : edge.a;
      path.push(layer.nodes[cursor]);
    }
  } else {
    path.push(...greedyPath(layer.nodes, start));
  }

  return { path, endNode: end };
}

function hierholzer(edges, adjacency, start) {
  const used = new Array(edges.length).fill(false);
  const stack = [{ node: start, inEdge: -1 }];
  const circuit = [];

  while (stack.length) {
    const top = stack[stack.length - 1];
    const options = adjacency.get(top.node);
    const next = options.find((o) => !used[o.edgeId]);

    if (next) {
      used[next.edgeId] = true;
      stack.push({ node: next.to, inEdge: next.edgeId });
    } else {
      const popped = stack.pop();
      if (popped.inEdge !== -1) {
        circuit.push(popped.inEdge);
      }
    }
  }

  return circuit.reverse();
}

function greedyPath(nodes, start) {
  const remaining = new Set(nodes.map((_, i) => i));
  let current = start;
  const route = [nodes[current]];
  remaining.delete(current);

  while (remaining.size) {
    let best = null;
    let bestDist = Infinity;

    for (const candidate of remaining) {
      const d = dist(nodes[current], nodes[candidate]);
      if (d < bestDist) {
        best = candidate;
        bestDist = d;
      }
    }

    current = best;
    route.push(nodes[current]);
    remaining.delete(current);
  }

  return route;
}

function chooseEndNode(start, nodes, oddNodes, adjacency) {
  const candidates = oddNodes.length >= 2 ? oddNodes.filter((n) => n !== start) : nodes.map((_, i) => i).filter((i) => i !== start);
  if (!candidates.length) return start;

  let best = candidates[0];
  let maxDistance = -Infinity;
  for (const idx of candidates) {
    const d = shortestGraphDistance(start, idx, adjacency, nodes);
    if (d > maxDistance) {
      maxDistance = d;
      best = idx;
    }
  }

  return best;
}

function shortestGraphDistance(src, dst, adjacency, nodes) {
  const q = [src];
  const distMap = new Map([[src, 0]]);

  while (q.length) {
    const cur = q.shift();
    if (cur === dst) return distMap.get(cur);
    for (const n of adjacency.get(cur)) {
      if (!distMap.has(n.to)) {
        const step = dist(nodes[cur], nodes[n.to]);
        distMap.set(n.to, distMap.get(cur) + step);
        q.push(n.to);
      }
    }
  }

  return dist(nodes[src], nodes[dst]);
}

function buildLayerGcode(path, z) {
  if (!path.length) return '';
  let gcode = '; Modified path\nG21\nG90\n';
  let e = 0;
  const ePerMm = 0.045;

  gcode += `G0 X${path[0].x.toFixed(3)} Y${path[0].y.toFixed(3)} Z${z.toFixed(3)}\n`;
  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1];
    const cur = path[i];
    e += dist(prev, cur) * ePerMm;
    gcode += `G1 X${cur.x.toFixed(3)} Y${cur.y.toFixed(3)} E${e.toFixed(5)}\n`;
  }

  return gcode;
}

function drawLayer(ctx, layer, markers = {}) {
  clearCanvas(ctx, ctx.canvas);
  const mapPoint = makeMapper(ctx.canvas, layer.bounds);

  ctx.lineWidth = 1.2;
  ctx.strokeStyle = '#7aa2f7';
  ctx.beginPath();
  for (const seg of layer.segments) {
    const a = mapPoint(seg.start);
    const b = mapPoint(seg.end);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  if (markers.start != null) {
    const p = mapPoint(layer.nodes[markers.start]);
    drawPoint(ctx, p, '#2ecc71', 6);
  }
  if (markers.end != null) {
    const p = mapPoint(layer.nodes[markers.end]);
    drawPoint(ctx, p, '#e74c3c', 6);
  }
}

function drawPath(ctx, path, bounds, markers = {}) {
  clearCanvas(ctx, ctx.canvas);
  if (path.length < 2) return;
  const mapPoint = makeMapper(ctx.canvas, bounds);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#58a6ff';
  ctx.beginPath();
  const first = mapPoint(path[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < path.length; i += 1) {
    const p = mapPoint(path[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  if (markers.start != null) drawPoint(ctx, mapPoint(path[0]), '#2ecc71', 6);
  if (markers.end != null) drawPoint(ctx, mapPoint(path[path.length - 1]), '#e74c3c', 6);
}

function eventToModelPoint(event, canvas, bounds) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  const mapper = makeInverseMapper(canvas, bounds);
  return mapper({ x, y });
}

function makeMapper(canvas, bounds) {
  const padding = 24;
  const dx = Math.max(1, bounds.maxX - bounds.minX);
  const dy = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((canvas.width - 2 * padding) / dx, (canvas.height - 2 * padding) / dy);

  return (p) => ({
    x: padding + (p.x - bounds.minX) * scale,
    y: canvas.height - (padding + (p.y - bounds.minY) * scale),
  });
}

function makeInverseMapper(canvas, bounds) {
  const padding = 24;
  const dx = Math.max(1, bounds.maxX - bounds.minX);
  const dy = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((canvas.width - 2 * padding) / dx, (canvas.height - 2 * padding) / dy);

  return (p) => ({
    x: (p.x - padding) / scale + bounds.minX,
    y: ((canvas.height - p.y) - padding) / scale + bounds.minY,
  });
}

function nearestNodeIndex(nodes, p) {
  let best = 0;
  let bestDist = Infinity;

  nodes.forEach((node, i) => {
    const d = dist(node, p);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });

  return best;
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawPoint(ctx, point, color, r) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function readCoord(line, code, fallback) {
  const regex = new RegExp(`${code}(-?\\d+(?:\\.\\d+)?)`);
  const match = line.match(regex);
  return match ? Number(match[1]) : fallback;
}
