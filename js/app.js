/**
 * Nike Event Tracker v2 – ArcGIS Knowledge Graph (Nike_v16)
 *
 * Graph model (no direct Athlete↔Event edge):
 *   Athlete -[RELATED_TO_TAG]→ Label ←[TAGGED_AS]- Event   (sport match)
 *   Athlete -[ENDORSED_BY]→ Brand
 *   Athlete -[PLAYS_FOR]→ Team -[COMPETES_IN]→ League
 *   Athlete -[ORIGINATES_FROM]→ Country
 *   Athlete -[BORN_IN]→ City
 *   Athlete -[ATTENDS]→ University
 *   Event   -[HELD_AT]→ Venue
 *   Event   -[LOCATED_IN]→ City / Region / Country
 *   Event   -[TAGGED_AS]→ Label  (with weight)
 *   Event   -[HAS_IMPACT]→ Impact
 *   Event   -[STARTS_ON / ENDS_ON]→ EventDate
 */

"use strict";

/* ════════════════════════════════════════════════════════
   CONFIGURATION
════════════════════════════════════════════════════════ */
const KG_SOURCES = {
  "Nike_v16": {
    label: "Nike v16",
    portal: "https://minint-k1bof4g.esri.com/portals",
    server: "https://minint-k1bof4g.esri.com/server",
    url: "https://minint-k1bof4g.esri.com/server/rest/services/Hosted/Nike_v16/KnowledgeGraphServer"
  },
  "Nike_v16_enhanced": {
    label: "Nike v16 Enhanced",
    portal: "https://minint-k1bof4g.esri.com/portals",
    server: "https://minint-k1bof4g.esri.com/server",
    url: "https://minint-k1bof4g.esri.com/server/rest/services/Hosted/Nike_v16_enhanced/KnowledgeGraphServer"
  }
};

const CFG = {
  PORTAL_URL : KG_SOURCES["Nike_v16"].portal,
  KG_SERVER  : KG_SOURCES["Nike_v16"].server,
  KG_URL     : KG_SOURCES["Nike_v16"].url,

  EVENT_LIMIT   : 100,
  ATHLETE_LIMIT : 0,      // 0 = all (~8700)
  VENUE_LIMIT   : 5000,

  /* Maps athlete.sport → event label names (lowercase) for matching */
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

/* ════════════════════════════════════════════════════════
   APP STATE
════════════════════════════════════════════════════════ */
const STATE = {
  kg          : null,
  kgService   : null,
  view        : null,
  layers      : {},
  allAthletes : [],
  allEvents   : [],
  allVenues   : [],
  layerVis    : { athletes: true, events: true, venues: true },
  searchTimer : null,
  etypeFilter : "events",
  lastAthletes: [],
  lastEvents  : [],
  lastCountHtml: "",
  crossFilter : null,
  incidents   : {},          // athleteName → [{title, severity, affectsAudiences, ...}]
  audienceMap : {}            // label → audience
};

/* ════════════════════════════════════════════════════════
   MAP SYMBOLS
════════════════════════════════════════════════════════ */
const SYM = {
  athlete    : { type:"simple-marker", style:"circle", color:[255,85,0,0.88],  size:11, outline:{color:[255,85,0,1],width:1.5} },
  athleteHL  : { type:"simple-marker", style:"circle", color:[255,85,0,1],     size:17, outline:{color:[255,255,255,1],width:2.5} },
  athleteDim : { type:"simple-marker", style:"circle", color:[255,85,0,0.14],  size:9,  outline:{color:[255,85,0,0.2],width:1} },
  event      : { type:"simple-marker", style:"circle", color:[0,184,255,0.82], size:9,  outline:{color:[0,184,255,1],width:1} },
  eventHL    : { type:"simple-marker", style:"circle", color:[0,184,255,1],    size:14, outline:{color:[255,255,255,1],width:2.5} },
  eventDim   : { type:"simple-marker", style:"circle", color:[0,184,255,0.12], size:7,  outline:{color:[0,184,255,0.18],width:1} },
  venue      : { type:"simple-marker", style:"circle", color:[100,100,100,0.4],size:5,  outline:{color:[120,120,120,0.5],width:0.5} }
};

/* ════════════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════════════ */
require([
  "esri/config",
  "esri/Map",
  "esri/views/MapView",
  "esri/layers/GraphicsLayer",
  "esri/Graphic",
  "esri/rest/knowledgeGraphService",
  "esri/identity/IdentityManager"
], boot);

/* ── Fetch interceptor: debug logging + portal path redirect ── */
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
      url = fixed;
    }
    return _fetch.call(this, input, init)
      .then(r  => r)
      .catch(e => { console.error("[fetch fail]", url, e.message); throw e; });
  };
})();

function boot(esriConfig, Map, MapView, GraphicsLayer, Graphic, kgService, IdentityManager) {

  esriConfig.portalUrl = CFG.PORTAL_URL;
  esriConfig.request.trustedServers.push("https://minint-k1bof4g.esri.com");
  STATE.kgService = kgService;

  /* ── Wire login ── */
  const loginBtn = document.getElementById("login-btn");
  const loginErr = document.getElementById("login-error");

  async function doLogin() {
    const user = document.getElementById("l-user").value.trim();
    const pass = document.getElementById("l-pass").value;
    if (!user || !pass) { loginErr.textContent = "Enter username and password."; return; }

    /* Apply selected KG source */
    const kgKey = document.getElementById("l-kg").value;
    const src = KG_SOURCES[kgKey];
    if (src) {
      CFG.PORTAL_URL = src.portal; CFG.KG_SERVER = src.server; CFG.KG_URL = src.url;
      esriConfig.portalUrl = CFG.PORTAL_URL;
      esriConfig.request.trustedServers.push(new URL(CFG.PORTAL_URL).origin);
      console.log("[kg] Selected:", kgKey, CFG.KG_URL);
    }

    loginBtn.disabled = true;
    loginBtn.loading = true;
    loginBtn.innerHTML = "Connecting...";
    loginErr.textContent = "";

    try {
      const tokenUrl = `${CFG.PORTAL_URL}/sharing/rest/generateToken`;
      const formBody = new URLSearchParams({
        username: user, password: pass,
        client: "referer", referer: window.location.origin,
        expiration: "120", f: "json"
      });

      let rawText;
      try {
        const resp = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody.toString()
        });
        rawText = await resp.text();
      } catch (e) {
        throw new Error("Cannot reach Portal. Check network access.");
      }

      if (rawText.trimStart().startsWith("<"))
        throw new Error("Portal returned HTML instead of JSON. Visit: " + CFG.PORTAL_URL + "/home/index.html");

      const tokenData = JSON.parse(rawText);
      const token = tokenData?.token;
      if (!token) throw new Error(tokenData?.error?.message || "No token. Check credentials.");

      const cred = { server: `${CFG.PORTAL_URL}/sharing/rest`, token, ssl: true, userId: user, expires: tokenData.expires };
      IdentityManager.registerToken(cred);
      IdentityManager.registerToken({ server: CFG.KG_SERVER, token, ssl: true, userId: user });
      const rootPortal = new URL(CFG.PORTAL_URL).origin;
      IdentityManager.registerToken({ server: `${rootPortal}/sharing/rest`, token, ssl: true, userId: user });

      document.getElementById("login-overlay").style.display = "none";
      document.getElementById("app-header").style.display = "";
      document.getElementById("app-body").style.display = "";
      launchApp(esriConfig, Map, MapView, GraphicsLayer, Graphic);

    } catch (err) {
      console.error("Login error:", err);
      loginErr.textContent = err.message || "Login failed.";
      loginBtn.disabled = false;
      loginBtn.loading = false;
      loginBtn.innerHTML = "Connect to Knowledge Graph";
    }
  }

  loginBtn.addEventListener("click", doLogin);
  document.addEventListener("keydown", e => {
    if (e.key === "Enter" && document.getElementById("login-overlay").style.display !== "none") doLogin();
  });

  /* ── Wire UI ── */
  document.querySelectorAll(".mode-tab").forEach(t => t.addEventListener("click", () => switchMode(t.dataset.mode)));
  document.querySelectorAll(".ltog").forEach(b => b.addEventListener("click", () => toggleLayer(b.dataset.layer)));
  document.getElementById("legend-toggle").addEventListener("click", () => document.getElementById("legend-body").classList.toggle("open"));
  document.getElementById("btn-reset").addEventListener("click", resetAll);
  document.querySelectorAll(".etype-tab").forEach(t => {
    t.addEventListener("click", () => {
      STATE.etypeFilter = t.dataset.etype;
      document.querySelectorAll(".etype-tab").forEach(x => x.classList.toggle("active", x.dataset.etype === STATE.etypeFilter));
      clearCrossFilter();
      applyEtypeFilter();
    });
  });
  document.getElementById("cross-filter-clear").addEventListener("click", () => { clearCrossFilter(); applyEtypeFilter(); });
  document.getElementById("btn-close-detail").addEventListener("click", closeDetail);
}

/* ════════════════════════════════════════════════════════
   LAUNCH APP
════════════════════════════════════════════════════════ */
async function launchApp(esriConfig, Map, MapView, GraphicsLayer, Graphic) {
  setBadge("Initializing map...");

  const venueLayer   = new GraphicsLayer({ title: "Venues",   listMode: "hide" });
  const eventLayer   = new GraphicsLayer({ title: "Events",   listMode: "hide" });
  const athleteLayer = new GraphicsLayer({ title: "Athletes", listMode: "hide" });
  STATE.layers = { athletes: athleteLayer, events: eventLayer, venues: venueLayer };

  const map = new Map({ basemap: "dark-gray-vector", layers: [venueLayer, eventLayer, athleteLayer] });
  const view = new MapView({
    container: "viewDiv", map,
    center: [20, 22], zoom: 2,
    popup: { dockEnabled: false, defaultPopupTemplateEnabled: false },
    ui: { components: ["zoom", "attribution"] }
  });
  STATE.view = view;

  view.on("click", async evt => {
    const hit = await view.hitTest(evt, { include: [athleteLayer, eventLayer] });
    if (!hit.results.length) { closeDetail(); clearHighlight(); return; }
    const a = hit.results[0].graphic.attributes;
    const pool = a.__etype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
    const ent = pool.find(x => x.id === a.__eid);
    if (ent) selectEntity(ent, a.__etype);
  });

  /* ── Connect to KG ── */
  setBadge("Connecting to Knowledge Graph...");
  try {
    try { await fetch(`${CFG.KG_SERVER}/rest/services?f=json`, { method: "GET" }); }
    catch (_) { throw new Error("Cannot reach ArcGIS Server. Check network access."); }

    STATE.kg = await STATE.kgService.fetchKnowledgeGraph(CFG.KG_URL);

    /* Log schema */
    const dm = STATE.kg.dataModel;
    console.log("[schema] Entities:", Object.keys(dm.entityTypes));
    console.log("[schema] Relationships:", Object.keys(dm.relationshipTypes));

    setBadge("Connected", "ok");
    await loadIncidents();
    buildFilters();
    wireSearch();
    await loadAllData(Graphic);
  } catch (err) {
    console.error("KG connect error:", err);
    setBadge("KG Error", "err");
    showList(`<div class="state-box"><span style="color:#f55">Cannot reach Knowledge Graph.<br><small>${escH(err.message)}</small></span></div>`);
  }
}

/* ════════════════════════════════════════════════════════
   DATA LOADING
════════════════════════════════════════════════════════ */
async function loadAllData(Graphic) {
  showList(`<div class="state-box"><div class="spinner"></div><span>Loading Knowledge Graph data...</span></div>`);
  setCount("<b>Loading...</b>");

  try {
    const t0 = performance.now();
    const [athletes, events, venues] = await Promise.all([
      streamQuery("MATCH (a:Athlete) RETURN a", {}, CFG.ATHLETE_LIMIT),
      streamQuery("MATCH (e:Event)   RETURN e", {}, CFG.EVENT_LIMIT),
      streamQuery("MATCH (v:Venue)   RETURN v", {}, CFG.VENUE_LIMIT)
    ]);
    console.log(`[perf] KG: ${(performance.now() - t0).toFixed(0)}ms | ${athletes.length} athletes, ${events.length} events, ${venues.length} venues`);

    if (events[0]) console.log("[debug] Event props:", Object.keys(events[0].props));
    if (athletes[0]) console.log("[debug] Athlete props:", Object.keys(athletes[0].props));

    STATE.allAthletes = athletes;
    STATE.allVenues   = venues;

    /* Sort events by start_time descending (most recent first) */
    events.sort((a, b) => {
      const da = parseEventDate(a);
      const db = parseEventDate(b);
      return db - da;
    });
    STATE.allEvents = events;

    buildGraphics(Graphic);

    document.getElementById("s-athletes").textContent = athletes.length;
    document.getElementById("s-events").textContent   = events.length;
    document.getElementById("s-venues").textContent    = venues.length;
    document.getElementById("s-upcoming").textContent   = events.filter(e => parseEventDate(e) >= Date.now()).length;

    renderList(athletes, events,
      `<b>${events.length}</b> events · <b>${athletes.length}</b> athletes`);

  } catch (err) {
    console.error("Load error:", err);
    showList(`<div class="state-box"><span style="color:#f55">Error: ${escH(err.message)}</span></div>`);
  }
}

function parseEventDate(e) {
  const d = e.props.start_time || e.props.start_local_time || "";
  if (!d) return 0;
  return new Date(String(d)).getTime() || 0;
}

function formatEventDate(e) {
  const d = e.props.start_time || e.props.start_local_time || e.props.start_date || "";
  if (!d) return "—";
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/* ════════════════════════════════════════════════════════
   KG STREAMING QUERY (single-entity returns only)
════════════════════════════════════════════════════════ */
async function streamQuery(cypher, params = {}, maxRows = 0) {
  const result = await STATE.kgService.executeQueryStreaming(STATE.kg, {
    openCypherQuery: cypher,
    bindParameters: params
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
      if (ent && ent.properties !== undefined) {
        rows.push(parseEntity(ent));
      }
    }
  }
  return rows;
}

function parseEntity(ent) {
  return {
    id      : ent.id,
    typeName: ent.typeName,
    props   : ent.properties,
    geom    : extractPoint(ent.properties.shape)
  };
}

function extractPoint(shape) {
  if (!shape) return null;
  try {
    const x = shape.x ?? shape.coordinates?.[0];
    const y = shape.y ?? shape.coordinates?.[1];
    if (x == null || y == null || (x === 0 && y === 0)) return null;
    return { x: parseFloat(x), y: parseFloat(y), spatialReference: { wkid: 4326 } };
  } catch { return null; }
}

/* ════════════════════════════════════════════════════════
   SMART ATHLETE ↔ EVENT MATCHING

   No direct relationship exists. We score athletes against
   an event using MULTIPLE graph paths queried in parallel:

   Path                                              Points
   ─────────────────────────────────────────────────────────
   Sport label match (Athlete.sport ↔ Event.labels)     5
   Born in event city    (BORN_IN → City)                4
   Team in event city    (PLAYS_FOR → Team)              4
   University in city    (ATTENDS → University)          3
   From event country    (ORIGINATES_FROM → Country)     3
   Team in event country (PLAYS_FOR → Team)              2
   Univ in event country (ATTENDS → University)          1
   ─────────────────────────────────────────────────────────
   Top 10 by total score are shown.
════════════════════════════════════════════════════════ */

const SCORE = {
  SPORT_LABEL     : 5,
  BORN_IN_CITY    : 4,
  TEAM_IN_CITY    : 4,
  UNI_IN_CITY     : 3,
  FROM_COUNTRY    : 3,
  TEAM_IN_COUNTRY : 2,
  UNI_IN_COUNTRY  : 1
};

/** Parse event labels → lowercase Set */
function getEventLabels(event) {
  const raw = event.props.labels || event.props.phq_labels || "";
  const str = String(raw);
  const labels = new Set();
  try {
    const arr = JSON.parse(str.replace(/'/g, '"'));
    if (Array.isArray(arr)) {
      arr.forEach(item => {
        const lbl = (typeof item === "string" ? item : item?.label || "").toLowerCase().trim();
        if (lbl) labels.add(lbl);
      });
      return labels;
    }
  } catch {}
  str.split(/[,|]/).forEach(s => {
    const lbl = s.replace(/[\[\]'"]/g, "").toLowerCase().trim();
    if (lbl) labels.add(lbl);
  });
  return labels;
}

/** Get label names an athlete's sport maps to */
function getAthleteLabelSet(athlete) {
  const sport = (athlete.props.sport || "").toLowerCase().trim();
  const mapped = CFG.SPORT_LABEL_MAP[sport] || [];
  const result = new Set(mapped);
  result.add(sport);
  return result;
}

/** Safe streaming query that never throws — returns [] on error */
async function safeStreamQuery(cypher, params = {}, maxRows = 200) {
  try { return await streamQuery(cypher, params, maxRows); }
  catch (err) { console.warn("[safeQuery] failed:", cypher.slice(0, 60), err.message); return []; }
}

/**
 * Score and rank athletes for an event.
 * Runs parallel KG queries for geographic connections + client-side sport matching.
 * Returns top 10 as [{ entity, score, reasons: [{text, points}] }]
 */
/* ── Reputation overlay ───────────────────────────── */
async function loadIncidents() {
  try {
    const resp = await fetch("data/incidents.json", { cache: "no-store" });
    const json = await resp.json();
    STATE.incidents   = json.athletes || {};
    STATE.audienceMap = json._audienceMap || {};
    console.log(`[reputation] Loaded ${Object.keys(STATE.incidents).length} athletes with incidents`);
  } catch (err) {
    console.warn("[reputation] Could not load incidents.json:", err.message);
    STATE.incidents = {};
    STATE.audienceMap = {};
  }
}

/** Infer the audience(s) of an event from its labels */
function getEventAudiences(event) {
  const labels = getEventLabels(event);
  const audiences = new Set();
  for (const lbl of labels) {
    const aud = STATE.audienceMap[lbl];
    if (aud) audiences.add(aud);
  }
  return audiences;
}

/** Get incidents that affect any of the given audiences */
function getRelevantIncidents(athleteName, eventAudiences) {
  const list = STATE.incidents[athleteName] || [];
  if (eventAudiences.size === 0) return [];
  return list.filter(inc =>
    (inc.affectsAudiences || []).some(a => eventAudiences.has(a))
  );
}

async function scoreAthletesForEvent(event) {
  const p = event.props;
  const eventLabels    = getEventLabels(event);
  const eventCity      = (p.city || p.locality || "").trim();
  const eventCountry   = (p.country || "").trim();
  const eventAudiences = getEventAudiences(event);

  /* Accumulator: athleteId → { entity, score, reasons } */
  const board = new Map();

  function addScore(athlete, points, reason, negative = false) {
    const id = athlete.id;
    if (!board.has(id)) {
      board.set(id, { entity: athlete, score: 0, reasons: [] });
    }
    const entry = board.get(id);
    entry.score += points;
    entry.reasons.push({ text: reason, points, negative });
  }

  /* ── 1. Client-side: sport label matching (instant) ── */
  STATE.allAthletes.forEach(a => {
    const athLabels = getAthleteLabelSet(a);
    const shared = [...athLabels].filter(l => eventLabels.has(l));
    if (shared.length > 0) {
      addScore(a, SCORE.SPORT_LABEL, `Sport: ${a.props.sport}`);
    }
  });

  /* ── 2. Parallel KG queries for geographic connections ── */
  const queries = [];

  if (eventCity) {
    queries.push(
      safeStreamQuery(
        `MATCH (a:Athlete)-[:BORN_IN]->(c:City) WHERE c.name = $city RETURN a`,
        { city: eventCity }
      ).then(athletes => {
        athletes.forEach(a => addScore(a, SCORE.BORN_IN_CITY, `Born in ${eventCity}`));
      })
    );
    queries.push(
      safeStreamQuery(
        `MATCH (a:Athlete)-[:PLAYS_FOR]->(t:Team) WHERE t.city = $city RETURN a`,
        { city: eventCity }
      ).then(athletes => {
        athletes.forEach(a => addScore(a, SCORE.TEAM_IN_CITY, `Team in ${eventCity}`));
      })
    );
    queries.push(
      safeStreamQuery(
        `MATCH (a:Athlete)-[:ATTENDS]->(u:University) WHERE u.city = $city RETURN a`,
        { city: eventCity }
      ).then(athletes => {
        athletes.forEach(a => addScore(a, SCORE.UNI_IN_CITY, `Studied in ${eventCity}`));
      })
    );
  }

  if (eventCountry) {
    queries.push(
      safeStreamQuery(
        `MATCH (a:Athlete)-[:ORIGINATES_FROM]->(c:Country) WHERE c.name = $country RETURN a`,
        { country: eventCountry }
      ).then(athletes => {
        athletes.forEach(a => addScore(a, SCORE.FROM_COUNTRY, `From ${eventCountry}`));
      })
    );
    queries.push(
      safeStreamQuery(
        `MATCH (a:Athlete)-[:PLAYS_FOR]->(t:Team) WHERE t.country = $country RETURN a`,
        { country: eventCountry }
      ).then(athletes => {
        athletes.forEach(a => addScore(a, SCORE.TEAM_IN_COUNTRY, `Team in ${eventCountry}`));
      })
    );
    queries.push(
      safeStreamQuery(
        `MATCH (a:Athlete)-[:ATTENDS]->(u:University) WHERE u.country = $country RETURN a`,
        { country: eventCountry }
      ).then(athletes => {
        athletes.forEach(a => addScore(a, SCORE.UNI_IN_COUNTRY, `Studied in ${eventCountry}`));
      })
    );
  }

  await Promise.all(queries);

  /* ── 3. Reputation penalty (audience-aware) ── */
  if (eventAudiences.size > 0) {
    for (const entry of board.values()) {
      const name = entry.entity.props.name;
      const incidents = getRelevantIncidents(name, eventAudiences);
      for (const inc of incidents) {
        const penalty = -(inc.severity || 5);
        addScore(entry.entity, penalty, `${inc.title}`, true);
      }
    }
  }

  /* Sort by score descending, return top 10 */
  const ranked = [...board.values()]
    .sort((a, b) => b.score - a.score || a.entity.props.name?.localeCompare(b.entity.props.name))
    .slice(0, 10);

  console.log(`[match] ${board.size} athletes scored, top 10:`,
    ranked.map(r => `${r.entity.props.name} (${r.score}pts)`));

  return ranked;
}

/** Find events related to an athlete (client-side, by sport labels) */
function findRelatedEvents(athlete) {
  const athLabels = getAthleteLabelSet(athlete);
  return STATE.allEvents
    .filter(e => {
      const el = getEventLabels(e);
      return [...athLabels].some(l => el.has(l));
    })
    .map(e => ({ entity: e, reason: `Sport: ${athlete.props.sport}` }));
}

/* ════════════════════════════════════════════════════════
   MAP GRAPHICS
════════════════════════════════════════════════════════ */
let _Graphic = null;

function buildGraphics(Graphic) {
  if (Graphic) _Graphic = Graphic;
  if (!_Graphic) return;

  STATE.layers.athletes.removeAll();
  STATE.layers.events.removeAll();
  STATE.layers.venues.removeAll();

  STATE.layers.athletes.addMany(
    STATE.allAthletes.filter(e => e.geom).map(e => makeGraphic(e, "Athlete", SYM.athlete))
  );
  STATE.layers.events.addMany(
    STATE.allEvents.filter(e => e.geom).map(e => makeGraphic(e, "Event", SYM.event))
  );
  STATE.layers.venues.addMany(
    STATE.allVenues.filter(e => e.geom).map(e => makeGraphic(e, "Venue", SYM.venue))
  );
}

function makeGraphic(entity, etype, sym) {
  return new _Graphic({
    geometry: { type: "point", ...entity.geom },
    symbol: sym,
    attributes: { __etype: etype, __eid: entity.id }
  });
}

/* ── Highlight ── */
function highlightEntities(athIds, evIds, zoom = true) {
  const athSet = new Set(athIds);
  const evSet  = new Set(evIds);
  const pts = [];

  STATE.layers.athletes.graphics.forEach(g => {
    const match = athSet.has(g.attributes.__eid);
    g.symbol = match ? SYM.athleteHL : (athSet.size > 0 ? SYM.athleteDim : SYM.athlete);
    if (match && g.geometry) pts.push(g.geometry);
  });
  STATE.layers.events.graphics.forEach(g => {
    const match = evSet.has(g.attributes.__eid);
    g.symbol = match ? SYM.eventHL : (evSet.size > 0 ? SYM.eventDim : SYM.event);
    if (match && g.geometry) pts.push(g.geometry);
  });

  if (zoom && pts.length > 0) zoomToPoints(pts);
}

function clearHighlight() {
  STATE.layers.athletes.graphics.forEach(g => g.symbol = SYM.athlete);
  STATE.layers.events.graphics.forEach(g   => g.symbol = SYM.event);
}

function zoomToPoints(pts) {
  if (!pts.length || !STATE.view) return;
  if (pts.length === 1) {
    STATE.view.goTo({ center: [pts[0].x, pts[0].y], zoom: 7 }, { duration: 600 }).catch(() => {});
    return;
  }
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  STATE.view.goTo({
    target: {
      type: "extent",
      xmin: Math.min(...xs), ymin: Math.min(...ys),
      xmax: Math.max(...xs), ymax: Math.max(...ys),
      spatialReference: { wkid: 4326 }
    }
  }, { duration: 700 }).catch(() => {});
}

function toggleLayer(name) {
  STATE.layerVis[name] = !STATE.layerVis[name];
  document.getElementById(`ltog-${name}`).classList.toggle("off", !STATE.layerVis[name]);
  if (STATE.layers[name]) STATE.layers[name].visible = STATE.layerVis[name];
}

/* ════════════════════════════════════════════════════════
   SEARCH
════════════════════════════════════════════════════════ */
function wireSearch() {
  const input = document.getElementById("search-input");
  const clear = document.getElementById("search-clear");

  input.addEventListener("input", () => {
    const v = input.value.trim();
    clear.style.display = v ? "block" : "none";
    clearTimeout(STATE.searchTimer);
    if (!v)           { resetAll(); return; }
    if (v.length < 2) return;
    STATE.searchTimer = setTimeout(() => doSearch(v), 300);
  });

  document.getElementById("search-clear").addEventListener("click", () => {
    input.value = "";
    clear.style.display = "none";
    resetAll();
  });
}

function doSearch(term) {
  const t = term.toLowerCase();

  const athletes = STATE.allAthletes.filter(e =>
    inc(e.props.name, t) || inc(e.props.sport, t) || inc(e.props.gender, t)
  );
  const events = STATE.allEvents.filter(e =>
    inc(e.props.name, t) || inc(e.props.country, t) || inc(e.props.city, t) ||
    inc(e.props.labels, t) || inc(e.props.formatted_address, t)
  );

  const total = athletes.length + events.length;
  renderList(athletes, events,
    total ? `<b>${total}</b> results for "<em>${escH(term)}</em>"` : `No results for "${escH(term)}"`);

  if (total > 0) highlightEntities(athletes.map(a => a.id), events.map(e => e.id));
  else clearHighlight();
}

function inc(val, term) { return val && String(val).toLowerCase().includes(term); }

/* ════════════════════════════════════════════════════════
   FILTERS (Sport & Country)
════════════════════════════════════════════════════════ */
function buildFilters() {
  /* Sport pills — from actual athlete sports in v16 */
  const sports = ["All", "Basketball", "Tennis", "Golf", "Global Football", "Baseball",
    "American Football", "Running / T&F", "Hockey", "Cricket", "Rugby", "Softball",
    "Indoor Volleyball", "Australian Rules Football", "NRL"];
  const sp = document.getElementById("sport-pills");
  sports.forEach(sport => {
    const btn = document.createElement("button");
    btn.className = "pill" + (sport === "All" ? " active" : "");
    btn.textContent = sport;
    btn.dataset.val = sport;
    btn.addEventListener("click", () => filterBySport(sport));
    sp.appendChild(btn);
  });

  /* Country pills — common event countries */
  const countries = [
    { code: "All", name: "All" },
    { code: "United States", name: "USA" },
    { code: "Deutschland", name: "Germany" },
    { code: "France", name: "France" },
    { code: "United Kingdom", name: "UK" },
    { code: "Canada", name: "Canada" },
    { code: "Australia", name: "Australia" },
    { code: "Japan", name: "Japan" },
    { code: "Brasil", name: "Brazil" },
    { code: "Espana", name: "Spain" },
    { code: "Italia", name: "Italy" }
  ];
  const cp = document.getElementById("country-pills");
  countries.forEach(({ code, name }) => {
    const btn = document.createElement("button");
    btn.className = "pill" + (code === "All" ? " active" : "");
    btn.textContent = name;
    btn.dataset.val = code;
    btn.addEventListener("click", () => filterByCountry(code));
    cp.appendChild(btn);
  });
}

function filterBySport(sport) {
  setPillActive("sport-pills", sport);
  if (sport === "All") { resetAll(); return; }
  closeDetail();

  const sLow = sport.toLowerCase();
  const athletes = STATE.allAthletes.filter(e =>
    (e.props.sport || "").toLowerCase().includes(sLow)
  );

  /* Match events whose labels include this sport's label names */
  const labelNames = CFG.SPORT_LABEL_MAP[sLow] || [sLow];
  const events = STATE.allEvents.filter(e => {
    const el = getEventLabels(e);
    return labelNames.some(l => el.has(l));
  });

  renderList(athletes, events, `<b>${athletes.length + events.length}</b> in ${escH(sport)}`);
  highlightEntities(athletes.map(a => a.id), events.map(e => e.id));
}

function filterByCountry(code) {
  setPillActive("country-pills", code);
  if (code === "All") { resetAll(); return; }
  closeDetail();

  const events = STATE.allEvents.filter(e => (e.props.country || "") === code);
  /* Athletes: no direct country field, skip for now */
  const athletes = [];

  renderList(athletes, events, `<b>${events.length}</b> events in ${escH(code)}`);
  highlightEntities([], events.map(e => e.id));
}

function setPillActive(id, val) {
  document.querySelectorAll(`#${id} .pill`).forEach(p => p.classList.toggle("active", p.dataset.val === val));
}

/* ════════════════════════════════════════════════════════
   MODE SWITCHING & RESET
════════════════════════════════════════════════════════ */
function switchMode(mode) {
  document.querySelectorAll(".mode-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
  document.querySelectorAll(".query-section").forEach(s => s.classList.toggle("active", s.id === `mode-${mode}`));
  if (mode !== "search") closeDetail();
}

function resetAll() {
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear").style.display = "none";
  document.querySelectorAll(".pill").forEach(p => p.classList.toggle("active", p.dataset.val === "All"));
  STATE.etypeFilter = "events";
  document.querySelectorAll(".etype-tab").forEach(t => t.classList.toggle("active", t.dataset.etype === "events"));
  clearCrossFilter(); clearHighlight(); closeDetail();
  if (STATE.allEvents.length) {
    renderList(STATE.allAthletes, STATE.allEvents,
      `<b>${STATE.allEvents.length}</b> events · <b>${STATE.allAthletes.length}</b> athletes`);
  }
}

/* ════════════════════════════════════════════════════════
   ENTITY DETAIL PANEL
════════════════════════════════════════════════════════ */
async function selectEntity(entity, etype, scrollCard = true) {
  document.querySelectorAll(".entity-card").forEach(c => c.classList.remove("active"));
  const card = document.querySelector(`.entity-card[data-id="${entity.id}"]`);
  if (card) {
    card.classList.add("active");
    if (scrollCard) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  if (etype === "Athlete") await showAthleteDetail(entity);
  else await showEventDetail(entity);
}

/* ── Event detail ── */
async function showEventDetail(event) {
  const p = event.props;

  /* Show panel immediately with loading state */
  const detEtype = document.getElementById("detail-etype");
  detEtype.textContent = "Event";
  detEtype.className = "detail-etype event";
  document.getElementById("detail-name").textContent = p.name || "—";

  const date  = formatEventDate(event);
  const att   = p.phq_attendance ? Number(p.phq_attendance).toLocaleString() : "—";
  const spend = p.predictaed_event_spend
    ? "$" + Number(p.predictaed_event_spend).toLocaleString(undefined, { maximumFractionDigits: 0 })
    : "—";

  const labels = [...getEventLabels(event)];
  const labelHTML = labels.map(l => `<span class="reason-tag">${escH(l)}</span>`).join(" ");

  /* Render event info + "Scoring athletes..." placeholder */
  document.getElementById("detail-body").innerHTML = `
    <div class="detail-grid">
      ${dp("Date",        date)}
      ${dp("Country",     p.country || "—")}
      ${dp("City",        p.city || p.locality || "—")}
      ${dp("Address",     p.formatted_address || "—")}
      ${dp("Attendance",  att)}
      ${dp("Est. Spend",  spend)}
      ${dp("Rank",        p.rank || "—")}
      ${dp("Local Rank",  p.local_rank || "—")}
      ${dp("Scope",       p.scope || "—")}
      ${dp("Timezone",    p.timezone || "—")}
    </div>
    ${labels.length > 0
      ? `<p class="related-label" style="margin-top:12px">Labels</p>
         <div style="margin:6px 0 12px;line-height:1.8">${labelHTML}</div>`
      : ""}
    <div class="detail-relationship-hint">
      Scoring athletes via 8 paths: sport labels, birth city, team city,
      university city, country of origin, team country, university country,
      and <span style="color:#ff5a5a">reputation penalty</span> for audience-incompatible incidents.
    </div>
    <div id="athlete-results"><div class="state-box"><div class="spinner"></div><span>Querying graph relationships...</span></div></div>`;
  openDetailPanel();

  /* Run the smart scoring (parallel KG queries + client-side) */
  const ranked = await scoreAthletesForEvent(event);
  const relAthletes = ranked.map(r => r.entity);

  highlightEntities(relAthletes.map(a => a.id), [event.id], false);
  if (relAthletes.length > 0) {
    STATE.crossFilter = { name: p.name || "Event", athletes: relAthletes, events: [] };
  }

  /* Build athlete cards with score breakdown */
  const relHTML = ranked.map((r, i) => {
    const ap = r.entity.props;
    const scoreBar = `<span class="score-badge${r.score < 0 ? " negative" : ""}">${r.score} pts</span>`;
    const tags = r.reasons
      .sort((a, b) => b.points - a.points)
      .map(re => `<span class="reason-tag${re.negative ? " negative" : ""}" title="${re.points > 0 ? "+" : ""}${re.points} pts">${escH(re.text)}</span>`)
      .join(" ");
    return `<div class="related-item" data-zoom="${r.entity.id}" data-ztype="Athlete">
      <span class="rank-num">#${i + 1}</span>
      <span class="rdot orange"></span>
      <span class="rname">${escH(ap.name || "Athlete")}</span>
      ${scoreBar}
      <div class="reason-row">${tags}</div>
    </div>`;
  }).join("");

  document.getElementById("athlete-results").innerHTML = ranked.length > 0
    ? `<p class="related-label">Top ${ranked.length} Recommended Athletes</p>
       <div class="related-list">${relHTML}</div>`
    : `<p class="related-label" style="color:#555">No athletes matched for this event</p>`;

  wireRelatedClicks();
}

/* ── Athlete detail ── */
async function showAthleteDetail(athlete) {
  const p = athlete.props;

  /* Find events with matching sport labels */
  const related = findRelatedEvents(athlete);
  const relEvents = related.map(r => r.entity);

  highlightEntities([athlete.id], relEvents.map(e => e.id), false);

  if (relEvents.length > 0) {
    STATE.crossFilter = { name: p.name || "Athlete", athletes: [], events: relEvents };
    STATE.etypeFilter = "events";
    document.querySelectorAll(".etype-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.etype === "events")
    );
    applyEtypeFilter();
  }

  const detEtype = document.getElementById("detail-etype");
  detEtype.textContent = "Athlete";
  detEtype.className = "detail-etype athlete";
  document.getElementById("detail-name").textContent = p.name || "—";

  /* Athlete labels */
  const athLabels = [...getAthleteLabelSet(athlete)];
  const labelHTML = athLabels.map(l =>
    `<span class="reason-tag">${escH(l)}</span>`
  ).join(" ");

  const relHTML = related.slice(0, 10).map(r => {
    const ep = r.entity.props;
    return `<div class="related-item" data-zoom="${r.entity.id}" data-ztype="Event">
      <span class="rdot blue"></span>
      <span class="rname">${escH(ep.name || "Event")}</span>
      <span class="rmeta">${escH(ep.country || "")} ${formatEventDate(r.entity)}</span>
    </div>`;
  }).join("");

  document.getElementById("detail-body").innerHTML = `
    <div class="detail-grid">
      ${dp("Sport",    p.sport  || "—")}
      ${dp("Gender",   p.gender || "—")}
      ${dp("Type",     p.type   || "—")}
      ${dp("ID",       p.athlete_id || "—")}
    </div>
    ${athLabels.length > 0
      ? `<p class="related-label" style="margin-top:12px">Sport Labels</p>
         <div style="margin:6px 0 12px;line-height:1.8">${labelHTML}</div>`
      : ""}
    <div class="detail-relationship-hint">Events matched via shared sport labels</div>
    ${relEvents.length > 0
      ? `<p class="related-label">${relEvents.length} Related Event(s) (loaded set)</p>
         <div class="related-list">${relHTML}</div>`
      : `<p class="related-label" style="color:#555">No matching events in loaded set</p>`}`;

  wireRelatedClicks();
  openDetailPanel();
}

/* ── Wire related-item clicks ── */
function wireRelatedClicks() {
  document.querySelectorAll(".related-item[data-zoom]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.zoom;
      const etype = el.dataset.ztype;
      const pool = etype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
      const ent = pool.find(x => x.id === id);
      if (ent) selectEntity(ent, etype);
    });
  });
}

/* ════════════════════════════════════════════════════════
   RENDER RESULTS LIST
════════════════════════════════════════════════════════ */
function renderList(athletes, events, countHtml) {
  STATE.lastAthletes  = athletes;
  STATE.lastEvents    = events;
  STATE.lastCountHtml = countHtml;
  applyEtypeFilter();
}

function applyEtypeFilter() {
  const tab = STATE.etypeFilter;
  const cf  = STATE.crossFilter;
  const banner = document.getElementById("cross-filter-banner");

  let items = tab === "athletes"
    ? (cf ? cf.athletes : STATE.lastAthletes)
    : (cf ? cf.events : STATE.lastEvents);

  document.querySelectorAll(".etype-tab").forEach(t => {
    if (t.dataset.etype === "athletes") {
      t.textContent = `Athletes (${(cf ? cf.athletes : STATE.lastAthletes).length})`;
    }
    if (t.dataset.etype === "events") {
      t.textContent = `Events (${(cf ? cf.events : STATE.lastEvents).length})`;
    }
  });

  if (cf) {
    const label = tab === "events"
      ? `Events related to ${escH(cf.name)}`
      : `Athletes related to ${escH(cf.name)}`;
    document.getElementById("cross-filter-text").innerHTML = label;
    banner.style.display = "flex";
  } else {
    banner.style.display = "none";
  }

  setCount(STATE.lastCountHtml);

  const MAX = 80;
  let html = "";

  if (tab === "athletes") {
    items.slice(0, MAX).forEach(e => {
      const p = e.props;
      const name = escH(p.name || "Unknown Athlete");
      const meta = [p.sport, p.gender].filter(Boolean).join(" · ");
      html += entityCard(e.id, "Athlete", "athlete", name, escH(meta));
    });
  } else {
    items.slice(0, MAX).forEach(e => {
      const p = e.props;
      const title = escH(p.name || "Unknown Event");
      const date = formatEventDate(e);
      const meta = [p.country, p.city || p.locality, date].filter(Boolean).join(" · ");
      const upcoming = parseEventDate(e) >= Date.now();
      const badge = upcoming ? `<span class="soon-badge">SOON</span>` : "";
      html += entityCard(e.id, "Event", "event", title + badge, escH(meta));
    });
  }

  if (!html) html = `<div class="state-box"><span>No ${tab} found</span></div>`;
  showList(html);

  document.querySelectorAll(".entity-card").forEach(card => {
    card.addEventListener("click", () => {
      const eid   = card.dataset.id;
      const etype = card.dataset.etype;
      const pool  = etype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
      const ent   = pool.find(x => x.id === eid);
      if (ent) selectEntity(ent, etype, false);
    });
  });
}

function clearCrossFilter() {
  STATE.crossFilter = null;
  document.getElementById("cross-filter-banner").style.display = "none";
}

function entityCard(id, etype, cls, name, meta) {
  const icon = etype === "Athlete" ? "&#9899;" : "&#9898;";
  return `<div class="entity-card" data-id="${id}" data-etype="${etype}">
    <div class="entity-icon ${cls}">${icon}</div>
    <div class="entity-info">
      <div class="entity-name">${name}</div>
      <div class="entity-meta">${meta}</div>
    </div>
    <span class="etype-badge ${cls}">${etype}</span>
  </div>`;
}

/* ════════════════════════════════════════════════════════
   UI UTILITIES
════════════════════════════════════════════════════════ */
function showList(html)  { document.getElementById("results-list").innerHTML = html; }
function setCount(html)  { document.getElementById("results-count").innerHTML = html; }
function closeDetail() {
  document.getElementById("detail-panel").classList.remove("open");
  if (STATE.view) STATE.view.padding = { right: 0 };
  clearCrossFilter(); applyEtypeFilter(); clearHighlight();
}
function openDetailPanel() {
  document.getElementById("detail-panel").classList.add("open");
  if (STATE.view) STATE.view.padding = { right: 380 };
}

function setBadge(text, cls) {
  const b = document.getElementById("kg-badge");
  b.textContent = text;
  b.className = "kg-badge" + (cls ? ` ${cls}` : "");
}

function dp(label, value) {
  return `<div>
    <div class="dp-label">${label}</div>
    <div class="dp-value" title="${escH(String(value))}">${escH(String(value))}</div>
  </div>`;
}

function escH(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
