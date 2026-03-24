# Rally Roadbook Creator

A browser based tool for creating 'Bolletje-Pijltje' styled roadbooks. 

Product is still in development - contains bugs and pending features.

## Features

### Route Planning
- Search addresses or click the map to set Start/End points
- Add multiple 'Via Points' to shape the route
- Uses **OpenStreetMap** and **OSRM** routing
- Automatic detection of maneuvers (turns, roundabouts, junctions, etc...) ==> Waypoints.

### Waypoint Editor
- Click any yellow dot (Waypoint) on the route to open the waypoint editor.
- Auto-generated **bolletje-pijltje** SVG illustration based on route data
- **Draw tools**: line, arrow, circle, text
- **Undo/Redo** possible
- **Icons**: drag & drop or click to place icons on the illustration (SVG icons - better icons are coming.)
- Icons are **scalable, rotatable, and repositionable**
- Add **comments/notes** to each waypoint
- All edits applied to a waypoint are part of the PDF export.

### Distance Data (auto-calculated)
- part of todos to rationalize this.

### Export
- **PDF Export**: landscape A4 table with illustrations, distances, and comments
- **ZIP Export**: complete project data for later restoration (*)
- **ZIP Import**: load a previously saved roadbook (*)

(*): Importing/exporting of a roadbook in progress will require some kind of app-version control and version migration strategy!

### Persistence
- Auto-saves to **browser localStorage** — continue where you left off: (now with prompt, will later add a nicer modalbox for this).