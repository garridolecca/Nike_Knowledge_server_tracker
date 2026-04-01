/**
 * Nike Event Tracker – ArcGIS Knowledge Graph App
 * Uses AMD (require) from the ArcGIS Maps SDK CDN.
 *
 * Auth flow:
 *  1. User submits login form
 *  2. esri/request calls Portal generateToken (handles CORS internally)
 *  3. Token registered with IdentityManager for both Portal + KG Server
 *  4. KG connection opened, data streamed, map rendered
 */

"use strict";

/* ════════════════════════════════════════════════════════
   CONFIGURATION  (edit these values if endpoints change)
════════════════════════════════════════════════════════ */
const CFG = {
  PORTAL_URL  : "https://tate.esri.com/portal",
  KG_SERVER   : "https://tate.esri.com/server",
  KG_URL      : "https://tate.esri.com/server/rest/services/Hosted/Nike_v16/KnowledgeGraphServer",

  SPORTS: [
    "Basketball","Tennis","Soccer","Athletics","Swimming",
    "Golf","Skateboarding","Gymnastics","Breaking","Boxing",
    "Cycling","Triathlon","Paralympic"
  ],

  COUNTRIES: {
    "US":"USA","GB":"UK","AU":"Australia","JP":"Japan","FR":"France",
    "DE":"Germany","KE":"Kenya","BR":"Brazil","ES":"Spain","NL":"Netherlands",
    "BE":"Belgium","IT":"Italy","JM":"Jamaica","CH":"Switzerland",
    "NO":"Norway","SE":"Sweden","PL":"Poland","CN":"China",
    "KR":"S. Korea","CA":"Canada","ZA":"S. Africa","ET":"Ethiopia",
    "CO":"Colombia","AR":"Argentina","MX":"Mexico"
  },

  // Nationality string → ISO 2-letter code (for country filter)
  NAT_MAP: {
    "American":"US","Australian":"AU","British":"GB","Kenyan":"KE",
    "Japanese":"JP","French":"FR","Spanish":"ES","Brazilian":"BR",
    "Dutch":"NL","Belgian":"BE","German":"DE","Italian":"IT",
    "Jamaican":"JM","Swiss":"CH","Norwegian":"NO","Swedish":"SE",
    "Polish":"PL","Chinese":"CN","South Korean":"KR","Canadian":"CA",
    "South African":"ZA","Ethiopian":"ET","Colombian":"CO",
    "Argentinian":"AR","Mexican":"MX","Monegasque":"MC","Ugandan":"UG"
  }
};

/* ════════════════════════════════════════════════════════
   APP STATE
════════════════════════════════════════════════════════ */
const STATE = {
  kg          : null,   // KnowledgeGraph object
  kgService   : null,   // knowledgeGraphService module
  view        : null,   // MapView
  layers      : {},     // { athletes, events, venues }
  allAthletes : [],
  allEvents   : [],
  allVenues   : [],
  layerVis    : { athletes: true, events: true, venues: true },
  searchTimer : null,
  activeCardId: null,
  etypeFilter : "events",    // "athletes" | "events"
  lastAthletes: [],          // base sets from search/sport/country
  lastEvents  : [],
  lastCountHtml: "",
  crossFilter : null         // null or { name, athletes: [], events: [] }
};

/* ════════════════════════════════════════════════════════
   MAP SYMBOLS
════════════════════════════════════════════════════════ */
const SYM = {
  athlete     : { type:"simple-marker", style:"circle", color:[255,85,0,0.88],  size:11, outline:{color:[255,85,0,1],width:1.5} },
  athleteHL   : { type:"simple-marker", style:"circle", color:[255,85,0,1],     size:17, outline:{color:[255,255,255,1],width:2.5} },
  athleteDim  : { type:"simple-marker", style:"circle", color:[255,85,0,0.14],  size:9,  outline:{color:[255,85,0,0.2],width:1} },
  event       : { type:"simple-marker", style:"circle", color:[0,184,255,0.82], size:9,  outline:{color:[0,184,255,1],width:1} },
  eventHL     : { type:"simple-marker", style:"circle", color:[0,184,255,1],    size:14, outline:{color:[255,255,255,1],width:2.5} },
  eventDim    : { type:"simple-marker", style:"circle", color:[0,184,255,0.12], size:7,  outline:{color:[0,184,255,0.18],width:1} },
  venue       : { type:"simple-marker", style:"circle", color:[100,100,100,0.4],size:5,  outline:{color:[120,120,120,0.5],width:0.5} }
};

/* ════════════════════════════════════════════════════════
   BOOT  – AMD require loads all JSAPI modules first
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

/* ── DEBUG: intercept every fetch so the console shows which URL fails ── */
(function () {
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = (typeof input === "string") ? input : (input.url || String(input));
    return _fetch.call(this, input, init)
      .then(r  => { console.log(`[fetch ✓ ${r.status}]`, url); return r; })
      .catch(e => { console.error("[fetch ✗]", url, e.message);  throw e; });
  };
})();

function boot(esriConfig, Map, MapView,
              GraphicsLayer, Graphic, kgService, IdentityManager) {

  /* ── Trust Enterprise servers ─────────────────────── */
  esriConfig.portalUrl = CFG.PORTAL_URL;
  esriConfig.request.trustedServers.push("https://tate.esri.com");

  STATE.kgService = kgService;

  /* ── Wire login form ──────────────────────────────── */
  const loginBtn  = document.getElementById("login-btn");
  const loginErr  = document.getElementById("login-error");

  async function doLogin() {
    const user = document.getElementById("l-user").value.trim();
    const pass = document.getElementById("l-pass").value;
    if (!user || !pass) { loginErr.textContent = "Enter username and password."; return; }

    loginBtn.disabled = true;
    loginBtn.textContent = "Connecting…";
    loginErr.textContent = "";

    try {
      /* Use native fetch — esri/request intercepts Portal auth URLs when
         portalUrl is set, causing it to return HTML instead of JSON.
         client=referer avoids IPv4/IPv6 loopback mismatch. */
      const tokenUrl = `${CFG.PORTAL_URL}/sharing/rest/generateToken`;
      const formBody = new URLSearchParams({
        username   : user,
        password   : pass,
        client     : "referer",
        referer    : window.location.origin,
        expiration : "120",
        f          : "json"
      });

      let rawText;
      try {
        const resp = await fetch(tokenUrl, {
          method  : "POST",
          headers : { "Content-Type": "application/x-www-form-urlencoded" },
          body    : formBody.toString()
        });
        rawText = await resp.text();
        console.log("[auth] HTTP", resp.status, resp.headers.get("content-type"));
      } catch (netErr) {
        throw new Error(
          "Cannot reach Portal. Accept the self-signed SSL certificate first by visiting:\n" +
          CFG.PORTAL_URL + "/home/index.html"
        );
      }

      if (rawText.trimStart().startsWith("<")) {
        console.error("[auth] Got HTML instead of JSON:", rawText.slice(0, 400));
        throw new Error(
          "Portal returned an HTML page instead of a token. " +
          "Open this URL and accept the SSL certificate:\n" +
          CFG.PORTAL_URL + "/home/index.html"
        );
      }

      let tokenData;
      try { tokenData = JSON.parse(rawText); }
      catch (e) { throw new Error("Portal response is not valid JSON: " + rawText.slice(0, 200)); }

      const token = tokenData?.token;
      if (!token) {
        throw new Error(tokenData?.error?.message || "No token in response. Check credentials.");
      }

      /* Register token with Portal's sharing/rest URL.
         JSAPI recognises this as a Portal credential and automatically
         handles federated-server token exchange for the KG Server. */
      const cred = {
        server  : `${CFG.PORTAL_URL}/sharing/rest`,
        token,
        ssl     : true,
        userId  : user,
        expires : tokenData.expires   // ms timestamp from Portal
      };
      IdentityManager.registerToken(cred);
      /* Also register directly for the KG server (belt-and-suspenders) */
      IdentityManager.registerToken({ server: CFG.KG_SERVER, token, ssl: true, userId: user });
      console.log("[auth] credentials registered for Portal + KG Server");

      /* Hide login, launch app */
      document.getElementById("login-overlay").style.display = "none";
      launchApp(esriConfig, Map, MapView, GraphicsLayer, Graphic);

    } catch (err) {
      console.error("Login error:", err);
      loginErr.textContent = err.message || "Login failed. Check URL and credentials.";
      loginBtn.disabled = false;
      loginBtn.textContent = "Connect to Knowledge Graph";
    }
  }

  loginBtn.addEventListener("click", doLogin);
  document.addEventListener("keydown", e => {
    if (e.key === "Enter" && document.getElementById("login-overlay").style.display !== "none") {
      doLogin();
    }
  });

  /* ── Wire mode tabs ───────────────────────────────── */
  document.querySelectorAll(".mode-tab").forEach(tab => {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
  });

  /* ── Wire layer toggles ───────────────────────────── */
  document.querySelectorAll(".ltog").forEach(btn => {
    btn.addEventListener("click", () => toggleLayer(btn.dataset.layer));
  });

  /* ── Wire legend toggle ──────────────────────────── */
  document.getElementById("legend-toggle").addEventListener("click", () => {
    document.getElementById("legend-body").classList.toggle("open");
  });

  /* ── Wire reset button ────────────────────────────── */
  document.getElementById("btn-reset").addEventListener("click", resetAll);

  /* ── Wire entity type tabs ──────────────────────────── */
  document.querySelectorAll(".etype-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      STATE.etypeFilter = tab.dataset.etype;
      document.querySelectorAll(".etype-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.etype === STATE.etypeFilter)
      );
      /* Switching tabs manually clears the cross-filter */
      clearCrossFilter();
      applyEtypeFilter();
    });
  });

  /* ── Wire cross-filter clear ────────────────────────── */
  document.getElementById("cross-filter-clear").addEventListener("click", () => {
    clearCrossFilter();
    applyEtypeFilter();
  });

  /* ── Wire detail close ────────────────────────────── */
  document.getElementById("btn-close-detail").addEventListener("click", closeDetail);
}

/* ════════════════════════════════════════════════════════
   LAUNCH APP  (called after successful login)
════════════════════════════════════════════════════════ */
async function launchApp(esriConfig, Map, MapView, GraphicsLayer, Graphic) {
  setBadge("Initializing map…");

  /* ── Layers ────────────────────────────────────────── */
  const venueLayer   = new GraphicsLayer({ title: "Venues",   listMode: "hide" });
  const eventLayer   = new GraphicsLayer({ title: "Events",   listMode: "hide" });
  const athleteLayer = new GraphicsLayer({ title: "Athletes", listMode: "hide" });

  STATE.layers = { athletes: athleteLayer, events: eventLayer, venues: venueLayer };

  /* ── Map & view ─────────────────────────────────────── */
  const map = new Map({
    basemap: "dark-gray-vector",
    layers : [venueLayer, eventLayer, athleteLayer]
  });

  const view = new MapView({
    container : "viewDiv",
    map,
    center    : [20, 22],
    zoom      : 1,
    popup     : { dockEnabled: false, defaultPopupTemplateEnabled: false },
    ui        : { components: ["zoom", "attribution"] }
  });
  STATE.view = view;

  /* ── Map click → entity detail ───────────────────────── */
  view.on("click", async evt => {
    const hit = await view.hitTest(evt, { include: [athleteLayer, eventLayer] });
    if (!hit.results.length) { closeDetail(); clearHighlight(); return; }
    const attrs = hit.results[0].graphic.attributes;
    const pool  = attrs.__etype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
    const entity = pool.find(x => x.id === attrs.__eid);
    if (entity) selectEntity(entity, attrs.__etype);
  });

  /* ── Connect to KG ─────────────────────────────────────── */
  setBadge("Connecting to Knowledge Graph…");
  try {
    /* Pre-check: verify the KG server SSL cert is trusted by the browser.
       "Failed to fetch" here means the cert hasn't been accepted yet. */
    try {
      await fetch(`${CFG.KG_SERVER}/arcgis/rest/services?f=json`, { method: "GET" });
    } catch (_sslErr) {
      const trustUrl = `${CFG.KG_SERVER}/arcgis/rest/services?f=json`;
      throw new Error(
        `SSL certificate not trusted for the ArcGIS Server (port 6443).\n\n` +
        `Open this URL in a new tab, click Advanced → Proceed, then come back and refresh:\n` +
        trustUrl
      );
    }

    STATE.kg = await STATE.kgService.fetchKnowledgeGraph(CFG.KG_URL);
    setBadge("Connected", "ok");
    buildFilters();
    wireSearch();
    await loadAllData(Graphic);
  } catch (err) {
    console.error("KG connect error:", err);
    setBadge("KG Error", "err");
    showList(`<div class="state-box"><span style="color:#f55">Cannot reach Knowledge Graph.<br><small style="white-space:pre-wrap">${escH(err.message)}</small></span></div>`);
  }
}

/* ════════════════════════════════════════════════════════
   DATA LOADING
════════════════════════════════════════════════════════ */
async function loadAllData(Graphic) {
  showList(`<div class="state-box"><div class="spinner"></div><span>Loading Knowledge Graph data…</span></div>`);
  setCount("<b>Loading…</b>");

  try {
    const [athletes, events, venues] = await Promise.all([
      streamQuery("MATCH (a:Athlete) RETURN a ORDER BY a.name"),
      streamQuery("MATCH (e:Event)   RETURN e ORDER BY e.start_date"),
      streamQuery("MATCH (v:Venue)   RETURN v")
    ]);

    STATE.allAthletes = athletes;
    STATE.allVenues   = venues;

    /* Sort events: upcoming first, then by date ascending */
    const now    = Date.now();
    const in30   = now + 30 * 24 * 60 * 60 * 1000;
    events.sort((a, b) => {
      const da = a.props.start_date ? new Date(String(a.props.start_date).slice(0,10)).getTime() : Infinity;
      const db = b.props.start_date ? new Date(String(b.props.start_date).slice(0,10)).getTime() : Infinity;
      const aUp = da >= now && da <= in30 ? 0 : 1;
      const bUp = db >= now && db <= in30 ? 0 : 1;
      if (aUp !== bUp) return aUp - bUp;
      return da - db;
    });
    STATE.allEvents = events;

    buildGraphics(Graphic);

    const upcomingCount = events.filter(e => {
      const d = e.props.start_date;
      if (!d) return false;
      const ts = new Date(String(d).slice(0,10)).getTime();
      return ts >= now && ts <= in30;
    }).length;

    document.getElementById("s-athletes").textContent = athletes.length;
    document.getElementById("s-events").textContent   = events.length;
    document.getElementById("s-venues").textContent   = venues.length;
    document.getElementById("s-upcoming").textContent  = upcomingCount;

    renderList(athletes, events,
      `<b>${events.length}</b> events · <b>${athletes.length}</b> athletes`);

  } catch (err) {
    console.error("Load error:", err);
    showList(`<div class="state-box"><span style="color:#f55">Error: ${escH(err.message)}</span></div>`);
  }
}

/* ════════════════════════════════════════════════════════
   KG STREAMING QUERIES
════════════════════════════════════════════════════════ */

/** Returns array of { id, typeName, props, geom } */
async function streamQuery(cypher, params = {}) {
  const result = await STATE.kgService.executeQueryStreaming(STATE.kg, {
    openCypherQuery : cypher,
    bindParameters  : params
  });

  const rows   = [];
  const reader = result.resultRowsStream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    for (const row of value) {
      const ent = row[0];
      if (ent && ent.properties !== undefined) {
        rows.push(parseEntity(ent));
      }
    }
  }
  return rows;
}

/** Like streamQuery but returns each full row (for relationship traversals).
 *  Returns array of arrays: each inner array is [entity0, entity1, ...] */
async function streamRows(cypher, params = {}, cols = 2) {
  const result = await STATE.kgService.executeQueryStreaming(STATE.kg, {
    openCypherQuery : cypher,
    bindParameters  : params
  });

  const rows   = [];
  const reader = result.resultRowsStream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    for (const row of value) {
      const out = [];
      for (let i = 0; i < cols; i++) {
        const e = row[i];
        out.push((e && e.properties !== undefined) ? parseEntity(e) : e);
      }
      rows.push(out);
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
   MAP GRAPHICS
════════════════════════════════════════════════════════ */
let _Graphic = null;

function buildGraphics(Graphic) {
  if (Graphic) _Graphic = Graphic;
  if (!_Graphic) return;

  STATE.layers.athletes.removeAll();
  STATE.layers.events.removeAll();
  STATE.layers.venues.removeAll();

  STATE.allAthletes.forEach(e => {
    if (!e.geom) return;
    STATE.layers.athletes.add(makeGraphic(e, "Athlete", SYM.athlete));
  });
  STATE.allEvents.forEach(e => {
    if (!e.geom) return;
    STATE.layers.events.add(makeGraphic(e, "Event", SYM.event));
  });
  STATE.allVenues.forEach(e => {
    if (!e.geom) return;
    STATE.layers.venues.add(makeGraphic(e, "Venue", SYM.venue));
  });
}

function makeGraphic(entity, etype, sym) {
  return new _Graphic({
    geometry  : { type: "point", ...entity.geom },
    symbol    : sym,
    attributes: { ...entity.props, __etype: etype, __eid: entity.id }
  });
}

/** Check if an event starts within 30 days from today */
function isUpcoming(entity, now30Epoch) {
  const d = entity.props.start_date;
  if (!d) return false;
  const ts = new Date(String(d).slice(0, 10)).getTime();
  return ts >= Date.now() && ts <= now30Epoch;
}

/* ── Highlight ──────────────────────────────────────── */
function highlightEntities(athIds, evIds, zoom = true) {
  const athSet = new Set(athIds);
  const evSet  = new Set(evIds);
  const pts    = [];

  const hasAthFilter = athSet.size > 0;
  const hasEvFilter  = evSet.size  > 0;

  STATE.layers.athletes.graphics.forEach(g => {
    const match = athSet.has(g.attributes.__eid);
    g.symbol = match ? SYM.athleteHL : (hasAthFilter ? SYM.athleteDim : SYM.athlete);
    if (match && g.geometry) pts.push(g.geometry);
  });

  STATE.layers.events.graphics.forEach(g => {
    const match = evSet.has(g.attributes.__eid);
    g.symbol = match ? SYM.eventHL : (hasEvFilter ? SYM.eventDim : SYM.event);
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

/* ── Layer toggle ───────────────────────────────────── */
function toggleLayer(name) {
  STATE.layerVis[name] = !STATE.layerVis[name];
  const visible = STATE.layerVis[name];
  document.getElementById(`ltog-${name}`).classList.toggle("off", !visible);
  const layer = STATE.layers[name];
  if (layer) layer.visible = visible;
}

/* ════════════════════════════════════════════════════════
   SEARCH  (client-side, instant — no extra KG round-trip)
════════════════════════════════════════════════════════ */
function wireSearch() {
  const input = document.getElementById("search-input");
  const clear = document.getElementById("search-clear");

  input.addEventListener("input", () => {
    const v = input.value.trim();
    clear.style.display = v ? "block" : "none";
    clearTimeout(STATE.searchTimer);
    if (!v)       { resetAll(); return; }
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
    includes(e.props.name,          t) ||
    includes(e.props.sport,         t) ||
    includes(e.props.nationality,   t) ||
    includes(e.props.origin_city,   t) ||
    includes(e.props.residence_city,t)
  );

  const events = STATE.allEvents.filter(e =>
    includes(e.props.title,         t) ||
    includes(e.props.country,       t) ||
    includes(e.props.venue_name,    t) ||
    includes(e.props.sport_labels,  t) ||
    includes(e.props.locality,      t)
  );

  const total = athletes.length + events.length;
  renderList(athletes, events,
    total
      ? `<b>${total}</b> results for "<em>${escH(term)}</em>"`
      : `No results for "${escH(term)}"`
  );

  if (total > 0) {
    highlightEntities(athletes.map(a => a.id), events.map(e => e.id));
  } else {
    clearHighlight();
  }
}

function includes(val, term) {
  return val && String(val).toLowerCase().includes(term);
}

/* ════════════════════════════════════════════════════════
   PILL FILTERS  (Sport & Country)
════════════════════════════════════════════════════════ */
function buildFilters() {
  /* Sport pills */
  const sp = document.getElementById("sport-pills");
  ["All", ...CFG.SPORTS].forEach(sport => {
    const btn = document.createElement("button");
    btn.className = "pill" + (sport === "All" ? " active" : "");
    btn.textContent = sport;
    btn.dataset.val = sport;
    btn.addEventListener("click", () => filterBySport(sport));
    sp.appendChild(btn);
  });

  /* Country pills */
  const cp = document.getElementById("country-pills");
  const countries = [{ code:"All", name:"All" },
    ...Object.entries(CFG.COUNTRIES).map(([k, v]) => ({ code: k, name: v }))];

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

  /* Client-side filter: athlete.sport field and event.sport_labels */
  const athletes = STATE.allAthletes.filter(e =>
    (e.props.sport || "")
      .split("/")
      .some(s => s.trim().toLowerCase() === sport.toLowerCase())
  );
  const events = STATE.allEvents.filter(e =>
    (e.props.sport_labels || "").toLowerCase().includes(sport.toLowerCase())
  );

  renderList(athletes, events, `<b>${athletes.length + events.length}</b> in ${escH(sport)}`);
  highlightEntities(athletes.map(a => a.id), events.map(e => e.id));
}

function filterByCountry(code) {
  setPillActive("country-pills", code);
  if (code === "All") { resetAll(); return; }

  closeDetail();
  const name = CFG.COUNTRIES[code] || code;

  const athletes = STATE.allAthletes.filter(e => {
    const nat     = e.props.nationality || "";
    const natCode = CFG.NAT_MAP[nat];
    return natCode === code;
  });

  const events = STATE.allEvents.filter(e => (e.props.country || "") === code);

  renderList(athletes, events, `<b>${athletes.length + events.length}</b> in ${escH(name)}`);
  highlightEntities(athletes.map(a => a.id), events.map(e => e.id));
}

function setPillActive(containerId, val) {
  document.querySelectorAll(`#${containerId} .pill`).forEach(p =>
    p.classList.toggle("active", p.dataset.val === val)
  );
}

/* ════════════════════════════════════════════════════════
   MODE SWITCHING
════════════════════════════════════════════════════════ */
function switchMode(mode) {
  document.querySelectorAll(".mode-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.mode === mode)
  );
  document.querySelectorAll(".query-section").forEach(s =>
    s.classList.toggle("active", s.id === `mode-${mode}`)
  );
  if (mode !== "search") closeDetail();
}

/* ════════════════════════════════════════════════════════
   RESET
════════════════════════════════════════════════════════ */
function resetAll() {
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear").style.display = "none";
  document.querySelectorAll(".pill").forEach(p =>
    p.classList.toggle("active", p.dataset.val === "All")
  );
  STATE.etypeFilter = "events";
  document.querySelectorAll(".etype-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.etype === "events")
  );
  clearCrossFilter();
  clearHighlight();
  closeDetail();
  if (STATE.allEvents.length) {
    renderList(
      STATE.allAthletes, STATE.allEvents,
      `<b>${STATE.allEvents.length}</b> events · <b>${STATE.allAthletes.length}</b> athletes`
    );
  }
}

/* ════════════════════════════════════════════════════════
   ENTITY SELECTION & DETAIL PANEL
════════════════════════════════════════════════════════ */
async function selectEntity(entity, etype, scrollCard = true) {
  /* Highlight active card */
  document.querySelectorAll(".entity-card").forEach(c => c.classList.remove("active"));
  const card = document.querySelector(`.entity-card[data-id="${entity.id}"]`);
  if (card) {
    card.classList.add("active");
    if (scrollCard) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  if (etype === "Athlete") {
    await showAthleteDetail(entity);
  } else {
    await showEventDetail(entity);
  }
}

/* ── Athlete detail ──────────────────────────────────── */
async function showAthleteDetail(athlete) {
  const p = athlete.props;

  /* Query their events through the KG relationship */
  let relEvents = [];
  try {
    const rows = await streamRows(
      `MATCH (a:Athlete)-[:PARTICIPATES_IN]->(e:Event) WHERE a.name = $name RETURN a, e`,
      { name: p.name || "" }, 2
    );
    relEvents = rows.map(r => r[1]).filter(Boolean);
  } catch (err) {
    console.warn("Athlete→Events query failed:", err.message);
  }

  highlightEntities([athlete.id], relEvents.map(e => e.id), false);

  /* Cross-filter: switch to Events tab showing related events */
  if (relEvents.length > 0) {
    STATE.crossFilter = { name: p.name || "Athlete", athletes: [], events: relEvents };
    STATE.etypeFilter = "events";
    document.querySelectorAll(".etype-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.etype === "events")
    );
    applyEtypeFilter();
  }

  /* Render */
  const detEtype = document.getElementById("detail-etype");
  detEtype.textContent = "Athlete";
  detEtype.className   = "detail-etype athlete";
  document.getElementById("detail-name").textContent = p.name || "—";

  const relHTML = relEvents.slice(0, 8).map(e => {
    const ep   = e.props;
    const date = ep.start_date ? String(ep.start_date).slice(0, 10) : "";
    return `<div class="related-item" data-zoom="${e.id}" data-ztype="Event">
      <span class="rdot blue"></span>
      <span class="rname">${escH(ep.title || "Event")}</span>
      <span class="rmeta">${escH(ep.country || "")} ${date}</span>
    </div>`;
  }).join("");

  document.getElementById("detail-body").innerHTML = `
    <div class="detail-grid">
      ${dp("Sport",       p.sport              || "—")}
      ${dp("Nationality", p.nationality         || "—")}
      ${dp("Residence",   p.residence_city      || "—")}
      ${dp("Origin",      p.origin_city         || "—")}
      ${dp("Category",    p.category            || "—")}
      ${dp("Audience",    p.audience_size_estimate || "—")}
    </div>
    <div class="detail-relationship-hint">Events this athlete is confirmed for or recommended to attend.</div>
    ${relEvents.length > 0
      ? `<p class="related-label">Participates in ${relEvents.length} event(s)</p>
         <div class="related-list">${relHTML}</div>`
      : `<p class="related-label" style="color:#333">No events linked</p>`}`;

  wireRelatedClicks();
  openDetailPanel();
}

/* ── Event detail ────────────────────────────────────── */
async function showEventDetail(event) {
  const p = event.props;

  /* Query confirmed Nike athletes at this event */
  let relAthletes = [];
  try {
    const rows = await streamRows(
      `MATCH (a:Athlete)-[:PARTICIPATES_IN]->(e:Event) WHERE e.event_id = $eid RETURN a, e`,
      { eid: p.event_id || "" }, 2
    );
    relAthletes = rows.map(r => r[0]).filter(Boolean);
  } catch (err) {
    console.warn("Event→Athletes query failed:", err.message);
  }

  /* Build recommended athletes (client-side matching) */
  const confirmedIds = new Set(relAthletes.map(a => a.id));
  const recMap = new Map(); // id → { entity, reasons: [] }

  const eventSports = (p.sport_labels || "").toLowerCase().split(/[,/]/).map(s => s.trim()).filter(Boolean);
  const eventCity   = (p.locality || "").toLowerCase().trim();
  const eventCountry = (p.country || "").toUpperCase().trim();

  // Build reverse NAT_MAP: country code → nationality strings
  const codeToNats = {};
  for (const [nat, code] of Object.entries(CFG.NAT_MAP)) {
    if (!codeToNats[code]) codeToNats[code] = [];
    codeToNats[code].push(nat.toLowerCase());
  }

  STATE.allAthletes.forEach(a => {
    if (confirmedIds.has(a.id)) return;
    const ap = a.props;
    const reasons = [];

    // Same sport
    if (eventSports.length > 0) {
      const athSports = (ap.sport || "").toLowerCase().split(/[/,]/).map(s => s.trim());
      if (athSports.some(s => eventSports.includes(s))) {
        reasons.push("Same sport");
      }
    }

    // Based in event city
    if (eventCity) {
      const origin = (ap.origin_city || "").toLowerCase().trim();
      const residence = (ap.residence_city || "").toLowerCase().trim();
      if (origin === eventCity || residence === eventCity) {
        reasons.push("Based in city");
      }
    }

    // From event country (nationality match)
    if (eventCountry) {
      const natCode = CFG.NAT_MAP[ap.nationality || ""];
      if (natCode === eventCountry) {
        reasons.push("From country");
      }
    }

    if (reasons.length > 0) {
      recMap.set(a.id, { entity: a, reasons });
    }
  });

  const recommended = Array.from(recMap.values()).slice(0, 10);

  /* Combine all athletes for highlight + cross-filter */
  const allRelated = [...relAthletes, ...recommended.map(r => r.entity)];
  highlightEntities(allRelated.map(a => a.id), [event.id], false);

  /* Store cross-filter data but don't switch tabs */
  if (allRelated.length > 0) {
    STATE.crossFilter = { name: p.title || "Event", athletes: allRelated, events: [] };
  }

  /* Render */
  const detEtype = document.getElementById("detail-etype");
  detEtype.textContent = "Event";
  detEtype.className   = "detail-etype event";
  document.getElementById("detail-name").textContent = p.title || "—";

  const date  = p.start_date ? String(p.start_date).slice(0, 10) : "—";
  const att   = p.attendance    ? Number(p.attendance).toLocaleString()    : "—";
  const spend = p.predicted_spend
    ? "$" + Number(p.predicted_spend).toLocaleString(undefined, { maximumFractionDigits: 0 })
    : "—";

  /* Section A — Confirmed */
  const relHTML = relAthletes.slice(0, 8).map(a => {
    const ap = a.props;
    return `<div class="related-item" data-zoom="${a.id}" data-ztype="Athlete">
      <span class="rdot orange"></span>
      <span class="rname">${escH(ap.name || "Athlete")}</span>
      <span class="rmeta">${escH(ap.sport || "")}</span>
    </div>`;
  }).join("");

  /* Section B — Recommended */
  const recHTML = recommended.map(r => {
    const ap = r.entity.props;
    const tags = r.reasons.map(t => `<span class="reason-tag">${escH(t)}</span>`).join(" ");
    return `<div class="related-item" data-zoom="${r.entity.id}" data-ztype="Athlete">
      <span class="rdot orange"></span>
      <span class="rname">${escH(ap.name || "Athlete")}</span>
      ${tags}
    </div>`;
  }).join("");

  document.getElementById("detail-body").innerHTML = `
    <div class="detail-grid">
      ${dp("Date",        date)}
      ${dp("Country",     p.country      || "—")}
      ${dp("Venue",       p.venue_name   || "—")}
      ${dp("City",        p.locality     || "—")}
      ${dp("Attendance",  att)}
      ${dp("Est. Spend",  spend)}
      ${dp("Sport",       p.sport_labels || "—")}
      ${dp("Rank",        p.rank         || "—")}
    </div>
    <div class="detail-relationship-hint">Confirmed Nike athletes and recommended assignments based on sport, location, and availability.</div>
    ${relAthletes.length > 0
      ? `<p class="related-label">${relAthletes.length} Confirmed Athlete(s)</p>
         <div class="related-list">${relHTML}</div>`
      : `<p class="related-label" style="color:#333">No confirmed athletes</p>`}
    ${recommended.length > 0
      ? `<p class="recommended-label">${recommended.length} Recommended Athlete(s)</p>
         <div class="related-list">${recHTML}</div>`
      : ""}`;

  wireRelatedClicks();
  openDetailPanel();
}

/* ── Wire related-item clicks (drill-down into detail) ── */
function wireRelatedClicks() {
  document.querySelectorAll(".related-item[data-zoom]").forEach(el => {
    el.addEventListener("click", () => {
      const id    = el.dataset.zoom;
      const etype = el.dataset.ztype;
      const pool  = etype === "Athlete" ? STATE.allAthletes : STATE.allEvents;
      const ent   = pool.find(x => x.id === id);
      if (ent) selectEntity(ent, etype);
    });
  });
}

/* ════════════════════════════════════════════════════════
   RENDER RESULTS LIST
════════════════════════════════════════════════════════ */
function renderList(athletes, events, countHtml) {
  /* Store for re-filtering */
  STATE.lastAthletes  = athletes;
  STATE.lastEvents    = events;
  STATE.lastCountHtml = countHtml;

  applyEtypeFilter();
}

function applyEtypeFilter() {
  const tab    = STATE.etypeFilter;
  const cf     = STATE.crossFilter;
  const banner = document.getElementById("cross-filter-banner");

  let items = [];

  if (tab === "athletes") {
    items = cf ? cf.athletes : STATE.lastAthletes;
  } else {
    items = cf ? cf.events : STATE.lastEvents;
  }

  /* Update tab counts */
  document.querySelectorAll(".etype-tab").forEach(t => {
    if (t.dataset.etype === "athletes") {
      const n = cf ? cf.athletes.length : STATE.lastAthletes.length;
      t.textContent = `Athletes (${n})`;
    }
    if (t.dataset.etype === "events") {
      const n = cf ? cf.events.length : STATE.lastEvents.length;
      t.textContent = `Events (${n})`;
    }
  });

  /* Cross-filter banner */
  if (cf) {
    const label = tab === "events"
      ? `Events related to ${escH(cf.name)}`
      : `Athletes at ${escH(cf.name)}`;
    document.getElementById("cross-filter-text").innerHTML = label;
    banner.style.display = "flex";
  } else {
    banner.style.display = "none";
  }

  setCount(STATE.lastCountHtml);

  const MAX = 80;
  let html  = "";

  if (tab === "athletes") {
    items.slice(0, MAX).forEach(e => {
      const p    = e.props;
      const name = escH(p.name || "Unknown Athlete");
      const meta = [p.sport, p.nationality].filter(Boolean).join(" · ");
      html += entityCard(e.id, "Athlete", "athlete", "🏃", name, escH(meta));
    });
  } else {
    const now30e = Date.now() + 30 * 24 * 60 * 60 * 1000;
    items.slice(0, MAX).forEach(e => {
      const p     = e.props;
      const title = escH(p.title || "Unknown Event");
      const date  = p.start_date ? String(p.start_date).slice(0, 10) : "";
      const meta  = [p.country, date].filter(Boolean).join(" · ");
      const soon  = isUpcoming(e, now30e);
      const badge = soon ? `<span class="soon-badge">SOON</span>` : "";
      html += entityCard(e.id, "Event", "event", "📍", title + badge, escH(meta));
    });
  }

  if (!html) html = `<div class="state-box"><span>No ${tab} found</span></div>`;
  showList(html);

  /* Attach click listeners */
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

function entityCard(id, etype, cls, icon, name, meta) {
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
  clearCrossFilter();
  applyEtypeFilter();
  clearHighlight();
}
function openDetailPanel() {
  document.getElementById("detail-panel").classList.add("open");
  if (STATE.view) STATE.view.padding = { right: 380 };
}

function setBadge(text, cls) {
  const b = document.getElementById("kg-badge");
  b.textContent = text;
  b.className   = "kg-badge" + (cls ? ` ${cls}` : "");
}

function dp(label, value) {
  return `<div>
    <div class="dp-label">${label}</div>
    <div class="dp-value" title="${escH(String(value))}">${escH(String(value))}</div>
  </div>`;
}

function escH(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
