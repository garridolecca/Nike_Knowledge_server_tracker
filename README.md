# Nike Sport Intelligence · ArcGIS Knowledge Graph App

Interactive map app that queries the Nike Knowledge Graph (ArcGIS Enterprise) to explore athlete locations, global sports events, and their relationships.

---

## Stack

| Layer | Technology |
|---|---|
| Map | ArcGIS Maps SDK for JavaScript 4.32 (AMD CDN) |
| Data | ArcGIS Knowledge Graph Server (openCypher queries) |
| Auth | ArcGIS Enterprise Portal token (via `esri/request`) |
| Dev server | VS Code Live Server extension |

---

## Prerequisites

### 1 · VS Code extensions
Install from the Extensions panel (`Ctrl+Shift+X`):
- **Live Server** — `ritwickdey.LiveServer`

### 2 · Browser — accept self-signed certs
The ArcGIS Enterprise deployment uses a self-signed certificate.
**Before opening the app**, visit each URL and click "Advanced → Proceed":

```
https://PS028597.ESRI.COM:6443/arcgis/rest/info?f=json
https://ps028597.esri.com:7443/arcgis/rest/info?f=json
```

### 3 · Portal CORS (if needed)
If login fails due to CORS, add these origins in Portal Admin → Security → Allow Origins:
```
http://127.0.0.1:5500
http://localhost:5500
```

---

## Running locally

1. Open this folder in VS Code (`File → Open Folder`)
2. Right-click `index.html` → **Open with Live Server**
   - Or click the **Go Live** button in the VS Code status bar
3. Browser opens at `http://127.0.0.1:5500`
4. Login with Portal credentials (default: `portaladmin`)

---

## Features

### Query modes (sidebar tabs)

| Tab | What it does |
|---|---|
| **Search** | Live filter by athlete name, sport, nationality, event title, country, venue |
| **Sport** | Click a sport pill → map highlights matching athletes + events |
| **Country** | Click a country → map highlights athletes from that country + events there |

### Map interactions

| Action | Result |
|---|---|
| Click athlete point | Detail panel shows athlete info + their events (via KG `PARTICIPATES_IN`) |
| Click event point | Detail panel shows event info + Nike athletes at that event |
| Click related item | Map zooms to that entity |
| Layer toggles (top-right) | Show/hide Athletes / Events / Venues layers |
| Reset button | Clears all filters, shows all entities |

### Point colors
- 🟠 **Orange** = Athletes (home city locations)
- 🔵 **Blue** = Events (venue coordinates)
- ⚫ **Gray** = Venues

---

## Knowledge Graph Queries Used

```cypher
-- Initial load
MATCH (a:Athlete) RETURN a ORDER BY a.name
MATCH (e:Event)   RETURN e ORDER BY e.start_date
MATCH (v:Venue)   RETURN v

-- Athlete detail: get their events
MATCH (a:Athlete)-[:PARTICIPATES_IN]->(e:Event)
WHERE a.name = $name RETURN a, e

-- Event detail: get Nike athletes
MATCH (a:Athlete)-[:PARTICIPATES_IN]->(e:Event)
WHERE e.event_id = $eid RETURN a, e
```

---

## Project structure

```
nike-kg-app/
├── index.html          HTML shell & layout
├── css/
│   └── styles.css      Nike dark theme, all component styles
├── js/
│   └── app.js          AMD entry point — auth, KG queries, map, UI
├── .vscode/
│   └── settings.json   Live Server & editor configuration
├── .gitignore
└── README.md
```

---

## Pushing to GitHub

```bash
# From the nike-kg-app folder:
git init
git add .
git commit -m "Initial commit: Nike KG app"

# Create repo on GitHub, then:
git remote add origin https://github.com/<your-username>/nike-kg-app.git
git branch -M main
git push -u origin main
```

---

## Configuration

Edit the top of `js/app.js` to change endpoints:

```javascript
const CFG = {
  PORTAL_URL : "https://ps028597.esri.com:7443/arcgis",
  KG_SERVER  : "https://PS028597.ESRI.COM:6443",
  KG_URL     : "https://PS028597.ESRI.COM:6443/arcgis/rest/services/Hosted/Nike/KnowledgeGraphServer",
  // ...
};
```

---

## Knowledge Graph Entity Types

| Type | Count | Geometry |
|---|---|---|
| Athlete | 44 | Home city (Point) |
| Event | 200 | Venue location (Point) |
| Venue | 200 | Physical address (Point) |
| Sport | 29 | — |
| Country | 43 | — |

## Relationships

| Relationship | From → To |
|---|---|
| `PARTICIPATES_IN` | Athlete → Event |
| `COMPETES_IN` | Athlete → Sport |
| `REPRESENTS_COUNTRY` | Athlete → Country |
| `HELD_AT` | Event → Venue |
| `IS_SPORT` | Event → Sport |
| `LOCATED_IN_COUNTRY` | Venue → Country |
