# Nike Event Tracker

An interactive web application for tracking and managing Nike's global sporting events using an ArcGIS Enterprise Knowledge Graph. The event-first workflow lets Nike decide which athletes to assign to upcoming events — with intelligent recommendations based on sport, location, and nationality. Explore 44 athletes, 200+ global sporting events, and 200 venues on a dark-themed map with real-time filtering, search, and relationship traversal powered by openCypher streaming queries.

**Live App:** [https://garridolecca.github.io/Nike_Knowledge_server_tracker/](https://garridolecca.github.io/Nike_Knowledge_server_tracker/)

> **VPN Required** — The app connects to an internal ArcGIS Enterprise deployment. You must be on the same VPN to authenticate and access the Knowledge Graph services.

---

## Features

- **Event-First Flow** — Events tab is the default view, sorted with upcoming events first
- **Upcoming Event Badges** — Events within the next 30 days are tagged with a "SOON" badge in the results list
- **Recommended Athletes** — Click an event to see confirmed participants plus AI-recommended athlete assignments based on sport match, city proximity, and country/nationality
- **Reason Tags** — Each recommendation shows why the athlete was suggested: "Same sport", "Based in city", or "From country"
- **Live Search** — Instantly filter athletes by name, sport, or nationality, and events by title, country, or venue
- **Sport Filter** — Select a sport pill to highlight all matching athletes and events on the map
- **Country Filter** — Filter by country to see athletes and events in that region
- **Relationship Exploration** — Click an athlete to see their events (via `PARTICIPATES_IN`), or click an event to see Nike athletes competing there
- **Cross-Filtering** — Selecting an entity reveals related entities across both tabs
- **Layer Toggles** — Show/hide Athletes (orange), Events (blue), and Venues (gray) independently
- **Map Interactions** — Click any point to zoom in and view full details with related entities
- **Detail Panel** — Slide-out panel on the right shows full entity details, confirmed participants, and recommended assignments

## Architecture

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — zero build step |
| Map SDK | ArcGIS Maps SDK for JavaScript 4.32 (AMD/CDN) |
| Data | ArcGIS Knowledge Graph Server (openCypher streaming queries) |
| Auth | ArcGIS Enterprise Portal token-based authentication |
| Hosting | GitHub Pages (static) |

## Knowledge Graph Data Model

```
(Athlete)──[:PARTICIPATES_IN]──>(Event)
(Athlete)──[:COMPETES_IN]──>(Sport)
(Athlete)──[:REPRESENTS_COUNTRY]──>(Country)
(Event)──[:HELD_AT]──>(Venue)
(Event)──[:IS_SPORT]──>(Sport)
(Venue)──[:LOCATED_IN_COUNTRY]──>(Country)
```

| Entity | Count | Geometry |
|---|---|---|
| Athlete | 44 | Home city (Point) |
| Event | 200 | Venue location (Point) |
| Venue | 200 | Physical address (Point) |
| Sport | 29 | — |
| Country | 43 | — |

---

## Getting Started

### Prerequisites

1. **VPN Access** — Connect to the organization VPN that can reach `ps028597.esri.com`
2. **Accept Self-Signed Certificates** — Before using the app, open both URLs below in your browser and accept the certificate warnings:
   - [ArcGIS Server (port 6443)](https://PS028597.ESRI.COM:6443/arcgis/rest/services)
   - [Portal for ArcGIS (port 7443)](https://ps028597.esri.com:7443/arcgis/home/index.html)
3. **Portal Credentials** — You need a valid ArcGIS Enterprise Portal account

### Using the Live App

1. Connect to VPN
2. Accept the self-signed certificates (links above)
3. Open the [live app](https://garridolecca.github.io/Nike_Knowledge_server_tracker/)
4. Log in with your Portal credentials

### Running Locally

1. Clone the repository:
   ```bash
   git clone https://github.com/garridolecca/Nike_Knowledge_server_tracker.git
   cd Nike_Knowledge_server_tracker
   ```
2. Open the folder in VS Code
3. Install the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension
4. Right-click `index.html` → **Open with Live Server**
5. Log in with your Portal credentials

### CORS Configuration

If login fails due to CORS, a Portal administrator must add the app's origin to the allowed origins list:

**Portal Admin** → Security → Allow Origins → add:

| Deployment | Origin to Allow |
|---|---|
| GitHub Pages | `https://garridolecca.github.io` |
| Local (Live Server) | `http://127.0.0.1:5503` |

---

## Project Structure

```
├── index.html            HTML shell, login overlay, sidebar, map container
├── css/
│   └── styles.css        Nike dark theme — all component styles
├── js/
│   └── app.js            Auth, KG queries, map rendering, UI logic
├── .vscode/
│   └── settings.json     Live Server & editor configuration
├── .gitignore
└── README.md
```

## Configuration

To point the app at a different ArcGIS Enterprise deployment, edit the top of `js/app.js`:

```javascript
const CFG = {
  PORTAL_URL : "https://ps028597.esri.com:7443/arcgis",
  KG_SERVER  : "https://PS028597.ESRI.COM:6443",
  KG_URL     : "https://PS028597.ESRI.COM:6443/arcgis/rest/services/Hosted/Nike/KnowledgeGraphServer",
  // ...
};
```

---

## License

Internal use only.
