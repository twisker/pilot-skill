"use strict";

// ---------------------------------------------------------------------------
// PILOT localhost 只读 UI —— 原生 JS，无框架。
// 数据流：/api/state + /api/config 拉取一次 -> 渲染三个视图；
// /events(SSE) 收到 update -> 全量重新拉取 + 全量重渲染（V1 不做 diff，
// 简单粗暴但足够正确）。
// ---------------------------------------------------------------------------

const KIND_ICON = { sight: "🏞️", meal: "🍜", hotel: "🏨", transit: "🚗", other: "📍" };
const DAY_COLORS = [
  "#2f6f4f",
  "#c2712f",
  "#3a6bc7",
  "#a83a6f",
  "#7a4fc2",
  "#c73a3a",
  "#3ab5a0",
  "#8a8a2f",
];

let latestState = { intake: null, travelogues: null, itinerary: null, progress: null };
let latestConfig = { tianditu_key: null };
let activeTab = "timeline";
let mapInstance = null;

// ---------------------------------------------------------------------------
// 长任务体验进度面板（spec §10.9）：九阶段 stepper + 当前阶段进度条/沙漏 + message。
// ---------------------------------------------------------------------------

const PROGRESS_STAGE_ORDER = [
  "intake",
  "search",
  "fetch",
  "structure",
  "distill",
  "itinerary",
  "refine",
  "check",
  "export",
];
const PROGRESS_STAGE_LABELS = {
  intake: "意图收集",
  search: "搜索编排",
  fetch: "抓取",
  structure: "结构化",
  distill: "精选",
  itinerary: "行程生成",
  refine: "逐日细化",
  check: "冲突检查",
  export: "导出",
  video: "视频预处理（支线）",
};
const PROGRESS_IDLE_MS = 10 * 60 * 1000; // 10 分钟无更新视为空闲

function isProgressStale(progress) {
  if (!progress || !progress.updated_at) return true;
  const t = new Date(progress.updated_at).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > PROGRESS_IDLE_MS;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** 只允许 http(s) 链接，防止扫描/策展内容里混入 javascript: 等危险 scheme。 */
function safeUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function dayColor(day) {
  const idx = ((Number(day) - 1) % DAY_COLORS.length + DAY_COLORS.length) % DAY_COLORS.length;
  return DAY_COLORS[idx];
}

// ---------------------------------------------------------------------------
// 顶部摘要
// ---------------------------------------------------------------------------

function renderSummary(state) {
  const el = document.getElementById("trip-summary");
  const intake = state.intake;
  if (!intake) {
    el.textContent = "暂无 intake 信息（intake.json 尚未生成）";
    return;
  }
  const parts = [];
  if (intake.destination) parts.push(intake.destination);
  if (intake.dates && intake.dates.start && intake.dates.end) {
    parts.push(`${intake.dates.start} ~ ${intake.dates.end}`);
  }
  if (intake.party) {
    const p = intake.party;
    const people = [`${p.adults ?? 0}大`];
    if (p.children) people.push(`${p.children}小`);
    if (p.seniors) people.push(`${p.seniors}老`);
    parts.push(people.join(""));
  }
  if (intake.budget_cny !== null && intake.budget_cny !== undefined) {
    parts.push(`预算¥${intake.budget_cny}`);
  }
  el.textContent = parts.length ? parts.join(" · ") : "intake 信息不完整";
}

// ---------------------------------------------------------------------------
// 进度面板：九阶段 stepper（已完成✓/进行中动画/未开始灰）+ 当前阶段进度条
// （有 total）或沙漏动画（无 total）+ message；progress 为 null 或
// updated_at 超 10 分钟则显示「空闲」。
// ---------------------------------------------------------------------------

function renderProgressStepper(progress, idle) {
  const activeIdx = !idle && progress ? PROGRESS_STAGE_ORDER.indexOf(progress.stage) : -1;
  return PROGRESS_STAGE_ORDER.map((stage, i) => {
    let cls = "step-pending";
    if (activeIdx !== -1) {
      if (i < activeIdx) cls = "step-done";
      else if (i === activeIdx) cls = "step-active";
    }
    const label = escapeHtml(PROGRESS_STAGE_LABELS[stage] || stage);
    const mark = cls === "step-done" ? "✓" : i + 1;
    return `
      <div class="progress-step ${cls}">
        <span class="step-dot">${mark}</span>
        <span class="step-label">${label}</span>
      </div>
    `;
  }).join("");
}

function renderProgress(state) {
  const stepperEl = document.getElementById("progress-stepper");
  const barWrapEl = document.getElementById("progress-bar-wrap");
  const messageEl = document.getElementById("progress-message");
  if (!stepperEl || !barWrapEl || !messageEl) return;

  const progress = state.progress;
  const idle = isProgressStale(progress);

  stepperEl.innerHTML = renderProgressStepper(progress, idle);

  if (idle) {
    barWrapEl.innerHTML = `<div class="progress-idle">空闲</div>`;
    messageEl.textContent = "";
    return;
  }

  const label = escapeHtml(PROGRESS_STAGE_LABELS[progress.stage] || progress.stage);
  if (progress.current != null && progress.total != null && progress.total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
    barWrapEl.innerHTML = `
      <div class="progress-label">${label} ${progress.current}/${progress.total}</div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
    `;
  } else {
    barWrapEl.innerHTML = `
      <div class="progress-label">${label}</div>
      <div class="progress-hourglass" aria-label="处理中">⏳</div>
    `;
  }
  messageEl.textContent = progress.message || "";
}

// ---------------------------------------------------------------------------
// ① 时间线
// ---------------------------------------------------------------------------

function renderItemRow(item) {
  const icon = KIND_ICON[item.kind] || KIND_ICON.other;
  const time = item.time ? escapeHtml(item.time) : "--:--";
  const metaParts = [];

  if (item.cost_cny !== null && item.cost_cny !== undefined) {
    metaParts.push(`¥${item.cost_cny}`);
  }
  if (item.booking) {
    const label = escapeHtml(item.booking.name || item.booking.type || "预订");
    const url = safeUrl(item.booking.url);
    metaParts.push(
      url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label} ↗</a>` : label,
    );
  }

  return `
    <div class="item-row">
      <div class="item-icon">${icon}</div>
      <div class="item-time">${time}</div>
      <div class="item-body">
        <div class="item-name">${escapeHtml(item.name)}</div>
        ${item.note ? `<div class="item-note">${escapeHtml(item.note)}</div>` : ""}
        ${metaParts.length ? `<div class="item-meta">${metaParts.join("")}</div>` : ""}
      </div>
    </div>
  `;
}

function renderDayCard(day) {
  const items = Array.isArray(day.items) ? day.items : [];
  const itemsHtml = items.length
    ? items.map(renderItemRow).join("")
    : `<div class="panel-message">这天还没有安排</div>`;
  return `
    <div class="day-card">
      <h2>第${day.day}天 · ${escapeHtml(day.date || "")}</h2>
      ${itemsHtml}
    </div>
  `;
}

function renderTimeline(state) {
  const root = document.getElementById("timeline-root");
  const itinerary = state.itinerary;
  if (!itinerary || !Array.isArray(itinerary.days) || itinerary.days.length === 0) {
    root.innerHTML = `<div class="panel-message">暂无行程数据（itinerary.json 尚未生成）</div>`;
    return;
  }
  root.innerHTML = itinerary.days.map(renderDayCard).join("");
}

// ---------------------------------------------------------------------------
// ③ 参考游记卡片墙
// ---------------------------------------------------------------------------

function renderTravelogueCard(t) {
  const tags = Array.isArray(t.tags)
    ? t.tags.map((tag) => `<span class="tag-pill">${escapeHtml(tag)}</span>`).join("")
    : "";
  const url = safeUrl(t.url);
  const total = t.total !== null && t.total !== undefined ? t.total : "--";
  return `
    <div class="travelogue-card">
      <div class="card-id">${escapeHtml(t.id)}</div>
      <div class="card-brief">${escapeHtml(t.brief)}</div>
      <div>${tags}</div>
      <div class="card-footer">
        <span>评分 ${escapeHtml(total)}</span>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">查看原文 ↗</a>` : ""}
      </div>
    </div>
  `;
}

function renderCards(state) {
  const root = document.getElementById("cards-root");
  const list = state.travelogues;
  if (!Array.isArray(list) || list.length === 0) {
    root.innerHTML = `<div class="panel-message">暂无参考游记（travelogues/index.json 尚未生成）</div>`;
    return;
  }
  root.innerHTML = `<div class="cards-grid">${list.map(renderTravelogueCard).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// ② 地图（MapLibre + 天地图栅格底图）
// ---------------------------------------------------------------------------

function tiandituTiles(layer, key) {
  const subdomains = [0, 1, 2, 3, 4, 5, 6, 7];
  return subdomains.map(
    (i) =>
      `https://t${i}.tianditu.gov.cn/${layer}_w/wmts?tk=${key}&SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=tiles`,
  );
}

function dayColorMatchExpr(days) {
  const expr = ["match", ["get", "day"]];
  for (const day of days) {
    expr.push(day, dayColor(day));
  }
  expr.push("#888888");
  return expr;
}

function collectGeoPoints(state) {
  const days = state.itinerary && Array.isArray(state.itinerary.days) ? state.itinerary.days : [];
  const points = [];
  for (const day of days) {
    const items = Array.isArray(day.items) ? day.items : [];
    for (const item of items) {
      if (item.geo && typeof item.geo.lat === "number" && typeof item.geo.lng === "number") {
        points.push({ day: day.day, name: item.name, note: item.note, lat: item.geo.lat, lng: item.geo.lng });
      }
    }
  }
  return points;
}

function renderMap(state, config) {
  const guidance = document.getElementById("map-guidance");
  const container = document.getElementById("map");

  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  if (!config || !config.tianditu_key) {
    guidance.hidden = false;
    guidance.textContent =
      "地图视图需要天地图 key：请在 .env 中配置 TIANDITU_KEY（见安装目录说明）后重启 server（`<安装目录>/tools/server/server.ts start --trip <id>`）。";
    container.hidden = true;
    return;
  }

  const points = collectGeoPoints(state);
  if (points.length === 0) {
    guidance.hidden = false;
    guidance.textContent = "暂无坐标（itinerary 中的条目还没有 geo 字段）。";
    container.hidden = true;
    return;
  }

  guidance.hidden = true;
  container.hidden = false;

  const key = config.tianditu_key;
  const avgLng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  const avgLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;

  mapInstance = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        "tianditu-vec": { type: "raster", tiles: tiandituTiles("vec", key), tileSize: 256 },
        "tianditu-cva": { type: "raster", tiles: tiandituTiles("cva", key), tileSize: 256 },
      },
      layers: [
        { id: "tianditu-vec-layer", type: "raster", source: "tianditu-vec" },
        { id: "tianditu-cva-layer", type: "raster", source: "tianditu-cva" },
      ],
    },
    center: [avgLng, avgLat],
    zoom: 7,
  });
  mapInstance.addControl(new maplibregl.NavigationControl(), "top-right");

  mapInstance.on("load", () => {
    const byDay = new Map();
    for (const p of points) {
      if (!byDay.has(p.day)) byDay.set(p.day, []);
      byDay.get(p.day).push(p);
    }
    const colorExpr = dayColorMatchExpr(byDay.keys());

    const lineFeatures = [];
    for (const [day, pts] of byDay) {
      if (pts.length >= 2) {
        lineFeatures.push({
          type: "Feature",
          properties: { day },
          geometry: { type: "LineString", coordinates: pts.map((p) => [p.lng, p.lat]) },
        });
      }
    }
    mapInstance.addSource("day-lines", {
      type: "geojson",
      data: { type: "FeatureCollection", features: lineFeatures },
    });
    mapInstance.addLayer({
      id: "day-lines-layer",
      type: "line",
      source: "day-lines",
      paint: { "line-width": 3, "line-color": colorExpr, "line-opacity": 0.7 },
    });

    const pointFeatures = points.map((p) => ({
      type: "Feature",
      properties: { day: p.day, name: p.name, note: p.note },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    }));
    mapInstance.addSource("day-points", {
      type: "geojson",
      data: { type: "FeatureCollection", features: pointFeatures },
    });
    mapInstance.addLayer({
      id: "day-points-layer",
      type: "circle",
      source: "day-points",
      paint: {
        "circle-radius": 7,
        "circle-color": colorExpr,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });

    mapInstance.on("mouseenter", "day-points-layer", () => {
      mapInstance.getCanvas().style.cursor = "pointer";
    });
    mapInstance.on("mouseleave", "day-points-layer", () => {
      mapInstance.getCanvas().style.cursor = "";
    });
    mapInstance.on("click", "day-points-layer", (e) => {
      const feature = e.features && e.features[0];
      if (!feature) return;
      const props = feature.properties;
      new maplibregl.Popup({ closeButton: true })
        .setLngLat(feature.geometry.coordinates)
        .setHTML(
          `<div class="maplibre-popup-body"><div class="item-name">${escapeHtml(
            props.name,
          )}</div><div class="item-note">${escapeHtml(props.note)}</div></div>`,
        )
        .addTo(mapInstance);
    });
  });
}

// ---------------------------------------------------------------------------
// tabs / 数据拉取 / SSE
// ---------------------------------------------------------------------------

function renderAll() {
  renderSummary(latestState);
  renderProgress(latestState);
  renderTimeline(latestState);
  renderCards(latestState);
  if (activeTab === "map") {
    renderMap(latestState, latestConfig);
  }
}

function setActiveTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  });
  if (name === "map") {
    renderMap(latestState, latestConfig);
  }
}

async function refreshAll() {
  const [stateRes, configRes] = await Promise.all([fetch("/api/state"), fetch("/api/config")]);
  latestState = await stateRes.json();
  latestConfig = await configRes.json();
  renderAll();
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
}

function initSSE() {
  const statusEl = document.getElementById("sse-status");
  const source = new EventSource("/events");
  source.onopen = () => {
    statusEl.textContent = "已连接，文件变化会自动刷新";
  };
  source.onerror = () => {
    statusEl.textContent = "连接中断，浏览器将自动重连…";
  };
  source.onmessage = () => {
    // 简单粗暴：收到任何 update 就整体重新拉取 + 重渲染（V1 不做局部 diff）
    refreshAll();
  };
}

initTabs();
refreshAll();
initSSE();
