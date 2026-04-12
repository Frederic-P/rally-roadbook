/**
 * route.js — Route calculation, map management, waypoint markers
 *
 * Key changes:
 * - calculateRoute() NEVER removes waypoint markers — that is app.js's job
 * - Double-click on the route line adds a waypoint (single-click no longer does)
 * - Single mousedown + drag still reshapes the route via a via-point
 * - Waypoint markers are tracked and survive route recalculations
 */

class RouteManager {
  constructor(mapEl, fallback) {
    this.FALLBACK = fallback;
    this.map = null;
    this.waypointMarkers = [];
    this.viaPoints       = [];
    this.startPoint      = null;
    this.endPoint        = null;
    this.startMarker     = null;
    this.endMarker       = null;
    this.routeCoords     = [];
    this.routeSteps      = [];

    this._pickMode        = null;
    this._onPickCallback  = null;
    this.onRouteLineDblClick = null;  // (latlng) => void  — double-click adds waypoint
    this.onRouteLineRightClick = null; // (latlng) => void - right-click adds waypoint
    this.onViaDragEnd        = null;  // (latlng) => void  — drag reshapes route

    this._hitLine        = null;
    this._visLine        = null;
    this._routingControl = null;

    this._initMap(mapEl);
  }

  _initMap(mapEl) {

    // Resolve the container element whether mapEl is an id string or an element
    const container = (typeof mapEl === 'string')
      ? document.getElementById(mapEl)
      : mapEl;

    // Hide the map until we know where to centre it
    if (container) container.style.visibility = 'hidden';

    this.map = L.map(container || mapEl, {
      center: this.FALLBACK,
      zoom: 13,
      zoomControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors || RallyRoadbookCreator',
      maxZoom: 19
    }).addTo(this.map);

    // Reveal the map centred on the resolved location
    const revealMap = (center, zoom) => {
      this.map.setView(center, zoom);
      if (container) container.style.visibility = 'visible';
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          revealMap([position.coords.latitude, position.coords.longitude], 13);
        },
        (error) => {
          console.warn('Geolocation failed or denied:', error);
          revealMap(this.FALLBACK, 13);
        },
        {
          enableHighAccuracy: true,
          timeout: 5000,
          maximumAge: 0
        }
      );
    } else {
      // Geolocation API not available
      revealMap(this.FALLBACK, 13);
    }

    this.map.on('click', e => {
      if (this._pickMode) this._handleMapPick(e.latlng);
    });
  }

  async geocode(query) {
    const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await resp.json();
    if (!data.length) throw new Error('Location not found');
    return L.latLng(parseFloat(data[0].lat), parseFloat(data[0].lon));
  }

  async reverseGeocode(latlng) {
    const url  = `https://nominatim.openstreetmap.org/reverse?lat=${latlng.lat}&lon=${latlng.lng}&format=json`;
    const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await resp.json();
    return data.display_name || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  }

  /* ---- PICK MODE ---- */
  startPickMode(mode, callback) {
    this._pickMode       = mode;
    this._onPickCallback = callback;
    document.getElementById('map-mode-indicator').classList.remove('hidden');
    this.map.getContainer().style.cursor = 'crosshair';
  }

  _handleMapPick(latlng) {
    document.getElementById('map-mode-indicator').classList.add('hidden');
    this.map.getContainer().style.cursor = '';
    const mode = this._pickMode;
    this._pickMode = null;
    if (this._onPickCallback) { this._onPickCallback(mode, latlng); this._onPickCallback = null; }
  }

  /* ---- ROUTE CALCULATION ---- */
  /**
   * IMPORTANT: this method does NOT touch waypointMarkers at all.
   * The caller (app.js) is fully responsible for removing and re-adding them.
   */
  async calculateRoute(start, end, viaLatLngs = []) {
    this.startPoint = start;
    this.endPoint   = end;

    // Only clear the route line graphics and endpoint flags
    this._clearRouteLines();
    if (this.startMarker) { this.map.removeLayer(this.startMarker); this.startMarker = null; }
    if (this.endMarker)   { this.map.removeLayer(this.endMarker);   this.endMarker   = null; }

    const waypoints = [
      L.Routing.waypoint(start),
      ...viaLatLngs.map(v => L.Routing.waypoint(v)),
      L.Routing.waypoint(end)
    ];

    if (this._routingControl) {
      this.map.removeControl(this._routingControl);
      this._routingControl = null;
    }

    return new Promise((resolve, reject) => {
      this._routingControl = L.Routing.control({
        waypoints,
        routeWhileDragging: false,
        addWaypoints:        false,
        show:                false,
        lineOptions:         { styles: [] },
        createMarker:        () => null,
        router: L.Routing.osrmv1({
          serviceUrl: 'https://router.project-osrm.org/route/v1',
          profile:    'driving'
        })
      })
      .on('routesfound', e => {
        const route       = e.routes[0];
        this.routeCoords  = route.coordinates;
        this.routeSteps   = this._processSteps(route);
        this._drawInteractiveLine();
        this._placeEndpointMarkers();
        resolve(this.routeSteps);
      })
      .on('routingerror', err => reject(err))
      .addTo(this.map);
    });
  }

  /* ---- DRAW INTERACTIVE ROUTE LINE ---- */
  _drawInteractiveLine() {
    this._clearRouteLines();

    // Visible orange line
    this._visLine = L.polyline(this.routeCoords, {
      color: '#f5a623', weight: 5, opacity: 0.9,
      className: 'route-vis-line'
    }).addTo(this.map);

    // Invisible fat hit-target for interactions
    this._hitLine = L.polyline(this.routeCoords, {
      color: 'transparent', weight: 22, opacity: 0.001,
      className: 'route-hit-line'
    }).addTo(this.map);

    /* 
       DOUBLE-CLICK → add waypoint
       We handle this with a manual timer so we can
       distinguish it cleanly from mousedown-drag.
   */
    let clickTimer  = null;
    let clickCount  = 0;

    this._hitLine.on('click', e => {
      L.DomEvent.stopPropagation(e);
      clickCount++;

      if (clickCount === 1) {
        // Wait briefly to see if a second click follows
        clickTimer = setTimeout(() => {
          clickCount = 0;
          // Single click with no drag → do nothing (drag handles via-points)
        }, 280);
      } else if (clickCount === 2) {
        clearTimeout(clickTimer);
        clickCount = 0;
        // Double-click → add waypoint
        if (this.onRouteLineDblClick) this.onRouteLineDblClick(e.latlng);
      }
    });

    // Right-click -> add waypoint (context menu style interaction)
    this._hitLine.on('contextmenu', e => {
      L.DomEvent.stopPropagation(e);
      if (this.onRouteLineRightClick) this.onRouteLineRightClick(e.latlng);
    });

    /* 
       MOUSEDOWN + DRAG → reshape route via a via-point
     */
    let isDragging = false;
    let dragMarker = null;

    this._hitLine.on('mousedown', e => {
      if (e.originalEvent.button !== 0) return;
      L.DomEvent.stopPropagation(e);
      this.map.dragging.disable();
      isDragging = false;

      dragMarker = L.circleMarker(e.latlng, {
        radius: 7, color: '#fff', fillColor: '#f5a623',
        fillOpacity: 1, weight: 2, zIndexOffset: 2000
      }).addTo(this.map);

      const nearIdx    = this._nearestCoordIdx(e.latlng);
      const savedCoords = [...this.routeCoords];

      const onMouseMove = ev => {
        isDragging = true;
        dragMarker.setLatLng(ev.latlng);
        const preview = [...savedCoords];
        preview[nearIdx] = ev.latlng;
        this._visLine.setLatLngs(preview);
      };

      const onMouseUp = ev => {
        this.map.off('mousemove', onMouseMove);
        this.map.off('mouseup',   onMouseUp);
        this.map.dragging.enable();
        if (dragMarker) { this.map.removeLayer(dragMarker); dragMarker = null; }

        if (isDragging && this.onViaDragEnd) {
          this.onViaDragEnd(ev.latlng);
        }
        isDragging = false;
      };

      this.map.on('mousemove', onMouseMove);
      this.map.on('mouseup',   onMouseUp);
    });
  }

  _clearRouteLines() {
    if (this._hitLine) { this.map.removeLayer(this._hitLine); this._hitLine = null; }
    if (this._visLine) { this.map.removeLayer(this._visLine); this._visLine = null; }
  }

  _nearestCoordIdx(latlng) {
    let best = 0, bestDist = Infinity;
    this.routeCoords.forEach((c, i) => {
      const d = this.map.distance(latlng, c);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  /* ENDPOINT MARKERS */
  _placeEndpointMarkers() {
    const mkFlag = (label, bg) => L.divIcon({
      className: '',
      html: `<div style="font-family:'Barlow Condensed',sans-serif;display:flex;flex-direction:column;align-items:center;pointer-events:none;">
        <div style="background:${bg};color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:1px;">${label}</div>
        <div style="width:2px;height:12px;background:${bg};"></div>
        <div style="width:8px;height:8px;border-radius:50%;background:${bg};margin-top:-1px;"></div>
      </div>`,
      iconSize: [60, 38], iconAnchor: [30, 38]
    });
    this.startMarker = L.marker(this.startPoint, { icon: mkFlag('START',  '#27ae60'), zIndexOffset: 900 }).addTo(this.map);
    this.endMarker   = L.marker(this.endPoint,   { icon: mkFlag('FINISH', '#e74c3c'), zIndexOffset: 900 }).addTo(this.map);
  }

  /* PROCESS ROUTE STEPS -> waypoint data  */
  _processSteps(route) {
    const steps  = [];
    const coords = route.coordinates;
    if (!route.instructions) return steps;

    const relevant = route.instructions.filter(instr => {
      const t = (instr.type || '').toLowerCase();
      return t !== 'depart' && t !== 'arrive';
    });

    const allInstrs = route.instructions;
    const distUpTo  = {};
    let acc = 0;
    allInstrs.forEach(instr => { distUpTo[instr.index] = acc; acc += instr.distance || 0; });

    relevant.forEach((instr, i) => {
      const cIdx   = instr.index;
      const latlng = coords[cIdx];

      const prevIdx = Math.max(0, cIdx - 5);
      const nextIdx = Math.min(coords.length - 1, cIdx + 5);

      const inBearing   = this._bearingBetween(coords[prevIdx], latlng);
      const exitBearing = this._bearingBetween(latlng, coords[nextIdx]);

      const distAB       = instr.distance || 0;
      const prevInstr    = relevant[i - 1];
      const distFromPrev = prevInstr
        ? (distUpTo[cIdx] - distUpTo[prevInstr.index])
        : distUpTo[cIdx];
      // distTotal = distance from start to THIS waypoint dot (the yellow dot).
      // distAB (the forward leg after the dot) is retained internally for
      // recalculating distFromPrev on the next step, but is no longer exposed in the UI.
      const distTotal    = distUpTo[cIdx];

      steps.push({
        coordIdx: cIdx,
        latlng,
        type:        this._classifyManeuver(instr.type, instr.modifier),
        instruction: instr.text || instr.type || 'Maneuver',
        bearing:     exitBearing,
        inBearing,
        distAB,
        distFromPrev,
        distTotal,
        nearCoords: {
          before: coords.slice(Math.max(0, cIdx - 12), cIdx),
          after:  coords.slice(cIdx + 1, Math.min(coords.length, cIdx + 13))
        }
      });
    });

    return steps;
  }

  _classifyManeuver(type, modifier) {
    if (!type) return 'straight';
    const t = type.toLowerCase();
    const m = (modifier || '').toLowerCase();
    if (t === 'depart') return 'start';
    if (t === 'arrive') return 'finish';
    if (t === 'roundabout' || t === 'rotary') {
      if (m.includes('left'))  return 'roundabout-left';
      if (m.includes('right')) return 'roundabout-right';
      return 'roundabout-straight';
    }
    if (t === 'turn') {
      if (m === 'sharp left'  || m === 'left')  return 'turn-left';
      if (m === 'sharp right' || m === 'right') return 'turn-right';
      if (m.includes('slight left')  || m.includes('bear left'))  return 'bear-left';
      if (m.includes('slight right') || m.includes('bear right')) return 'bear-right';
      if (m === 'uturn' || m === 'u-turn') return 'u-turn';
    }
    if (t === 'continue' || t === 'new name') return 'straight';
    if (t === 'fork')         return m.includes('left') ? 'bear-left' : 'bear-right';
    if (t === 'merge')        return 'straight';
    if (t.includes('ramp'))   return m.includes('left') ? 'bear-left' : 'bear-right';
    return 'straight';
  }

  _bearingBetween(a, b) {
    if (!a || !b) return 0;
    const toRad = d => d * Math.PI / 180;
    const lat1  = toRad(a.lat), lat2 = toRad(b.lat);
    const dLng  = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  /* ---- WAYPOINT MARKERS ---- */
  placeWaypointMarker(wp, onClick, onRightClick) {
    const hasData = !!(wp.comment || wp.svgState);
    const icon = L.divIcon({
      className: '',
      html: `<div class="wp-marker-circle${hasData ? ' has-data' : ''}"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8]
    });
    const marker = L.marker(wp.latlng, { icon, zIndexOffset: 500 }).addTo(this.map);
    marker.on('click', e => { L.DomEvent.stopPropagation(e); onClick(wp); });
    if (onRightClick) {
      marker.on('contextmenu', e => {
        L.DomEvent.stopPropagation(e);
        onRightClick(wp, e);
      });
    }
    wp.marker = marker;
    this.waypointMarkers.push(marker);
    return marker;
  }

  updateMarkerStyle(wp) {
    if (!wp.marker) return;
    const el  = wp.marker.getElement();
    if (!el) return;
    const dot = el.querySelector('.wp-marker-circle');
    if (dot) dot.classList.toggle('has-data', !!(wp.comment || wp.svgState));
  }

  /**
   * Re-add all waypoint markers to the map.
   * Called by app.js after every route recalculation so markers are never lost.
   */
  restoreWaypointMarkers(wps, onClickFn, onRightClickFn) {
    // Remove any stale marker references first (safety)
    this.waypointMarkers.forEach(m => {
      try { this.map.removeLayer(m); } catch (_) {}
    });
    this.waypointMarkers = [];

    wps.forEach(wp => {
      if (wp.latlng) this.placeWaypointMarker(wp, onClickFn, onRightClickFn);
    });
  }

  fitRoute() {
    if (this.routeCoords.length > 0)
      this.map.fitBounds(L.latLngBounds(this.routeCoords), { padding: [40, 40] });
  }

  clearRoute() {
    if (this._routingControl) { this.map.removeControl(this._routingControl); this._routingControl = null; }
    this._clearRouteLines();
    this.waypointMarkers.forEach(m => this.map.removeLayer(m));
    this.waypointMarkers = [];
    if (this.startMarker) { this.map.removeLayer(this.startMarker); this.startMarker = null; }
    if (this.endMarker)   { this.map.removeLayer(this.endMarker);   this.endMarker   = null; }
    this.viaPoints.forEach(v => { if (v.marker) this.map.removeLayer(v.marker); });
    this.viaPoints  = [];
    this.routeCoords = [];
    this.routeSteps  = [];
    this.startPoint  = null;
    this.endPoint    = null;
  }

  serialize() {
    return {
      start: this.startPoint ? { lat: this.startPoint.lat, lng: this.startPoint.lng } : null,
      end:   this.endPoint   ? { lat: this.endPoint.lat,   lng: this.endPoint.lng   } : null,
      via:   this.viaPoints.map(v => ({ lat: v.latlng.lat, lng: v.latlng.lng }))
    };
  }

  totalDistance() {
    if (!this.routeSteps.length) return 0;
    return this.routeSteps[this.routeSteps.length - 1].distTotal || 0;
  }
}

window.RouteManager = RouteManager;