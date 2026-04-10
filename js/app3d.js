/**
 * Nike Event Tracker 3D — ArcGIS Maps SDK 4.32 + Knowledge Graph
 * SceneView (globe), 3D dual-layer symbols, arc connections.
 * Same visual style as nike-sports-moment-tracker reference app.
 */
"use strict";

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
  PORTAL_URL: KG_SOURCES["Nike_v16"].portal,
  KG_SERVER: KG_SOURCES["Nike_v16"].server,
  KG_URL: KG_SOURCES["Nike_v16"].url,
  EVENT_POOL: 2000,
  EVENT_LIMIT: 100,
  ATHLETE_LIMIT: 1000,
  VENUE_LIMIT: 3000,
  SPORT_LABEL_MAP: {
    "american football":["american football","nfl","ncaa"],"australian rules football":["australian football"],
    "baseball":["baseball","mlb"],"basketball":["basketball","nba","wnba","nba gleague","ncaa"],
    "cricket":["cricket"],"global football":["soccer","football"],"golf":["golf","pga","lpga"],
    "hockey":["hockey","ice hockey","nhl"],"indoor volleyball":["volleyball"],
    "nrl":["rugby","nrl"],"rugby":["rugby"],
    "running / t&f":["running","marathon","triathlon","ironman","sport"],
    "softball":["softball"],"tennis":["tennis"]
  }
};
const SCORE = { SPORT_LABEL:5, BORN_IN_CITY:4, TEAM_IN_CITY:4, UNI_IN_CITY:3, FROM_COUNTRY:3, TEAM_IN_COUNTRY:2, UNI_IN_COUNTRY:1 };
const STATE = { kg:null, kgService:null, view:null, layers:{}, arcLayer:null, labelLayer:null,
  allAthletes:[], allEvents:[], allVenues:[], searchTimer:null, etypeFilter:"events",
  lastAthletes:[], lastEvents:[], lastCountHtml:"", crossFilter:null };

/* ── Fetch interceptor ── */
(function(){
  const _f=window.fetch, ro=new URL(CFG.PORTAL_URL).origin, bp=`${ro}/sharing/rest`, gp=`${CFG.PORTAL_URL}/sharing/rest`;
  window.fetch=function(i,n){let u=(typeof i==="string")?i:(i?.url||String(i));
    if(u.startsWith(bp)&&!u.startsWith(gp)){const f=gp+u.slice(bp.length);i=(typeof i==="string")?f:new Request(f,i);}
    return _f.call(this,i,n);};
})();

/* ── AMD Boot ── */
require([
  "esri/config","esri/Map","esri/views/SceneView","esri/layers/GraphicsLayer",
  "esri/layers/FeatureLayer","esri/Graphic","esri/rest/knowledgeGraphService",
  "esri/identity/IdentityManager","esri/geometry/Point"
], function(esriConfig, Map, SceneView, GraphicsLayer, FeatureLayer, Graphic, kgService, IdMgr, Point){

  console.log("[boot] AMD modules loaded");
  STATE.kgService = kgService;
  esriConfig.portalUrl = CFG.PORTAL_URL;
  esriConfig.request.trustedServers.push("https://minint-k1bof4g.esri.com");

  /* ── Login ── */
  const loginBtn=document.getElementById("login-btn"), loginErr=document.getElementById("login-error");

  async function doLogin(){
    const user=document.getElementById("l-user").value.trim(), pass=document.getElementById("l-pass").value;
    if(!user||!pass){loginErr.textContent="Enter username and password.";return;}

    /* Apply selected KG source */
    const kgKey=document.getElementById("l-kg").value;
    const src=KG_SOURCES[kgKey];
    if(src){CFG.PORTAL_URL=src.portal;CFG.KG_SERVER=src.server;CFG.KG_URL=src.url;
      esriConfig.portalUrl=CFG.PORTAL_URL;
      esriConfig.request.trustedServers.push(new URL(CFG.PORTAL_URL).origin);
      console.log("[kg] Selected:",kgKey,CFG.KG_URL);}

    loginBtn.disabled=true; loginBtn.loading=true; loginBtn.innerHTML="Connecting..."; loginErr.textContent="";
    try{
      const r=await fetch(`${CFG.PORTAL_URL}/sharing/rest/generateToken`,{method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({username:user,password:pass,client:"referer",referer:window.location.origin,expiration:"120",f:"json"}).toString()});
      const raw=await r.text();
      if(raw.trimStart().startsWith("<"))throw new Error("Portal returned HTML.");
      const td=JSON.parse(raw); if(!td.token)throw new Error(td.error?.message||"No token.");
      IdMgr.registerToken({server:`${CFG.PORTAL_URL}/sharing/rest`,token:td.token,ssl:true,userId:user,expires:td.expires});
      IdMgr.registerToken({server:CFG.KG_SERVER,token:td.token,ssl:true,userId:user});
      IdMgr.registerToken({server:new URL(CFG.PORTAL_URL).origin+"/sharing/rest",token:td.token,ssl:true,userId:user});
      document.getElementById("login-overlay").style.display="none";
      document.getElementById("app-header").style.display="";
      document.getElementById("app-body").style.display="";
      launchApp();
    }catch(e){console.error(e);loginErr.textContent=e.message;loginBtn.disabled=false;loginBtn.loading=false;loginBtn.innerHTML="Connect to Knowledge Graph";}
  }
  loginBtn.addEventListener("click",doLogin);
  document.addEventListener("keydown",e=>{if(e.key==="Enter"&&document.getElementById("login-overlay").style.display!=="none")doLogin();});

  /* ── Launch ── */
  async function launchApp(){
    setBadge("Initializing globe...");

    const arcLayer=new GraphicsLayer({title:"Arcs",elevationInfo:{mode:"relative-to-ground"}});
    const pulseLayer=new GraphicsLayer({title:"Pulse",elevationInfo:{mode:"on-the-ground"}});
    STATE.arcLayer=arcLayer;
    STATE.pulseLayer=pulseLayer;
    STATE.layers={};

    STATE.map=new Map({basemap:"dark-gray-3d",ground:"world-elevation",layers:[arcLayer,pulseLayer]});
    const map=STATE.map;

    const view=new SceneView({
      container:"viewDiv", map,
      camera:{position:{longitude:-30,latitude:22,z:19500000},heading:0,tilt:0},
      qualityProfile:"medium",
      environment:{
        background:{type:"color",color:[0,0,0,1]},
        starsEnabled:false,
        atmosphereEnabled:true,
        atmosphere:{quality:"high"},
        lighting:{
          type:"virtual",
          directShadowsEnabled:false,
          ambientOcclusionEnabled:false
        }
      },
      popup:{dockEnabled:false,defaultPopupTemplateEnabled:false},
      ui:{components:["attribution"]}
    });
    STATE.view=view;

    view.on("click",async evt=>{
      const hit=await view.hitTest(evt);
      if(!hit.results.length){closeDetail();STATE.arcLayer.removeAll();return;}
      const a=hit.results[0].graphic.attributes;
      if(!a||!a.etype||a.etype==="Venue")return;
      const pool=a.etype==="Athlete"?STATE.allAthletes:STATE.allEvents;
      const ent=pool.find(x=>x.id===a.eid);
      if(ent)selectEntity(ent,a.etype);
    });

    setBadge("Connecting to Knowledge Graph...");
    try{
      await fetch(`${CFG.KG_SERVER}/rest/services?f=json`,{method:"GET"});
      STATE.kg=await kgService.fetchKnowledgeGraph(CFG.KG_URL);
      console.log("[schema]",Object.keys(STATE.kg.dataModel.entityTypes));
      setBadge("Connected","ok");
      wireUI(); await loadAllData();
    }catch(e){
      console.error("KG error:",e);setBadge("KG Error","err");
      showList(`<div class="state-box"><span style="color:#f55">${escH(e.message)}</span></div>`);
    }
  }

  /* ════ DATA ════ */
  async function loadAllData(){
    showList(`<div class="state-box"><div class="spinner"></div><span>Loading graph data...</span></div>`);
    setCount("<b>Loading...</b>");
    const t0=performance.now();
    const [athletes,rawEvents,venues]=await Promise.all([
      streamQuery("MATCH (a:Athlete) RETURN a",{},CFG.ATHLETE_LIMIT),
      streamQuery("MATCH (e:Event) RETURN e",{},CFG.EVENT_POOL),
      streamQuery("MATCH (v:Venue) RETURN v",{},CFG.VENUE_LIMIT)
    ]);
    /* Sort by rank DESC, keep top EVENT_LIMIT (most important) */
    rawEvents.sort((a,b)=>(parseInt(b.props.rank)||0)-(parseInt(a.props.rank)||0));
    const events=rawEvents.slice(0,CFG.EVENT_LIMIT);
    console.log(`[perf] ${(performance.now()-t0).toFixed(0)}ms | ${athletes.length}A ${rawEvents.length}E pooled → ${events.length} top rank ${venues.length}V`);
    STATE.allAthletes=athletes; STATE.allVenues=venues;
    STATE.allEvents=events;
    buildGraphics();
    startPulseAnimation(events.slice(0,3));
    document.getElementById("s-events").textContent=events.length;
    document.getElementById("s-athletes").textContent=athletes.length;
    document.getElementById("s-venues").textContent=venues.length;
    renderList(athletes,events,`<b>${events.length}</b> events · <b>${athletes.length}</b> athletes`);
  }

  /* ════ STREAMING ════ */
  async function streamQuery(cypher,params={},maxRows=0){
    const result=await kgService.executeQueryStreaming(STATE.kg,{openCypherQuery:cypher,bindParameters:params});
    const rows=[],reader=result.resultRowsStream.getReader();
    for(;;){const{done,value}=await reader.read();if(done)break;if(!value)continue;
      for(const row of value){
        if(maxRows>0&&rows.length>=maxRows)continue;
        const ent=row[0];
        if(ent&&ent.properties!==undefined)rows.push(parseEntity(ent));
      }
    }
    return rows;
  }
  async function safeStreamQuery(c,p={},m=200){try{return await streamQuery(c,p,m);}catch(e){console.warn("[safe]",e.message);return[];}}
  function parseEntity(ent){return{id:ent.id,typeName:ent.typeName,props:ent.properties,geom:extractPoint(ent.properties.shape)};}
  function extractPoint(s){if(!s)return null;try{const x=s.x??s.coordinates?.[0],y=s.y??s.coordinates?.[1];
    if(x==null||y==null||(x===0&&y===0))return null;return{x:parseFloat(x),y:parseFloat(y)};}catch{return null;}}

  /* ════ 3D GRAPHICS (FeatureLayer + icon-only for performance) ════ */
  const FL_FIELDS=[
    {name:"OBJECTID",type:"oid"},
    {name:"eid",type:"string"},
    {name:"etype",type:"string"},
    {name:"name",type:"string"}
  ];

  function toFeatures(items,etype){
    return items.filter(e=>e.geom).map((e,i)=>new Graphic({
      geometry:{type:"point",longitude:e.geom.x,latitude:e.geom.y},
      attributes:{OBJECTID:i+1,eid:e.id,etype:etype,name:e.props.name||""}
    }));
  }

  function buildGraphics(){
    /* Remove old layers if rebuilding */
    const map=STATE.map;
    if(STATE.layers.events) map.remove(STATE.layers.events);
    if(STATE.layers.athletes) map.remove(STATE.layers.athletes);
    if(STATE.layers.venues) map.remove(STATE.layers.venues);

    const t0=performance.now();

    /* Events — blue icon + 3D cone when zoomed in */
    STATE.layers.events=new FeatureLayer({
      title:"Events",source:toFeatures(STATE.allEvents,"Event"),
      objectIdField:"OBJECTID",geometryType:"point",
      spatialReference:{wkid:4326},fields:FL_FIELDS,
      elevationInfo:{mode:"on-the-ground"},
      screenSizePerspectiveEnabled:true,
      renderer:{type:"simple",symbol:{type:"point-3d",symbolLayers:[
        {type:"icon",size:14,resource:{primitive:"circle"},
         material:{color:[0,184,255]},outline:{color:[255,255,255,0.85],size:2}},
        {type:"object",width:30,height:150,depth:30,
         resource:{primitive:"cone"},material:{color:[0,184,255]}}
      ]}}
    });

    /* Athletes — orange icon + 3D cylinder when zoomed in */
    STATE.layers.athletes=new FeatureLayer({
      title:"Athletes",source:toFeatures(STATE.allAthletes,"Athlete"),
      objectIdField:"OBJECTID",geometryType:"point",
      spatialReference:{wkid:4326},fields:FL_FIELDS,
      elevationInfo:{mode:"on-the-ground"},
      screenSizePerspectiveEnabled:true,
      renderer:{type:"simple",symbol:{type:"point-3d",symbolLayers:[
        {type:"icon",size:10,resource:{primitive:"circle"},
         material:{color:[255,85,0]},outline:{color:[255,255,255,0.7],size:1.5}},
        {type:"object",width:20,height:100,depth:20,
         resource:{primitive:"cylinder"},material:{color:[255,85,0]}}
      ]}}
    });

    /* Venues — tiny gray, with declutter */
    STATE.layers.venues=new FeatureLayer({
      title:"Venues",source:toFeatures(STATE.allVenues||[],"Venue"),
      objectIdField:"OBJECTID",geometryType:"point",
      spatialReference:{wkid:4326},fields:FL_FIELDS,
      elevationInfo:{mode:"on-the-ground"},
      screenSizePerspectiveEnabled:true,
      featureReduction:{type:"selection"},
      renderer:{type:"simple",symbol:{type:"point-3d",symbolLayers:[
        {type:"icon",size:4,resource:{primitive:"circle"},
         material:{color:[100,100,100,0.4]}}
      ]}}
    });

    map.addMany([STATE.layers.venues,STATE.layers.events,STATE.layers.athletes]);
    console.log(`[perf] buildGraphics: ${(performance.now()-t0).toFixed(0)}ms`);
  }

  /* ════ PULSE ANIMATION — top 3 events flash on the globe ════ */
  function startPulseAnimation(topEvents){
    if(STATE.pulseInterval) clearInterval(STATE.pulseInterval);
    STATE.pulseLayer.removeAll();

    const pulseEvents=topEvents.filter(e=>e.geom);
    if(!pulseEvents.length)return;

    /* Create 3 ring graphics per event (concentric expanding rings) */
    const rings=[];
    pulseEvents.forEach((e,idx)=>{
      for(let r=0;r<3;r++){
        const g=new Graphic({
          geometry:{type:"point",longitude:e.geom.x,latitude:e.geom.y},
          symbol:{type:"point-3d",symbolLayers:[{
            type:"icon",size:20,resource:{primitive:"circle"},
            material:{color:[0,184,255,0]},
            outline:{color:[0,220,255,0.8],size:2.5}
          }]},
          attributes:{__pulseIdx:idx,__ringIdx:r,__eid:e.id,__name:e.props.name||""}
        });
        rings.push(g);
      }
    });
    STATE.pulseLayer.addMany(rings);

    /* Animate: cycle ring sizes and opacity */
    let tick=0;
    STATE.pulseInterval=setInterval(()=>{
      tick++;
      rings.forEach(g=>{
        const r=g.attributes.__ringIdx;
        const phase=((tick*3)+r*33)%100;  /* 0-99, offset per ring */
        const size=18+phase*1.2;           /* 18 → 138px */
        const alpha=Math.max(0,1-phase/80);

        g.symbol={type:"point-3d",symbolLayers:[{
          type:"icon",size:size,resource:{primitive:"circle"},
          material:{color:[0,184,255,0]},
          outline:{color:[0,220,255,alpha],size:2}
        }]};
      });
    },80);

    /* Log which events are pulsing */
    console.log("[pulse] Top 3 events:",pulseEvents.map(e=>`${e.props.name} (rank ${e.props.rank})`));
  }

  function stopPulse(){
    if(STATE.pulseInterval){clearInterval(STATE.pulseInterval);STATE.pulseInterval=null;}
    STATE.pulseLayer.removeAll();
  }

  /* ── Arcs ── */
  function drawArcs(eg,ags){
    STATE.arcLayer.removeAll();if(!eg||!ags.length)return;
    STATE.arcLayer.addMany(ags.map(ag=>{
      const mx=(eg.x+ag.x)/2,my=(eg.y+ag.y)/2;
      const d=Math.sqrt((eg.x-ag.x)**2+(eg.y-ag.y)**2);
      const h=Math.max(d*30000,100000);
      return new Graphic({
        geometry:{type:"polyline",paths:[[[eg.x,eg.y,50000],[mx,my,h],[ag.x,ag.y,15000]]]},
        symbol:{type:"line-3d",symbolLayers:[{type:"line",size:2,material:{color:[255,85,0,0.6]}}]}
      });
    }));
  }

  /* ── Camera ── */
  function flyToStreet(lon,lat){
    if(!STATE.view)return;
    stopPulse();
    STATE.map.basemap="dark-gray-3d";
    if(STATE.layers.venues)STATE.layers.venues.visible=false;
    STATE.view.goTo(
      {target:new Point({longitude:lon,latitude:lat}),scale:3000,tilt:60,heading:0},
      {duration:1500,easing:"ease-in-out"}).then(()=>{
        if(STATE.layers.venues)STATE.layers.venues.visible=true;
      }).catch(()=>{if(STATE.layers.venues)STATE.layers.venues.visible=true;});
  }
  function flyToRegion(lon,lat,rank){
    if(!STATE.view)return;
    const r=parseInt(rank)||50;
    const alt=r>=88?1800000:r>=75?2800000:4200000;
    STATE.view.goTo(
      {position:{longitude:lon,latitude:lat,z:alt},heading:0,tilt:18},
      {duration:1500,easing:"ease-in-out"}).catch(()=>{});
  }
  function flyToGlobe(){
    if(!STATE.view)return;
    STATE.map.basemap="dark-gray-3d";
    STATE.view.padding={top:0,right:0,bottom:0,left:0};
    STATE.view.goTo(
      {position:{longitude:-30,latitude:22,z:19500000},heading:0,tilt:0},
      {duration:1500,easing:"ease-in-out"}).then(()=>{
        /* Restart pulse on globe view */
        if(STATE.allEvents.length)startPulseAnimation(STATE.allEvents.slice(0,3));
      }).catch(()=>{});
  }

  /* ════ SCORING ════ */
  async function scoreAthletesForEvent(event){
    const p=event.props,el=getEventLabels(event);
    const city=(p.city||p.locality||"").trim(),country=(p.country||"").trim();
    const board=Object.create(null);
    function add(a,pts,reason){if(!board[a.id])board[a.id]={entity:a,score:0,reasons:[]};board[a.id].score+=pts;board[a.id].reasons.push({text:reason,points:pts});}
    STATE.allAthletes.forEach(a=>{const sh=[...getAthleteLabelSet(a)].filter(l=>el.has(l));if(sh.length>0)add(a,SCORE.SPORT_LABEL,`Sport: ${a.props.sport}`);});
    const q=[];
    if(city){
      q.push(safeStreamQuery(`MATCH (a:Athlete)-[:BORN_IN]->(c:City) WHERE c.name = $v RETURN a`,{v:city}).then(r=>r.forEach(a=>add(a,SCORE.BORN_IN_CITY,`Born in ${city}`))));
      q.push(safeStreamQuery(`MATCH (a:Athlete)-[:PLAYS_FOR]->(t:Team) WHERE t.city = $v RETURN a`,{v:city}).then(r=>r.forEach(a=>add(a,SCORE.TEAM_IN_CITY,`Team in ${city}`))));
      q.push(safeStreamQuery(`MATCH (a:Athlete)-[:ATTENDS]->(u:University) WHERE u.city = $v RETURN a`,{v:city}).then(r=>r.forEach(a=>add(a,SCORE.UNI_IN_CITY,`Studied in ${city}`))));
    }
    if(country){
      q.push(safeStreamQuery(`MATCH (a:Athlete)-[:ORIGINATES_FROM]->(c:Country) WHERE c.name = $v RETURN a`,{v:country}).then(r=>r.forEach(a=>add(a,SCORE.FROM_COUNTRY,`From ${country}`))));
      q.push(safeStreamQuery(`MATCH (a:Athlete)-[:PLAYS_FOR]->(t:Team) WHERE t.country = $v RETURN a`,{v:country}).then(r=>r.forEach(a=>add(a,SCORE.TEAM_IN_COUNTRY,`Team in ${country}`))));
      q.push(safeStreamQuery(`MATCH (a:Athlete)-[:ATTENDS]->(u:University) WHERE u.country = $v RETURN a`,{v:country}).then(r=>r.forEach(a=>add(a,SCORE.UNI_IN_COUNTRY,`Studied in ${country}`))));
    }
    await Promise.all(q);
    return Object.values(board).sort((a,b)=>b.score-a.score).slice(0,10);
  }

  /* ════ LABELS ════ */
  function getEventLabels(ev){
    const raw=ev.props.labels||ev.props.phq_labels||"",str=String(raw),labels=new Set();
    try{const arr=JSON.parse(str.replace(/'/g,'"'));if(Array.isArray(arr)){arr.forEach(i=>{const l=(typeof i==="string"?i:i?.label||"").toLowerCase().trim();if(l)labels.add(l);});return labels;}}catch{}
    str.split(/[,|]/).forEach(s=>{const l=s.replace(/[\[\]'"]/g,"").toLowerCase().trim();if(l)labels.add(l);});return labels;
  }
  function getAthleteLabelSet(a){const s=(a.props.sport||"").toLowerCase().trim();const r=new Set(CFG.SPORT_LABEL_MAP[s]||[]);r.add(s);return r;}
  function findRelatedEvents(a){const al=getAthleteLabelSet(a);return STATE.allEvents.filter(e=>[...al].some(l=>getEventLabels(e).has(l))).map(e=>({entity:e,reason:`Sport: ${a.props.sport}`}));}

  /* ════ DETAIL PANEL ════ */
  async function selectEntity(entity,etype,scroll=true){
    document.querySelectorAll(".entity-card").forEach(c=>c.classList.remove("active"));
    const card=document.querySelector(`.entity-card[data-id="${entity.id}"]`);
    if(card){card.classList.add("active");if(scroll)card.scrollIntoView({block:"nearest",behavior:"smooth"});}
    if(etype==="Athlete")await showAthleteDetail(entity);else await showEventDetail(entity);
  }

  async function showEventDetail(event){
    const p=event.props;
    document.getElementById("detail-etype").textContent="Event";
    document.getElementById("detail-etype").className="detail-etype event";
    document.getElementById("detail-name").textContent=p.name||"—";
    const labels=[...getEventLabels(event)];
    const labelHTML=labels.map(l=>`<span class="reason-tag">${escH(l)}</span>`).join(" ");
    const att=p.phq_attendance?Number(p.phq_attendance).toLocaleString():"—";
    const spend=p.predictaed_event_spend?"$"+Number(p.predictaed_event_spend).toLocaleString(undefined,{maximumFractionDigits:0}):"—";
    document.getElementById("detail-body").innerHTML=`
      <div class="detail-grid">
        ${dp("Date",formatEventDate(event))} ${dp("Country",p.country||"—")}
        ${dp("City",p.city||p.locality||"—")} ${dp("Attendance",att)}
        ${dp("Est. Spend",spend)} ${dp("Rank",p.rank||"—")}
      </div>
      ${labels.length?`<p class="related-label" style="margin-top:12px">Labels</p><div style="margin:6px 0 12px;line-height:1.8">${labelHTML}</div>`:""}
      <div class="detail-relationship-hint">Scoring athletes via 7 graph paths...</div>
      <div id="athlete-results"><div class="state-box"><div class="spinner"></div><span>Querying graph...</span></div></div>`;
    openDetailPanel();

    /* Fly to event at street level */
    if(event.geom) flyToStreet(event.geom.x, event.geom.y);

    const ranked=await scoreAthletesForEvent(event);
    const relAthletes=ranked.map(r=>r.entity);
    if(event.geom){const ag=relAthletes.filter(a=>a.geom).map(a=>a.geom);drawArcs(event.geom,ag);}
    if(relAthletes.length>0)STATE.crossFilter={name:p.name||"Event",athletes:relAthletes,events:[]};

    const relHTML=ranked.map((r,i)=>{
      const ap=r.entity.props;
      const tags=r.reasons.sort((a,b)=>b.points-a.points).map(re=>`<span class="reason-tag" title="${re.points} pts">${escH(re.text)}</span>`).join(" ");
      return `<div class="related-item" data-zoom="${r.entity.id}" data-ztype="Athlete">
        <span class="rank-num">#${i+1}</span><span class="rdot orange"></span>
        <span class="rname">${escH(ap.name||"Athlete")}</span>
        <span class="score-badge">${r.score} pts</span>
        <div class="reason-row">${tags}</div></div>`;
    }).join("");
    document.getElementById("athlete-results").innerHTML=ranked.length>0
      ?`<p class="related-label">Top ${ranked.length} Athletes</p><div class="related-list">${relHTML}</div>`
      :`<p class="related-label" style="color:#555">No athletes matched</p>`;
    wireRelatedClicks();
  }

  async function showAthleteDetail(athlete){
    const p=athlete.props;
    document.getElementById("detail-etype").textContent="Athlete";
    document.getElementById("detail-etype").className="detail-etype athlete";
    document.getElementById("detail-name").textContent=p.name||"—";
    const related=findRelatedEvents(athlete);
    if(athlete.geom)flyToRegion(athlete.geom.x,athlete.geom.y,80);
    if(related.length>0){
      STATE.crossFilter={name:p.name||"Athlete",athletes:[],events:related.map(r=>r.entity)};
      STATE.etypeFilter="events";
      document.querySelectorAll(".etype-tab").forEach(t=>t.classList.toggle("active",t.dataset.etype==="events"));
      applyEtypeFilter();
      if(athlete.geom){const eg=related.map(r=>r.entity).filter(e=>e.geom).map(e=>e.geom);drawArcs(athlete.geom,eg);}
    }
    const al=[...getAthleteLabelSet(athlete)].map(l=>`<span class="reason-tag">${escH(l)}</span>`).join(" ");
    const relHTML=related.slice(0,10).map(r=>{const ep=r.entity.props;return `<div class="related-item" data-zoom="${r.entity.id}" data-ztype="Event">
      <span class="rdot blue"></span><span class="rname">${escH(ep.name||"Event")}</span>
      <span class="rmeta">${escH(ep.country||"")} ${formatEventDate(r.entity)}</span></div>`;}).join("");
    document.getElementById("detail-body").innerHTML=`
      <div class="detail-grid">${dp("Sport",p.sport||"—")} ${dp("Gender",p.gender||"—")} ${dp("Type",p.type||"—")}</div>
      ${al?`<p class="related-label" style="margin-top:12px">Sport Labels</p><div style="margin:6px 0 12px;line-height:1.8">${al}</div>`:""}
      <div class="detail-relationship-hint">Events matched via sport labels</div>
      ${related.length?`<p class="related-label">${related.length} Related Events</p><div class="related-list">${relHTML}</div>`
        :`<p class="related-label" style="color:#555">No matching events</p>`}`;
    wireRelatedClicks();openDetailPanel();
  }

  function wireRelatedClicks(){
    document.querySelectorAll(".related-item[data-zoom]").forEach(el=>{
      el.addEventListener("click",()=>{const pool=el.dataset.ztype==="Athlete"?STATE.allAthletes:STATE.allEvents;
        const ent=pool.find(x=>x.id===el.dataset.zoom);if(ent)selectEntity(ent,el.dataset.ztype);});
    });
  }

  /* ════ UI WIRING ════ */
  function wireUI(){
    document.querySelectorAll(".mode-tab").forEach(t=>t.addEventListener("click",()=>switchMode(t.dataset.mode)));
    document.getElementById("btn-reset").addEventListener("click",resetAll);
    document.querySelectorAll(".etype-tab").forEach(t=>{t.addEventListener("click",()=>{
      STATE.etypeFilter=t.dataset.etype;document.querySelectorAll(".etype-tab").forEach(x=>x.classList.toggle("active",x.dataset.etype===STATE.etypeFilter));
      clearCrossFilter();applyEtypeFilter();});});
    document.getElementById("cross-filter-clear").addEventListener("click",()=>{clearCrossFilter();applyEtypeFilter();});
    document.getElementById("btn-close-detail").addEventListener("click",closeDetail);
    const input=document.getElementById("search-input"),clear=document.getElementById("search-clear");
    input.addEventListener("input",()=>{const v=input.value.trim();clear.style.display=v?"block":"none";
      clearTimeout(STATE.searchTimer);if(!v){resetAll();return;}if(v.length<2)return;STATE.searchTimer=setTimeout(()=>doSearch(v),300);});
    clear.addEventListener("click",()=>{input.value="";clear.style.display="none";resetAll();});
    const sports=["All","Basketball","Tennis","Golf","Global Football","Baseball","American Football","Running / T&F","Hockey","Cricket","Rugby"];
    const sp=document.getElementById("sport-pills");
    sports.forEach(s=>{const b=document.createElement("button");b.className="pill"+(s==="All"?" active":"");b.textContent=s;b.dataset.val=s;
      b.addEventListener("click",()=>filterBySport(s));sp.appendChild(b);});
  }
  function doSearch(term){const t=term.toLowerCase();
    const ath=STATE.allAthletes.filter(e=>inc(e.props.name,t)||inc(e.props.sport,t));
    const ev=STATE.allEvents.filter(e=>inc(e.props.name,t)||inc(e.props.country,t)||inc(e.props.city,t)||inc(e.props.labels,t));
    renderList(ath,ev,(ath.length+ev.length)?`<b>${ath.length+ev.length}</b> results`:"No results");STATE.arcLayer.removeAll();}
  function filterBySport(s){document.querySelectorAll("#sport-pills .pill").forEach(p=>p.classList.toggle("active",p.dataset.val===s));
    if(s==="All"){resetAll();return;}closeDetail();const sL=s.toLowerCase();
    const ath=STATE.allAthletes.filter(e=>(e.props.sport||"").toLowerCase().includes(sL));
    const ln=CFG.SPORT_LABEL_MAP[sL]||[sL];const ev=STATE.allEvents.filter(e=>{const el=getEventLabels(e);return ln.some(l=>el.has(l));});
    renderList(ath,ev,`<b>${ath.length+ev.length}</b> in ${escH(s)}`);}
  function inc(v,t){return v&&String(v).toLowerCase().includes(t);}
  function switchMode(m){document.querySelectorAll(".mode-tab").forEach(t=>t.classList.toggle("active",t.dataset.mode===m));
    document.querySelectorAll(".query-section").forEach(s=>s.classList.toggle("active",s.id===`mode-${m}`));}
  function resetAll(){document.getElementById("search-input").value="";document.getElementById("search-clear").style.display="none";
    document.querySelectorAll(".pill").forEach(p=>p.classList.toggle("active",p.dataset.val==="All"));STATE.etypeFilter="events";
    document.querySelectorAll(".etype-tab").forEach(t=>t.classList.toggle("active",t.dataset.etype==="events"));
    clearCrossFilter();STATE.arcLayer.removeAll();closeDetail();flyToGlobe();
    if(STATE.allEvents.length)renderList(STATE.allAthletes,STATE.allEvents,`<b>${STATE.allEvents.length}</b> events · <b>${STATE.allAthletes.length}</b> athletes`);}

  /* ════ RENDER LIST ════ */
  function renderList(ath,ev,html){STATE.lastAthletes=ath;STATE.lastEvents=ev;STATE.lastCountHtml=html;applyEtypeFilter();}
  function applyEtypeFilter(){
    const tab=STATE.etypeFilter,cf=STATE.crossFilter;
    let items=tab==="athletes"?(cf?cf.athletes:STATE.lastAthletes):(cf?cf.events:STATE.lastEvents);
    document.querySelectorAll(".etype-tab").forEach(t=>{
      if(t.dataset.etype==="athletes")t.textContent=`Athletes (${(cf?cf.athletes:STATE.lastAthletes).length})`;
      if(t.dataset.etype==="events")t.textContent=`Events (${(cf?cf.events:STATE.lastEvents).length})`;});
    const banner=document.getElementById("cross-filter-banner");
    if(cf){document.getElementById("cross-filter-text").innerHTML=`Related to ${escH(cf.name)}`;banner.style.display="flex";}else banner.style.display="none";
    setCount(STATE.lastCountHtml);
    let h="";const MAX=60;
    if(tab==="athletes"){items.slice(0,MAX).forEach(e=>{const p=e.props;h+=entityCard(e.id,"Athlete","athlete",escH(p.name||"?"),escH([p.sport,p.gender].filter(Boolean).join(" · ")));});}
    else{items.slice(0,MAX).forEach(e=>{const p=e.props;const up=parseEventDate(e)>=Date.now();const badge=up?`<span class="soon-badge">SOON</span>`:"";
      h+=entityCard(e.id,"Event","event",escH(p.name||"?")+badge,escH([p.country,p.city,formatEventDate(e)].filter(Boolean).join(" · ")));});}
    if(!h)h=`<div class="state-box"><span>No ${tab} found</span></div>`;showList(h);
    document.querySelectorAll(".entity-card").forEach(card=>{card.addEventListener("click",()=>{
      const pool=card.dataset.etype==="Athlete"?STATE.allAthletes:STATE.allEvents;
      const ent=pool.find(x=>x.id===card.dataset.id);if(ent)selectEntity(ent,card.dataset.etype,false);});});
  }
  function entityCard(id,et,cls,name,meta){return `<div class="entity-card" data-id="${id}" data-etype="${et}">
    <div class="entity-icon ${cls}">&#9899;</div><div class="entity-info"><div class="entity-name">${name}</div><div class="entity-meta">${meta}</div></div>
    <span class="etype-badge ${cls}">${et}</span></div>`;}
  function clearCrossFilter(){STATE.crossFilter=null;document.getElementById("cross-filter-banner").style.display="none";}

  /* ════ UTILS ════ */
  function parseEventDate(e){const d=e.props.start_time||e.props.start_local_time||"";return d?new Date(String(d)).getTime()||0:0;}
  function formatEventDate(e){const d=e.props.start_time||e.props.start_local_time||"";if(!d)return "—";const s=String(d);return s.length>=10?s.slice(0,10):s;}
  function showList(h){document.getElementById("results-list").innerHTML=h;}
  function setCount(h){document.getElementById("results-count").innerHTML=h;}
  function closeDetail(){document.getElementById("detail-panel").classList.remove("open");if(STATE.view)STATE.view.padding={right:0};clearCrossFilter();applyEtypeFilter();STATE.arcLayer.removeAll();}
  function openDetailPanel(){document.getElementById("detail-panel").classList.add("open");if(STATE.view)STATE.view.padding={right:380};}
  function setBadge(t,c){const b=document.getElementById("kg-badge");b.textContent=t;b.className="kg-badge"+(c?` ${c}`:"");}
  function dp(l,v){return `<div><div class="dp-label">${l}</div><div class="dp-value" title="${escH(String(v))}">${escH(String(v))}</div></div>`;}
  function escH(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
});
