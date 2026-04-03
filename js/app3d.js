/**
 * Nike Event Tracker 3D — ArcGIS Maps SDK 5.0 + Knowledge Graph
 * Uses SceneView (globe), 3D extruded symbols, and arc connections.
 */

/* ════════════════════════════════════════════════════════
   CONFIG
════════════════════════════════════════════════════════ */
const CFG = {
  PORTAL_URL : "https://tate.esri.com/portal",
  KG_SERVER  : "https://tate.esri.com/server",
  KG_URL     : "https://tate.esri.com/server/rest/services/Hosted/Nike_v16/KnowledgeGraphServer",
  EVENT_LIMIT: 100,
  ATHLETE_LIMIT: 0,
  VENUE_LIMIT: 3000,

  SPORT_LABEL_MAP: {
    "american football" : ["american football", "nfl", "ncaa"],
    "australian rules football" : ["australian football"],
    "baseball"          : ["baseball", "mlb"],
    "basketball"        : ["basketball", "nba", "wnba", "nba gleague", "ncaa"],
    "cricket"           : ["cricket"],
    "global football"   : ["soccer", "football"],
    "golf"              : ["golf", "pga", "lpga"],
    "hockey"            : ["hockey", "ice hockey", "nhl"],
    "indoor volleyball" : ["volleyball"],
    "nrl"               : ["rugby", "nrl"],
    "rugby"             : ["rugby"],
    "running / t&f"     : ["running", "marathon", "triathlon", "ironman", "sport"],
    "softball"          : ["softball"],
    "tennis"            : ["tennis"]
  }
};

const SCORE = {
  SPORT_LABEL: 5, BORN_IN_CITY: 4, TEAM_IN_CITY: 4,
  UNI_IN_CITY: 3, FROM_COUNTRY: 3, TEAM_IN_COUNTRY: 2, UNI_IN_COUNTRY: 1
};

/* ════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════ */
const STATE = {
  kg: null, kgService: null, view: null, layers: {},
  allAthletes: [], allEvents: [], allVenues: [],
  searchTimer: null, etypeFilter: "events",
  lastAthletes: [], lastEvents: [], lastCountHtml: "",
  crossFilter: null, arcLayer: null
};

/* ════════════════════════════════════════════════════════
   BOOT — SDK 5.0 ES modules via $arcgis.import()
════════════════════════════════════════════════════════ */
const [
  esriConfig, Map, SceneView, GraphicsLayer, Graphic,
  kgService, IdentityManager, Point, Polyline,
  LineSymbol3D, LineSymbol3DLayer
] = await $arcgis.import([
  "@arcgis/core/config.js",
  "@arcgis/core/Map.js",
  "@arcgis/core/views/SceneView.js",
  "@arcgis/core/layers/GraphicsLayer.js",
  "@arcgis/core/Graphic.js",
  "@arcgis/core/rest/knowledgeGraphService.js",
  "@arcgis/core/identity/IdentityManager.js",
  "@arcgis/core/geometry/Point.js",
  "@arcgis/core/geometry/Polyline.js",
  "@arcgis/core/symbols/LineSymbol3D.js",
  "@arcgis/core/symbols/LineSymbol3DLayer.js"
]);

STATE.kgService = kgService;

/* ── Fetch interceptor for portal path redirect ── */
(function () {
  const _fetch = window.fetch;
  const rootOrigin = new URL(CFG.PORTAL_URL).origin;
  const badPrefix  = `${rootOrigin}/sharing/rest`;
  const goodPrefix = `${CFG.PORTAL_URL}/sharing/rest`;
  window.fetch = function (input, init) {
    let url = (typeof input === "string") ? input : (input?.url || String(input));
    if (url.startsWith(badPrefix) && !url.startsWith(goodPrefix)) {
      const fixed = goodPrefix + url.slice(badPrefix.length);
      input = (typeof input === "string") ? fixed : new Request(fixed, input);
    }
    return _fetch.call(this, input, init);
  };
})();

/* ════════════════════════════════════════════════════════
   AUTH
════════════════════════════════════════════════════════ */
esriConfig.portalUrl = CFG.PORTAL_URL;
esriConfig.request.trustedServers.push("https://tate.esri.com");

const loginBtn = document.getElementById("login-btn");
const loginErr = document.getElementById("login-error");

loginBtn.addEventListener("click", doLogin);
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && document.getElementById("login-overlay").style.display !== "none") doLogin();
});

async function doLogin() {
  const user = document.getElementById("l-user").value.trim();
  const pass = document.getElementById("l-pass").value;
  if (!user || !pass) { loginErr.textContent = "Enter username and password."; return; }

  loginBtn.disabled = true; loginBtn.loading = true;
  loginBtn.innerHTML = "Connecting..."; loginErr.textContent = "";

  try {
    const resp = await fetch(`${CFG.PORTAL_URL}/sharing/rest/generateToken`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: user, password: pass,
        client: "referer", referer: window.location.origin,
        expiration: "120", f: "json"
      }).toString()
    });
    const raw = await resp.text();
    if (raw.trimStart().startsWith("<")) throw new Error("Portal returned HTML. Check network access.");
    const td = JSON.parse(raw);
    if (!td.token) throw new Error(td.error?.message || "No token.");

    IdentityManager.registerToken({ server: `${CFG.PORTAL_URL}/sharing/rest`, token: td.token, ssl: true, userId: user, expires: td.expires });
    IdentityManager.registerToken({ server: CFG.KG_SERVER, token: td.token, ssl: true, userId: user });
    const rootPortal = new URL(CFG.PORTAL_URL).origin;
    IdentityManager.registerToken({ server: `${rootPortal}/sharing/rest`, token: td.token, ssl: true, userId: user });

    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("app-header").style.display = "";
    document.getElementById("app-body").style.display = "";
    launchApp();
  } catch (err) {
    console.error("Login:", err);
    loginErr.textContent = err.message;
    loginBtn.disabled = false; loginBtn.loading = false;
    loginBtn.innerHTML = "Connect to Knowledge Graph";
  }
}

/* ════════════════════════════════════════════════════════
   LAUNCH 3D APP
════════════════════════════════════════════════════════ */
async function launchApp() {
  setBadge("Initializing globe...");

  const venueLayer   = new GraphicsLayer({ title: "Venues",   elevationInfo: { mode: "on-the-ground" } });
  const eventLayer   = new GraphicsLayer({ title: "Events",   elevationInfo: { mode: "relative-to-ground" } });
  const athleteLayer = new GraphicsLayer({ title: "Athletes", elevationInfo: { mode: "relative-to-ground" } });
  const arcLayer     = new GraphicsLayer({ title: "Arcs",     elevationInfo: { mode: "relative-to-ground" } });

  STATE.layers = { athletes: athleteLayer, events: eventLayer, venues: venueLayer };
  STATE.arcLayer = arcLayer;

  const map = new Map({
    basemap: "dark-gray-vector",
    ground: "world-elevation",
    layers: [venueLayer, eventLayer, athleteLayer, arcLayer]
  });

  const view = new SceneView({
    container: "viewDiv",
    map,
    camera: {
      position: { longitude: 20, latitude: 15, z: 22000000 },
      tilt: 0
    },
    qualityProfile: "high",
    environment: {
      background: { type: "color", color: [6, 6, 10, 1] },
      starsEnabled: true,
      atmosphereEnabled: true,
      atmosphere: { quality: "high" }
    },
    popup: { dockEnabled: false, defaultPopupTemplateEnabled: false },
    ui: { components: ["zoom", "navigation-toggle", "compass"] }
  });
  STATE.view = view;

  /* Map click */
  view.on("click", async evt => {
    const hit = await view.hitTest(evt, { include: [athleteLayer, eventLayer] });
    if (!hit.results.length) { closeDetail(); clearHighlight(); return; }
    const a = hit.results[0].graphic.attributes;
    const pool = a.__etype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
    const ent = pool.find(x => x.id === a.__eid);
    if (ent) selectEntity(ent, a.__etype);
  });

  /* Connect KG */
  setBadge("Connecting to Knowledge Graph...");
  try {
    await fetch(`${CFG.KG_SERVER}/rest/services?f=json`, { method: "GET" });
    STATE.kg = await kgService.fetchKnowledgeGraph(CFG.KG_URL);
    console.log("[schema]", Object.keys(STATE.kg.dataModel.entityTypes));
    setBadge("Connected", "ok");
    wireUI();
    await loadAllData();
  } catch (err) {
    console.error("KG error:", err);
    setBadge("KG Error", "err");
    showList(`<div class="state-box"><span style="color:#f55">${escH(err.message)}</span></div>`);
  }
}

/* ════════════════════════════════════════════════════════
   DATA LOADING
════════════════════════════════════════════════════════ */
async function loadAllData() {
  showList(`<div class="state-box"><calcite-loader scale="m" type="indeterminate"></calcite-loader><span>Loading graph data...</span></div>`);
  setCount("<b>Loading...</b>");

  const t0 = performance.now();
  const [athletes, events, venues] = await Promise.all([
    streamQuery("MATCH (a:Athlete) RETURN a", {}, CFG.ATHLETE_LIMIT),
    streamQuery("MATCH (e:Event)   RETURN e", {}, CFG.EVENT_LIMIT),
    streamQuery("MATCH (v:Venue)   RETURN v", {}, CFG.VENUE_LIMIT)
  ]);
  console.log(`[perf] ${(performance.now()-t0).toFixed(0)}ms | ${athletes.length}A ${events.length}E ${venues.length}V`);

  STATE.allAthletes = athletes;
  STATE.allVenues = venues;
  events.sort((a, b) => parseEventDate(b) - parseEventDate(a));
  STATE.allEvents = events;

  buildGraphics();

  document.getElementById("s-events").textContent = events.length;
  document.getElementById("s-athletes").textContent = athletes.length;
  document.getElementById("s-venues").textContent = venues.length;

  renderList(athletes, events, `<b>${events.length}</b> events · <b>${athletes.length}</b> athletes`);
}

/* ════════════════════════════════════════════════════════
   KG STREAMING (single-entity only)
════════════════════════════════════════════════════════ */
async function streamQuery(cypher, params = {}, maxRows = 0) {
  const result = await kgService.executeQueryStreaming(STATE.kg, {
    openCypherQuery: cypher, bindParameters: params
  });
  const rows = [];
  const reader = result.resultRowsStream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    for (const row of value) {
      if (maxRows > 0 && rows.length >= maxRows) continue;
      const ent = row[0];
      if (ent && ent.properties !== undefined) rows.push(parseEntity(ent));
    }
  }
  return rows;
}

async function safeStreamQuery(cypher, params = {}, maxRows = 200) {
  try { return await streamQuery(cypher, params, maxRows); }
  catch (e) { console.warn("[safe]", e.message); return []; }
}

function parseEntity(ent) {
  return { id: ent.id, typeName: ent.typeName, props: ent.properties, geom: extractPoint(ent.properties.shape) };
}
function extractPoint(shape) {
  if (!shape) return null;
  try {
    const x = shape.x ?? shape.coordinates?.[0];
    const y = shape.y ?? shape.coordinates?.[1];
    if (x == null || y == null || (x === 0 && y === 0)) return null;
    return { x: parseFloat(x), y: parseFloat(y) };
  } catch { return null; }
}

/* ════════════════════════════════════════════════════════
   3D GRAPHICS
════════════════════════════════════════════════════════ */
function buildGraphics() {
  STATE.layers.athletes.removeAll();
  STATE.layers.events.removeAll();
  STATE.layers.venues.removeAll();

  /* Events — extruded cylinders, height = rank (taller = higher rank) */
  STATE.layers.events.addMany(STATE.allEvents.filter(e => e.geom).map(e => {
    const rank = parseInt(e.props.rank) || 50;
    const height = Math.max(rank * 800, 20000);
    return new Graphic({
      geometry: { type: "point", longitude: e.geom.x, latitude: e.geom.y, z: height / 2 },
      symbol: {
        type: "point-3d",
        symbolLayers: [{
          type: "object",
          resource: { primitive: "cylinder" },
          material: { color: [0, 184, 255, 0.85] },
          width: 25000,
          depth: 25000,
          height: height
        }]
      },
      attributes: { __etype: "Event", __eid: e.id }
    });
  }));

  /* Athletes — orange spheres */
  STATE.layers.athletes.addMany(STATE.allAthletes.filter(e => e.geom).map(e => {
    return new Graphic({
      geometry: { type: "point", longitude: e.geom.x, latitude: e.geom.y, z: 15000 },
      symbol: {
        type: "point-3d",
        symbolLayers: [{
          type: "object",
          resource: { primitive: "sphere" },
          material: { color: [255, 85, 0, 0.9] },
          width: 18000, height: 18000, depth: 18000
        }]
      },
      attributes: { __etype: "Athlete", __eid: e.id }
    });
  }));

  /* Venues — small gray dots on ground */
  STATE.layers.venues.addMany(STATE.allVenues.filter(e => e.geom).map(e => {
    return new Graphic({
      geometry: { type: "point", longitude: e.geom.x, latitude: e.geom.y },
      symbol: {
        type: "point-3d",
        symbolLayers: [{
          type: "object",
          resource: { primitive: "sphere" },
          material: { color: [100, 100, 100, 0.4] },
          width: 5000, height: 5000, depth: 5000
        }]
      },
      attributes: { __etype: "Venue", __eid: e.id }
    });
  }));
}

/* ── 3D Arc connections ── */
function drawArcs(eventGeom, athleteGeoms) {
  STATE.arcLayer.removeAll();
  if (!eventGeom || !athleteGeoms.length) return;

  const arcs = athleteGeoms.map(ag => {
    const midLon = (eventGeom.x + ag.x) / 2;
    const midLat = (eventGeom.y + ag.y) / 2;
    const dist = Math.sqrt(Math.pow(eventGeom.x - ag.x, 2) + Math.pow(eventGeom.y - ag.y, 2));
    const arcHeight = Math.max(dist * 30000, 100000);

    return new Graphic({
      geometry: {
        type: "polyline",
        paths: [[
          [eventGeom.x, eventGeom.y, 50000],
          [midLon, midLat, arcHeight],
          [ag.x, ag.y, 15000]
        ]]
      },
      symbol: {
        type: "line-3d",
        symbolLayers: [{
          type: "line",
          size: 2,
          material: { color: [255, 85, 0, 0.6] }
        }]
      }
    });
  });

  STATE.arcLayer.addMany(arcs);
}

/* ── Highlight ── */
function highlightEntities(athIds, evIds) {
  // In 3D we just draw arcs, no symbol swapping needed
}

function clearHighlight() {
  STATE.arcLayer.removeAll();
}

/* ── Fly to ── */
function flyTo(lon, lat, zoom = 8000000) {
  if (!STATE.view) return;
  STATE.view.goTo({
    position: { longitude: lon, latitude: lat, z: zoom },
    tilt: 25
  }, { duration: 1500, easing: "ease-in-out" }).catch(() => {});
}

/* ════════════════════════════════════════════════════════
   SCORING (same 7-path algorithm)
════════════════════════════════════════════════════════ */
async function scoreAthletesForEvent(event) {
  const p = event.props;
  const eventLabels = getEventLabels(event);
  const eventCity = (p.city || p.locality || "").trim();
  const eventCountry = (p.country || "").trim();
  const board = new Map();

  function addScore(a, pts, reason) {
    if (!board.has(a.id)) board.set(a.id, { entity: a, score: 0, reasons: [] });
    const e = board.get(a.id);
    e.score += pts;
    e.reasons.push({ text: reason, points: pts });
  }

  STATE.allAthletes.forEach(a => {
    const shared = [...getAthleteLabelSet(a)].filter(l => eventLabels.has(l));
    if (shared.length > 0) addScore(a, SCORE.SPORT_LABEL, `Sport: ${a.props.sport}`);
  });

  const queries = [];
  if (eventCity) {
    queries.push(safeStreamQuery(`MATCH (a:Athlete)-[:BORN_IN]->(c:City) WHERE c.name = $city RETURN a`, { city: eventCity }).then(r => r.forEach(a => addScore(a, SCORE.BORN_IN_CITY, `Born in ${eventCity}`))));
    queries.push(safeStreamQuery(`MATCH (a:Athlete)-[:PLAYS_FOR]->(t:Team) WHERE t.city = $city RETURN a`, { city: eventCity }).then(r => r.forEach(a => addScore(a, SCORE.TEAM_IN_CITY, `Team in ${eventCity}`))));
    queries.push(safeStreamQuery(`MATCH (a:Athlete)-[:ATTENDS]->(u:University) WHERE u.city = $city RETURN a`, { city: eventCity }).then(r => r.forEach(a => addScore(a, SCORE.UNI_IN_CITY, `Studied in ${eventCity}`))));
  }
  if (eventCountry) {
    queries.push(safeStreamQuery(`MATCH (a:Athlete)-[:ORIGINATES_FROM]->(c:Country) WHERE c.name = $country RETURN a`, { country: eventCountry }).then(r => r.forEach(a => addScore(a, SCORE.FROM_COUNTRY, `From ${eventCountry}`))));
    queries.push(safeStreamQuery(`MATCH (a:Athlete)-[:PLAYS_FOR]->(t:Team) WHERE t.country = $country RETURN a`, { country: eventCountry }).then(r => r.forEach(a => addScore(a, SCORE.TEAM_IN_COUNTRY, `Team in ${eventCountry}`))));
    queries.push(safeStreamQuery(`MATCH (a:Athlete)-[:ATTENDS]->(u:University) WHERE u.country = $country RETURN a`, { country: eventCountry }).then(r => r.forEach(a => addScore(a, SCORE.UNI_IN_COUNTRY, `Studied in ${eventCountry}`))));
  }
  await Promise.all(queries);

  return [...board.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}

/* ════════════════════════════════════════════════════════
   LABEL HELPERS
════════════════════════════════════════════════════════ */
function getEventLabels(event) {
  const raw = event.props.labels || event.props.phq_labels || "";
  const str = String(raw), labels = new Set();
  try {
    const arr = JSON.parse(str.replace(/'/g, '"'));
    if (Array.isArray(arr)) { arr.forEach(i => { const l = (typeof i === "string" ? i : i?.label || "").toLowerCase().trim(); if (l) labels.add(l); }); return labels; }
  } catch {}
  str.split(/[,|]/).forEach(s => { const l = s.replace(/[\[\]'"]/g, "").toLowerCase().trim(); if (l) labels.add(l); });
  return labels;
}

function getAthleteLabelSet(a) {
  const s = (a.props.sport || "").toLowerCase().trim();
  const r = new Set(CFG.SPORT_LABEL_MAP[s] || []); r.add(s); return r;
}

function findRelatedEvents(athlete) {
  const al = getAthleteLabelSet(athlete);
  return STATE.allEvents.filter(e => [...al].some(l => getEventLabels(e).has(l))).map(e => ({ entity: e, reason: `Sport: ${athlete.props.sport}` }));
}

/* ════════════════════════════════════════════════════════
   ENTITY DETAIL
════════════════════════════════════════════════════════ */
async function selectEntity(entity, etype, scrollCard = true) {
  document.querySelectorAll(".entity-card").forEach(c => c.classList.remove("active"));
  const card = document.querySelector(`.entity-card[data-id="${entity.id}"]`);
  if (card) { card.classList.add("active"); if (scrollCard) card.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  if (etype === "Athlete") await showAthleteDetail(entity);
  else await showEventDetail(entity);
}

async function showEventDetail(event) {
  const p = event.props;
  document.getElementById("detail-etype").textContent = "Event";
  document.getElementById("detail-etype").className = "detail-etype event";
  document.getElementById("detail-name").textContent = p.name || "—";

  const labels = [...getEventLabels(event)];
  const labelHTML = labels.map(l => `<span class="reason-tag">${escH(l)}</span>`).join(" ");
  const att = p.phq_attendance ? Number(p.phq_attendance).toLocaleString() : "—";
  const spend = p.predictaed_event_spend ? "$" + Number(p.predictaed_event_spend).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—";

  document.getElementById("detail-body").innerHTML = `
    <div class="detail-grid">
      ${dp("Date", formatEventDate(event))} ${dp("Country", p.country || "—")}
      ${dp("City", p.city || p.locality || "—")} ${dp("Attendance", att)}
      ${dp("Est. Spend", spend)} ${dp("Rank", p.rank || "—")}
    </div>
    ${labels.length ? `<p class="related-label" style="margin-top:12px">Labels</p><div style="margin:6px 0 12px;line-height:1.8">${labelHTML}</div>` : ""}
    <div class="detail-relationship-hint">Scoring athletes via 7 graph paths...</div>
    <div id="athlete-results"><div class="state-box"><calcite-loader scale="m" type="indeterminate"></calcite-loader><span>Querying graph...</span></div></div>`;
  openDetailPanel();

  if (event.geom) flyTo(event.geom.x, event.geom.y, 4000000);

  const ranked = await scoreAthletesForEvent(event);
  const relAthletes = ranked.map(r => r.entity);

  /* Draw 3D arcs from event to matched athletes */
  if (event.geom) {
    const athGeoms = relAthletes.filter(a => a.geom).map(a => a.geom);
    drawArcs(event.geom, athGeoms);
  }

  if (relAthletes.length > 0) {
    STATE.crossFilter = { name: p.name || "Event", athletes: relAthletes, events: [] };
  }

  const relHTML = ranked.map((r, i) => {
    const ap = r.entity.props;
    const tags = r.reasons.sort((a, b) => b.points - a.points).map(re => `<span class="reason-tag" title="${re.points} pts">${escH(re.text)}</span>`).join(" ");
    return `<div class="related-item" data-zoom="${r.entity.id}" data-ztype="Athlete">
      <span class="rank-num">#${i + 1}</span><span class="rdot orange"></span>
      <span class="rname">${escH(ap.name || "Athlete")}</span>
      <span class="score-badge">${r.score} pts</span>
      <div class="reason-row">${tags}</div>
    </div>`;
  }).join("");

  document.getElementById("athlete-results").innerHTML = ranked.length > 0
    ? `<p class="related-label">Top ${ranked.length} Athletes</p><div class="related-list">${relHTML}</div>`
    : `<p class="related-label" style="color:#555">No athletes matched</p>`;
  wireRelatedClicks();
}

async function showAthleteDetail(athlete) {
  const p = athlete.props;
  document.getElementById("detail-etype").textContent = "Athlete";
  document.getElementById("detail-etype").className = "detail-etype athlete";
  document.getElementById("detail-name").textContent = p.name || "—";

  const related = findRelatedEvents(athlete);
  if (athlete.geom) flyTo(athlete.geom.x, athlete.geom.y, 6000000);

  if (related.length > 0) {
    STATE.crossFilter = { name: p.name || "Athlete", athletes: [], events: related.map(r => r.entity) };
    STATE.etypeFilter = "events";
    document.querySelectorAll(".etype-tab").forEach(t => t.classList.toggle("active", t.dataset.etype === "events"));
    applyEtypeFilter();

    if (athlete.geom) {
      const evGeoms = related.map(r => r.entity).filter(e => e.geom).map(e => e.geom);
      drawArcs(athlete.geom, evGeoms);
    }
  }

  const athLabels = [...getAthleteLabelSet(athlete)].map(l => `<span class="reason-tag">${escH(l)}</span>`).join(" ");
  const relHTML = related.slice(0, 10).map(r => {
    const ep = r.entity.props;
    return `<div class="related-item" data-zoom="${r.entity.id}" data-ztype="Event">
      <span class="rdot blue"></span><span class="rname">${escH(ep.name || "Event")}</span>
      <span class="rmeta">${escH(ep.country || "")} ${formatEventDate(r.entity)}</span>
    </div>`;
  }).join("");

  document.getElementById("detail-body").innerHTML = `
    <div class="detail-grid">
      ${dp("Sport", p.sport || "—")} ${dp("Gender", p.gender || "—")} ${dp("Type", p.type || "—")}
    </div>
    ${athLabels ? `<p class="related-label" style="margin-top:12px">Sport Labels</p><div style="margin:6px 0 12px;line-height:1.8">${athLabels}</div>` : ""}
    <div class="detail-relationship-hint">Events matched via sport labels</div>
    ${related.length ? `<p class="related-label">${related.length} Related Events</p><div class="related-list">${relHTML}</div>` : `<p class="related-label" style="color:#555">No matching events</p>`}`;
  wireRelatedClicks();
  openDetailPanel();
}

function wireRelatedClicks() {
  document.querySelectorAll(".related-item[data-zoom]").forEach(el => {
    el.addEventListener("click", () => {
      const pool = el.dataset.ztype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
      const ent = pool.find(x => x.id === el.dataset.zoom);
      if (ent) selectEntity(ent, el.dataset.ztype);
    });
  });
}

/* ════════════════════════════════════════════════════════
   UI WIRING
════════════════════════════════════════════════════════ */
function wireUI() {
  document.querySelectorAll(".mode-tab").forEach(t => t.addEventListener("click", () => switchMode(t.dataset.mode)));
  document.getElementById("btn-reset").addEventListener("click", resetAll);
  document.querySelectorAll(".etype-tab").forEach(t => {
    t.addEventListener("click", () => {
      STATE.etypeFilter = t.dataset.etype;
      document.querySelectorAll(".etype-tab").forEach(x => x.classList.toggle("active", x.dataset.etype === STATE.etypeFilter));
      clearCrossFilter(); applyEtypeFilter();
    });
  });
  document.getElementById("cross-filter-clear").addEventListener("click", () => { clearCrossFilter(); applyEtypeFilter(); });
  document.getElementById("btn-close-detail").addEventListener("click", closeDetail);

  /* Search */
  const input = document.getElementById("search-input");
  const clear = document.getElementById("search-clear");
  input.addEventListener("input", () => {
    const v = input.value.trim();
    clear.style.display = v ? "block" : "none";
    clearTimeout(STATE.searchTimer);
    if (!v) { resetAll(); return; }
    if (v.length < 2) return;
    STATE.searchTimer = setTimeout(() => doSearch(v), 300);
  });
  clear.addEventListener("click", () => { input.value = ""; clear.style.display = "none"; resetAll(); });

  /* Sport pills */
  const sports = ["All", "Basketball", "Tennis", "Golf", "Global Football", "Baseball", "American Football", "Running / T&F", "Hockey", "Cricket", "Rugby"];
  const sp = document.getElementById("sport-pills");
  sports.forEach(s => {
    const btn = document.createElement("button");
    btn.className = "pill" + (s === "All" ? " active" : "");
    btn.textContent = s; btn.dataset.val = s;
    btn.addEventListener("click", () => filterBySport(s));
    sp.appendChild(btn);
  });
}

function doSearch(term) {
  const t = term.toLowerCase();
  const athletes = STATE.allAthletes.filter(e => inc(e.props.name, t) || inc(e.props.sport, t));
  const events = STATE.allEvents.filter(e => inc(e.props.name, t) || inc(e.props.country, t) || inc(e.props.city, t) || inc(e.props.labels, t));
  const total = athletes.length + events.length;
  renderList(athletes, events, total ? `<b>${total}</b> results` : `No results`);
  clearHighlight();
}

function filterBySport(sport) {
  document.querySelectorAll("#sport-pills .pill").forEach(p => p.classList.toggle("active", p.dataset.val === sport));
  if (sport === "All") { resetAll(); return; }
  closeDetail();
  const sLow = sport.toLowerCase();
  const athletes = STATE.allAthletes.filter(e => (e.props.sport || "").toLowerCase().includes(sLow));
  const labelNames = CFG.SPORT_LABEL_MAP[sLow] || [sLow];
  const events = STATE.allEvents.filter(e => { const el = getEventLabels(e); return labelNames.some(l => el.has(l)); });
  renderList(athletes, events, `<b>${athletes.length + events.length}</b> in ${escH(sport)}`);
}

function inc(v, t) { return v && String(v).toLowerCase().includes(t); }

function switchMode(mode) {
  document.querySelectorAll(".mode-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
  document.querySelectorAll(".query-section").forEach(s => s.classList.toggle("active", s.id === `mode-${mode}`));
}

function resetAll() {
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear").style.display = "none";
  document.querySelectorAll(".pill").forEach(p => p.classList.toggle("active", p.dataset.val === "All"));
  STATE.etypeFilter = "events";
  document.querySelectorAll(".etype-tab").forEach(t => t.classList.toggle("active", t.dataset.etype === "events"));
  clearCrossFilter(); clearHighlight(); closeDetail();
  if (STATE.allEvents.length) renderList(STATE.allAthletes, STATE.allEvents, `<b>${STATE.allEvents.length}</b> events · <b>${STATE.allAthletes.length}</b> athletes`);
}

/* ════════════════════════════════════════════════════════
   RENDER LIST
════════════════════════════════════════════════════════ */
function renderList(athletes, events, countHtml) {
  STATE.lastAthletes = athletes; STATE.lastEvents = events; STATE.lastCountHtml = countHtml;
  applyEtypeFilter();
}

function applyEtypeFilter() {
  const tab = STATE.etypeFilter, cf = STATE.crossFilter;
  let items = tab === "athletes" ? (cf ? cf.athletes : STATE.lastAthletes) : (cf ? cf.events : STATE.lastEvents);

  document.querySelectorAll(".etype-tab").forEach(t => {
    if (t.dataset.etype === "athletes") t.textContent = `Athletes (${(cf ? cf.athletes : STATE.lastAthletes).length})`;
    if (t.dataset.etype === "events") t.textContent = `Events (${(cf ? cf.events : STATE.lastEvents).length})`;
  });

  const banner = document.getElementById("cross-filter-banner");
  if (cf) {
    document.getElementById("cross-filter-text").innerHTML = `Related to ${escH(cf.name)}`;
    banner.style.display = "flex";
  } else banner.style.display = "none";

  setCount(STATE.lastCountHtml);
  const MAX = 60;
  let html = "";

  if (tab === "athletes") {
    items.slice(0, MAX).forEach(e => {
      const p = e.props;
      html += entityCard(e.id, "Athlete", "athlete", escH(p.name || "?"), escH([p.sport, p.gender].filter(Boolean).join(" · ")));
    });
  } else {
    items.slice(0, MAX).forEach(e => {
      const p = e.props;
      const upcoming = parseEventDate(e) >= Date.now();
      const badge = upcoming ? `<span class="soon-badge">SOON</span>` : "";
      html += entityCard(e.id, "Event", "event", escH(p.name || "?") + badge, escH([p.country, p.city, formatEventDate(e)].filter(Boolean).join(" · ")));
    });
  }

  if (!html) html = `<div class="state-box"><span>No ${tab} found</span></div>`;
  showList(html);

  document.querySelectorAll(".entity-card").forEach(card => {
    card.addEventListener("click", () => {
      const pool = card.dataset.etype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
      const ent = pool.find(x => x.id === card.dataset.id);
      if (ent) selectEntity(ent, card.dataset.etype, false);
    });
  });
}

function entityCard(id, etype, cls, name, meta) {
  return `<div class="entity-card" data-id="${id}" data-etype="${etype}">
    <div class="entity-icon ${cls}">&#9899;</div>
    <div class="entity-info"><div class="entity-name">${name}</div><div class="entity-meta">${meta}</div></div>
    <span class="etype-badge ${cls}">${etype}</span>
  </div>`;
}

function clearCrossFilter() { STATE.crossFilter = null; document.getElementById("cross-filter-banner").style.display = "none"; }

/* ════════════════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════════════════ */
function parseEventDate(e) { const d = e.props.start_time || e.props.start_local_time || ""; return d ? new Date(String(d)).getTime() || 0 : 0; }
function formatEventDate(e) { const d = e.props.start_time || e.props.start_local_time || ""; if (!d) return "—"; const s = String(d); return s.length >= 10 ? s.slice(0, 10) : s; }
function showList(h) { document.getElementById("results-list").innerHTML = h; }
function setCount(h) { document.getElementById("results-count").innerHTML = h; }
function closeDetail() { document.getElementById("detail-panel").classList.remove("open"); if (STATE.view) STATE.view.padding = { right: 0 }; clearCrossFilter(); applyEtypeFilter(); clearHighlight(); }
function openDetailPanel() { document.getElementById("detail-panel").classList.add("open"); if (STATE.view) STATE.view.padding = { right: 380 }; }
function setBadge(t, c) { const b = document.getElementById("kg-badge"); b.textContent = t; b.className = "kg-badge" + (c ? ` ${c}` : ""); }
function dp(l, v) { return `<div><div class="dp-label">${l}</div><div class="dp-value" title="${escH(String(v))}">${escH(String(v))}</div></div>`; }
function escH(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
