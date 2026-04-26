/**
 * waypoint.js
 *
 * Changes:
 * - StencilManager: click on map in stencil mode → snaps to nearest OSM way via
 *   Overpass → draws green polyline on map → stores geometry on wp.stencilPaths[]
 *   → immediately redraws illustration with dark-grey stencil lines
 * - _redrawFromBounds: always re-filters from the full global route coords so
 *   expanding the rectangle correctly picks up more coords (bug 5 fix)
 * - renderBaseIllustration rotation fix: entry bearing rotated so approach is
 *   always from south (bottom, 6 o'clock) — handled in svg-editor.js
 * - RouteWindowManager: 8 handles, live redraw, waypoint-clamp
 */

/* =====================================================
   WaypointManager
   ===================================================== */
class WaypointManager {
  constructor() {
    this.waypoints    = [];
    this.currentIndex = null;
    this.editor       = null;
  }

  createFromStep(stepData, listIndex) {
    return {
      id:           `wp-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      listIndex,
      latlng:       stepData.latlng,
      type:         stepData.type         || 'straight',
      instruction:  stepData.instruction  || '',
      bearing:      stepData.bearing      || 0,
      inBearing:    stepData.inBearing    || 180,
      distAB:       stepData.distAB       || 0,
      distFromPrev: stepData.distFromPrev || 0,
      distTotal:    stepData.distTotal    || 0,
      comment:      '',
      svgState:     null,
      marker:       null,
      nearCoords:   stepData.nearCoords   || null,
      routeWindowBounds: null,
      stencilPaths: []   // [{ coords: LatLng[], isRoundabout: bool, mapLine: L.Polyline }]
    };
  }

  addWaypoint(wp)    { this.waypoints.push(wp); this._reindex(); }
  removeWaypoint(id) { this.waypoints = this.waypoints.filter(w => w.id !== id); this._reindex(); }
  _reindex()         { this.waypoints.forEach((wp, i) => { wp.listIndex = i; }); }
  getAll()           { return this.waypoints; }

  saveCurrentEditorState(comment) {
    if (this.currentIndex === null) return;
    const wp = this.waypoints[this.currentIndex];
    if (!wp) return;
    wp.comment = comment;
    if (this.editor) wp.svgState = this.editor.getState();
  }

  loadIntoEditor(index, editor) {
    this.currentIndex = index;
    this.editor       = editor;
    const wp = this.waypoints[index];
    if (!wp) return null;
    editor.renderBaseIllustration(wp);
    if (wp.svgState) {
      editor.loadState(wp.svgState);
    } else {
      editor.drawLayer.innerHTML = '';
      editor.iconLayer.innerHTML = '';
    }
    return wp;
  }

  serialize() {
    return this.waypoints.map(({ marker, stencilPaths, ...rest }) => ({
      ...rest,
      // Persist stencil coords but not the live Leaflet polyline objects
      stencilPaths: (stencilPaths || []).map(sp => ({
        coords:       sp.coords,
        isRoundabout: sp.isRoundabout
      }))
    }));
  }

  deserialize(data) {
    this.waypoints = data.map(d => ({ ...d, marker: null, stencilPaths: d.stencilPaths || [] }));
    this._reindex();
    return this.waypoints;
  }

  formatDistance(m) {
    if (m == null || isNaN(m)) return '—';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  }
}


/* =====================================================
   StencilManager
   Handles the "Stencil" map interaction:
   - When active, a click on the map snaps to the nearest
     OSM highway way via Overpass, fetches its full node
     geometry, draws a green L.Polyline on the map, and
     stores the coords on wp.stencilPaths[].
   - Each click = one road segment / roundabout.
   - The illustration is redrawn after each snap.
   ===================================================== */
class StencilManager {
  constructor(map) {
    this._map = map;
    this._active = false;
    this._mode = 'draw'; // 'draw' | 'erase'
    this._wp = null; // current waypoint being edited
    this._onRedraw = null; // () => void  called after each stencil is added
    this._isDrawing = false;
    this._currentLine = null;
    this._currentCoords = [];
  }

  /** Enable stencil mode for a waypoint */
  enable(wp, onRedraw, mode = 'draw') {
    this._wp = wp;
    this._onRedraw = onRedraw;
    this._active = true;

    this.setMode(mode);
    this._lockMap(true); // Disable panning

    // Lock the route window bounding box so it can't be moved while drawing
    if (window.app && window.app._routeWindow) {
      window.app._routeWindow.setLocked(true);
    }

    // Show all previously saved stencil lines for this wp
    (wp.stencilPaths || []).forEach(sp => this._showMapLine(sp));

    if (mode === 'draw') {
      this._map.on('mousedown', this._onMouseDown, this);
      this._map.on('mousemove', this._onMouseMove, this);
      this._map.on('mouseup', this._onMouseUp, this);
    } else {
      // Eraser mode logic remains the same (click on line to remove)
    }
  }

  /** Disable stencil mode */
  disable() {
    if (!this._active) return;
    this._active = false;
    this._lockMap(false); // Re-enable panning

    // Unlock the route window bounding box
    if (window.app && window.app._routeWindow) {
      window.app._routeWindow.setLocked(false);
    }

    this._map.getContainer().style.cursor = '';
    this._map.off('mousedown', this._onMouseDown, this);
    this._map.off('mousemove', this._onMouseMove, this);
    this._map.off('mouseup', this._onMouseUp, this);
    if (this._isDrawing) {
      this._isDrawing = false;
      if (this._currentLine) {
        this._map.removeLayer(this._currentLine);
        this._currentLine = null;
      }
    }
  }
  autoStencil(wp, onRedraw) {
    const bounds = wp.routeWindowBounds;
    if (!bounds) return Promise.reject(new Error('No bounds for auto-stencil'));

    // Keep _wp and _onRedraw in sync so callbacks work
    this._wp = wp;
    this._onRedraw = onRedraw;

    const S = bounds.getSouth(), N = bounds.getNorth(), W = bounds.getWest(), E = bounds.getEast();
    const carRoadTypes = [
      'motorway', 'motorway_link',
      'trunk', 'trunk_link',
      'primary', 'primary_link',
      'secondary', 'secondary_link',
      'tertiary', 'tertiary_link',
      'unclassified',
      'residential',
      'living_street',
      'service',
      'road'
    ].join('|');
    const query = `[out:json][timeout:10];(way["highway"~"^(${carRoadTypes})$"](${S},${W},${N},${E}););out geom;`;

    return fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        return response.json();
      })
      .then(data => {
        const ways = data.elements || [];
        const near = wp.nearCoords || {};
        const routePoints = (near.before || []).concat(near.after || []);
        const routeCoords = new Set(routePoints.map(c => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`));
        let addedCount = 0;

        // Threshold (meters) to consider a stencilled part "connected" to the route
        const connectionThresholdMeters = 12;

        ways.forEach(way => {
          if (way.geometry && way.geometry.length > 0) {
            const coords = way.geometry.map(n => L.latLng(n.lat, n.lon));
            const clippedParts = this._clipCoords(coords, bounds);

            clippedParts.forEach(part => {
              if (part.length < 2) return;

              const isRoundabout = (way.tags && way.tags.junction) === 'roundabout';
              const isRoute = part.some(c => routeCoords.has(`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`));

              // If the part doesn't directly contain a route node, test proximity
              // to the route coordinates. Skip parts that are not connected.
              let isConnected = isRoute;
              if (!isConnected && routePoints.length > 0) {
                outer: for (let i = 0; i < part.length; i++) {
                  for (let j = 0; j < routePoints.length; j++) {
                    if (part[i].distanceTo(routePoints[j]) <= connectionThresholdMeters) {
                      isConnected = true;
                      break outer;
                    }
                  }
                }
              }

              if (!isConnected) return; // do not add stray/unconnected roads

              addedCount++;
              const sp = { coords: part, isRoundabout, isRoute, mapLine: null };
              if (!this._wp.stencilPaths) this._wp.stencilPaths = [];
              this._wp.stencilPaths.push(sp);
              this._showMapLine(sp);
            });
          }
        });
        if (this._onRedraw) this._onRedraw();
        return addedCount;
      });
  }

  /**
   * Clips a polyline against a bounding box using a segment-by-segment approach.
   * Correctly handles the case where both endpoints are outside the box but
   * the segment passes through it (the "pass-through" case the old code missed).
   * Returns an array of clipped polyline coordinate arrays.
   */
  _clipCoords(points, bounds) {
    if (!points || points.length === 0) return [];

    const N = bounds.getNorth(), S = bounds.getSouth();
    const E = bounds.getEast(),  W = bounds.getWest();

    /**
     * Clip a single segment [p1, p2] to the bounding box.
     * Returns { p1, p2 } clipped, or null if fully outside.
     * Uses Liang-Barsky parametric clipping.
     */
    const clipSegment = (p1, p2) => {
      let t0 = 0, t1 = 1;
      const dx = p2.lng - p1.lng;
      const dy = p2.lat - p1.lat;

      // Test each of the 4 edges: p, q pairs for Liang-Barsky
      const tests = [
        { p: -dx, q: p1.lng - W },   // left
        { p:  dx, q: E - p1.lng },   // right
        { p: -dy, q: p1.lat - S },   // bottom
        { p:  dy, q: N - p1.lat },   // top
      ];

      for (const { p, q } of tests) {
        if (p === 0) {
          if (q < 0) return null; // parallel and outside
          continue;
        }
        const t = q / p;
        if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
        else        { if (t < t0) return null; if (t < t1) t1 = t; }
      }

      return {
        p1: L.latLng(p1.lat + t0 * dy, p1.lng + t0 * dx),
        p2: L.latLng(p1.lat + t1 * dy, p1.lng + t1 * dx)
      };
    };

    const clippedLines = [];
    let currentLine = [];

    for (let i = 0; i < points.length - 1; i++) {
      const seg = clipSegment(points[i], points[i + 1]);

      if (!seg) {
        // Segment fully outside — break current line
        if (currentLine.length > 1) clippedLines.push(currentLine);
        currentLine = [];
        continue;
      }

      // Determine whether the original p1 was inside (t0 stayed 0 means p1 unchanged)
      const p1Clipped = !bounds.contains(points[i]);
      const p2Clipped = !bounds.contains(points[i + 1]);

      if (p1Clipped) {
        // Entry into box mid-segment — start a fresh line from the clipped start
        if (currentLine.length > 1) clippedLines.push(currentLine);
        currentLine = [seg.p1];
      } else if (currentLine.length === 0) {
        currentLine.push(seg.p1);
      }

      if (p2Clipped) {
        // Exit from box mid-segment — close the line at the clipped end
        currentLine.push(seg.p2);
        clippedLines.push(currentLine);
        currentLine = [];
      } else {
        currentLine.push(seg.p2);
      }
    }

    if (currentLine.length > 1) clippedLines.push(currentLine);
    return clippedLines.filter(line => line.length > 1);
  }

  _onMouseDown(e) {
    if (!this._active || this._mode !== 'draw') return;
    // Stop the event from reaching Leaflet's drag handler
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    this._isDrawing = true;
    this._currentCoords = [e.latlng];
    this._currentLine = L.polyline([e.latlng], {
      color: '#27ae60',
      weight: 5,
      opacity: 0.7
    }).addTo(this._map);
  }

  _onMouseMove(e) {
    if (!this._isDrawing) return;
    L.DomEvent.stopPropagation(e);
    this._currentCoords.push(e.latlng);
    this._currentLine.setLatLngs(this._currentCoords);
  }

  _onMouseUp(e) {
    if (!this._isDrawing) return;
    L.DomEvent.stopPropagation(e);
    this._isDrawing = false;
    if (this._currentCoords.length > 1) {
      const sp = {
        coords: this._currentCoords,
        isRoundabout: false,
        mapLine: this._currentLine
      };
      if (!this._wp.stencilPaths) this._wp.stencilPaths = [];
      this._wp.stencilPaths.push(sp);
      this._showMapLine(sp); // Re-style and add erase listener
      if (this._onRedraw) this._onRedraw();
    } else {
      this._map.removeLayer(this._currentLine);
    }
    this._currentLine = null;
    this._currentCoords = [];
  }

  setMode(mode) {
    this._mode = mode;
    this._map.getContainer().style.cursor = mode === 'erase' ? 'pointer' : 'crosshair';
  }

  _lockMap(isLocked) {
    if (isLocked) {
      this._map.dragging.disable();
    } else {
      this._map.dragging.enable();
    }
  }

  /** Remove all stencil map lines for the current wp (without deleting the data) */
  hideMapLines() {
    if (!this._wp) return;
    (this._wp.stencilPaths || []).forEach(sp => {
      if (sp.mapLine) {
        this._map.removeLayer(sp.mapLine);
        sp.mapLine = null;
      }
    });
  }

  /** Re-show map lines when editor reopens */
  showMapLines(wp) {
    (wp.stencilPaths || []).forEach(sp => this._showMapLine(sp));
  }

  /** Clear all stencil paths for current wp */
  clearStencils(wp) {
    (wp.stencilPaths || []).forEach(sp => {
      if (sp.mapLine) {
        this._map.removeLayer(sp.mapLine);
        sp.mapLine = null;
      }
    });
    wp.stencilPaths = [];
  }

  _showMapLine(sp) {
    if (!sp.coords || sp.coords.length < 2) return;
    if (sp.mapLine) {
      try {
        this._map.removeLayer(sp.mapLine);
      } catch (_) {}
    }
    sp.mapLine = L.polyline(sp.coords, {
      color: '#27ae60',
      weight: 7, // Thicker to make clicking/erasing easier
      opacity: 0.85,
      lineCap: 'round',
      className: 'stencil-map-line',
      interactive: true
    }).addTo(this._map);

    // Bind click for erasure
    sp.mapLine.on('click', (e) => {
      if (this._active && this._mode === 'erase') {
        L.DomEvent.stopPropagation(e);
        this._removeStencilPath(sp);
      }
    });
  }

  _removeStencilPath(sp) {
    if (!this._wp || !this._wp.stencilPaths) return;
    const idx = this._wp.stencilPaths.indexOf(sp);
    if (idx !== -1) {
      this._wp.stencilPaths.splice(idx, 1);
      if (sp.mapLine) this._map.removeLayer(sp.mapLine);
      if (this._onRedraw) this._onRedraw();
    }
  }

}


/* =====================================================
   RouteWindowManager — 8 handles, live redraw, waypoint-clamp
   ===================================================== */
class RouteWindowManager {
  constructor(map, onBoundsChange) {
    this._map     = map;
    this._cb      = onBoundsChange;
    this._rect    = null;
    this._bounds  = null;
    this._handles = {};
    this._wpLatLng = null;
    this._locked  = false;  // when true, dragging the box is disabled
  }

  /** Lock/unlock the bounding box (used during stencil mode) */
  setLocked(locked) { this._locked = locked; }

  show(bounds, wpLatLng) {
    this._bounds   = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
    this._wpLatLng = wpLatLng || null;
    this._drawRect();
    this._drawHandles();
  }

  hide() {
    this._removeHandles();
    if (this._rect) { this._map.removeLayer(this._rect); this._rect = null; }
    this._bounds = null;
  }

  getBounds() { return this._bounds; }

  _drawRect() {
    if (this._rect) { this._rect.setBounds(this._bounds); return; }

    this._rect = L.rectangle(this._bounds, {
      color: '#f5a623', weight: 2, opacity: 0.9,
      fillColor: '#f5a623', fillOpacity: 0.06,
      dashArray: '6 4', interactive: true, className: 'route-window-rect'
    }).addTo(this._map);

    let startMouse, startBounds;

    this._rect.on('mousedown', (e) => {
      if (e.originalEvent.button !== 0) return;
      if (this._locked) return;  // stencil active — don't allow box drag
      L.DomEvent.stopPropagation(e);
      this._map.dragging.disable();
      startMouse  = this._map.latLngToContainerPoint(e.latlng);
      startBounds = L.latLngBounds(this._bounds.getSouthWest(), this._bounds.getNorthEast());

      const onMove = (ev) => {
        const cur   = this._map.latLngToContainerPoint(ev.latlng);
        const dx    = cur.x - startMouse.x;
        const dy    = cur.y - startMouse.y;
        const swPx  = this._map.latLngToContainerPoint(startBounds.getSouthWest());
        const nePx  = this._map.latLngToContainerPoint(startBounds.getNorthEast());
        let newSW   = this._map.containerPointToLatLng(L.point(swPx.x + dx, swPx.y + dy));
        let newNE   = this._map.containerPointToLatLng(L.point(nePx.x + dx, nePx.y + dy));

        if (this._wpLatLng) {
          const minPad = 0.00005;
          const bH = startBounds.getNorth() - startBounds.getSouth();
          const bW = startBounds.getEast()  - startBounds.getWest();
          let N = newNE.lat, S = newSW.lat, E = newNE.lng, W = newSW.lng;
          if (N < this._wpLatLng.lat + minPad) { N = this._wpLatLng.lat + minPad; S = N - bH; }
          if (S > this._wpLatLng.lat - minPad) { S = this._wpLatLng.lat - minPad; N = S + bH; }
          if (E < this._wpLatLng.lng + minPad) { E = this._wpLatLng.lng + minPad; W = E - bW; }
          if (W > this._wpLatLng.lng - minPad) { W = this._wpLatLng.lng - minPad; E = W + bW; }
          newSW = L.latLng(S, W); newNE = L.latLng(N, E);
        }

        this._bounds = L.latLngBounds(newSW, newNE);
        this._rect.setBounds(this._bounds);
        this._repositionHandles();
        if (this._cb) this._cb(this._bounds);
      };

      const onUp = () => {
        this._map.off('mousemove', onMove);
        this._map.off('mouseup', onUp);
        this._map.dragging.enable();
      };

      this._map.on('mousemove', onMove);
      this._map.on('mouseup', onUp);
    });
  }

  _handlePositions() {
    const b = this._bounds;
    const N = b.getNorth(), S = b.getSouth(), E = b.getEast(), W = b.getWest();
    const mLat = (N + S) / 2, mLng = (E + W) / 2;
    return {
      nw: L.latLng(N, W), n: L.latLng(N, mLng), ne: L.latLng(N, E),
      e:  L.latLng(mLat, E),
      se: L.latLng(S, E), s: L.latLng(S, mLng), sw: L.latLng(S, W),
      w:  L.latLng(mLat, W)
    };
  }

  _drawHandles() {
    this._removeHandles();
    Object.entries(this._handlePositions()).forEach(([id, latlng]) => {
      const isCorner = id.length === 2;
      const h = L.circleMarker(latlng, {
        radius: isCorner ? 7 : 5, color: '#fff', weight: 2,
        fillColor: isCorner ? '#f5a623' : '#ffffff', fillOpacity: 1,
        interactive: true, bubblingMouseEvents: false, className: 'route-window-handle'
      }).addTo(this._map);
      this._handles[id] = h;
      this._bindHandleDrag(h, id);
    });
  }

  _bindHandleDrag(handle, id) {
    handle.on('mousedown', (e) => {
      if (e.originalEvent.button !== 0) return;
      if (this._locked) return;  // stencil active — don't allow handle drag
      L.DomEvent.stopPropagation(e);
      this._map.dragging.disable();

      const onMove = (ev) => {
        const ll = ev.latlng;
        let N = this._bounds.getNorth(), S = this._bounds.getSouth();
        let E = this._bounds.getEast(),  W = this._bounds.getWest();
        if (id.includes('n')) N = ll.lat;
        if (id.includes('s')) S = ll.lat;
        if (id.includes('e')) E = ll.lng;
        if (id.includes('w')) W = ll.lng;
        if (N < S) { const t = N; N = S; S = t; }
        if (E < W) { const t = E; E = W; W = t; }
        if (this._wpLatLng) {
          const minPad = 0.00005;
          if (id.includes('n')) N = Math.max(N, this._wpLatLng.lat + minPad);
          if (id.includes('s')) S = Math.min(S, this._wpLatLng.lat - minPad);
          if (id.includes('e')) E = Math.max(E, this._wpLatLng.lng + minPad);
          if (id.includes('w')) W = Math.min(W, this._wpLatLng.lng - minPad);
        }
        this._bounds = L.latLngBounds([S, W], [N, E]);
        this._rect.setBounds(this._bounds);
        this._repositionHandles();
        if (this._cb) this._cb(this._bounds);
      };

      const onUp = () => {
        this._map.off('mousemove', onMove);
        this._map.off('mouseup', onUp);
        this._map.dragging.enable();
      };

      this._map.on('mousemove', onMove);
      this._map.on('mouseup', onUp);
    });
  }

  _repositionHandles() {
    const pos = this._handlePositions();
    Object.entries(pos).forEach(([id, ll]) => { if (this._handles[id]) this._handles[id].setLatLng(ll); });
  }

  _removeHandles() {
    Object.values(this._handles).forEach(h => this._map.removeLayer(h));
    this._handles = {};
  }
}


/* =====================================================
   WaypointEditorUI — slide-in panel
   ===================================================== */
class WaypointEditorUI {
  constructor(wpManager) {
    this.wpManager     = wpManager;
    this.svgEditor     = null;
    this._routeWindow  = null;
    this._stencilMgr   = null;
    this._currentWp    = null;
    this._stencilActive = false;

    this.panel        = document.getElementById('wp-editor-overlay');
    this.svgEl        = document.getElementById('wp-svg');
    this.commentEl    = document.getElementById('wp-comment');
    this.distPrevEl   = document.getElementById('dist-prev');
    this.distTotalEl  = document.getElementById('dist-total');
    this.iconTree     = document.getElementById('icon-tree');
    this.iconSearch   = document.getElementById('icon-search');
    this.iconProps    = document.getElementById('icon-props');
    this.iconScaleEl  = document.getElementById('icon-scale');
    this.iconScaleVal = document.getElementById('icon-scale-val');
    this.iconRotEl    = document.getElementById('icon-rotation');
    this.iconRotVal   = document.getElementById('icon-rotation-val');

    this._initEditor();
    this._bindUI();
  }

  setRouteWindowManager(rwm) { this._routeWindow = rwm; }

  setStencilManager(sm) { this._stencilMgr = sm; }

  _initEditor() { this.svgEditor = new SVGEditor(this.svgEl); }

  _bindUI() {
    document.getElementById('btn-close-editor').addEventListener('click', () => this.close());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });

    document.getElementById('btn-save-wp').addEventListener('click', () => {
      this.wpManager.saveCurrentEditorState(this.commentEl.value);
      const wp = this.wpManager.waypoints[this.wpManager.currentIndex];
      if (wp) window.routeManager && window.routeManager.updateMarkerStyle(wp);
      this.close();
      window.app && window.app.refreshWaypointList();
      window.app && window.app._saveToStorage();
    });

    document.querySelectorAll('.tool-btn[id^="tool-"]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.svgEditor.setTool(btn.id.replace('tool-', ''));
      });
    });

    document.getElementById('tool-color').addEventListener('input',  e => this.svgEditor.setColor(e.target.value));
    document.getElementById('tool-stroke-width').addEventListener('change', e => this.svgEditor.setStrokeWidth(e.target.value));
    document.getElementById('btn-undo').addEventListener('click',  () => this.svgEditor.undo());
    document.getElementById('btn-redo').addEventListener('click',  () => this.svgEditor.redo());
    document.getElementById('btn-clear-drawing').addEventListener('click', () => {
      if (confirm('Clear all drawings?')) this.svgEditor.clearDrawings();
    });

    /* ---- Stencil button ---- */
    document.getElementById('btn-stencil').addEventListener('click', () => {
      this._toggleStencil();
    });

    document.getElementById('btn-stencil-eraser').addEventListener('click', () => {
      this._toggleStencilEraser();
    });

    document.getElementById('btn-clear-stencil').addEventListener('click', () => {
      if (!this._currentWp) return;
      if (confirm('Remove all stencil roads for this waypoint?')) {
        this._stencilMgr && this._stencilMgr.clearStencils(this._currentWp);
        this.svgEditor.renderBaseIllustration(this._currentWp);
      }
    });

    document.getElementById('btn-auto-stencil').addEventListener('click', (e) => {
      if (!this._currentWp) return;
      const btn = e.currentTarget;

      btn.classList.add('loading');
      btn.disabled = true;

      this._stencilMgr.autoStencil(this._currentWp, () => {
        this.svgEditor.renderBaseIllustration(this._currentWp);
      })
      .then(addedCount => {
        this._showToast(`Added ${addedCount} segments to waypoint illustration`, 'success');
      })
      .catch(err => {
        console.warn('Auto stencil failed:', err);
        this._showToast('Autogeneration failed', 'error');
      })
      .finally(() => {
        btn.classList.remove('loading');
        btn.disabled = false;
      });
    });

    this.iconSearch.addEventListener('input', () => {
      iconManager.renderToContainer(this.iconTree, this.iconSearch.value);
    });
    iconManager.onLoad = () => {
      iconManager.renderToContainer(this.iconTree, '');
    };

    this.iconTree.addEventListener('click', e => {
      const item = e.target.closest('.icon-item');
      if (!item) return;
      const ic = iconManager.getById(item.dataset.iconId);
      if (ic) this.svgEditor.addIcon(ic, 150, 150);
    });

    this.iconTree.addEventListener('dragstart', e => {
      const item = e.target.closest('.icon-item');
      if (item) { e.dataTransfer.setData('iconId', item.dataset.iconId); item.classList.add('dragging'); }
    });
    this.iconTree.addEventListener('dragend', e => {
      const item = e.target.closest('.icon-item');
      if (item) item.classList.remove('dragging');
    });
    this.svgEl.addEventListener('dragover', e => e.preventDefault());
    this.svgEl.addEventListener('drop', e => {
      e.preventDefault();
      const ic = iconManager.getById(e.dataTransfer.getData('iconId'));
      if (!ic) return;
      const rect = this.svgEl.getBoundingClientRect();
      const vb   = this.svgEl.viewBox.baseVal;
      this.svgEditor.addIcon(ic,
        (e.clientX - rect.left) / rect.width  * vb.width,
        (e.clientY - rect.top)  / rect.height * vb.height
      );
    });

    this.iconScaleEl.addEventListener('input', () => {
      const v = parseFloat(this.iconScaleEl.value);
      this.iconScaleVal.textContent = `${v}×`;
      this.svgEditor.setIconScale(v);
    });
    this.iconRotEl.addEventListener('input', () => {
      const v = parseInt(this.iconRotEl.value);
      this.iconRotVal.textContent = `${v}°`;
      this.svgEditor.setIconRotation(v);
    });
    document.getElementById('btn-delete-icon').addEventListener('click', () => {
      this.svgEditor.deleteSelectedIcon();
    });
  }

  _showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) {
        container.remove();
      }
    }, 3000);
  }

  _toggleStencil() {
    const btn = document.getElementById('btn-stencil');
    const btnErase = document.getElementById('btn-stencil-eraser');
    
    // If already in Draw mode, toggle OFF
    if (this._stencilActive && this._stencilMgr._mode === 'draw') {
      this._stencilMgr && this._stencilMgr.disable();
      this._stencilActive = false;
      btn.classList.remove('active');
      btnErase.classList.remove('active');
    } else {
      // If active in Erase mode, switch to Draw; OR if inactive, turn ON Draw
      if (!this._currentWp) return;
      this._stencilActive = true;
      
      btn.classList.add('active');
      btnErase.classList.remove('active'); // Ensure eraser is visually off
      
      // enable() handles logic to switch mode if already active
      this._stencilMgr && this._stencilMgr.enable(this._currentWp, () => { 
        this.svgEditor.renderBaseIllustration(this._currentWp);
      }, 'draw');
    }
  }

  _toggleStencilEraser() {
    const btn = document.getElementById('btn-stencil');
    const btnErase = document.getElementById('btn-stencil-eraser');

    // If already in Erase mode, toggle OFF (or switch to draw? let's toggle off for now)
    if (this._stencilActive && this._stencilMgr._mode === 'erase') {
      this._stencilMgr && this._stencilMgr.disable();
      this._stencilActive = false;
      btn.classList.remove('active');
      btnErase.classList.remove('active');
    } else {
      // If active in Draw mode, switch to Erase; OR if inactive, turn ON Erase
      if (!this._currentWp) return;
      this._stencilActive = true;
      
      btnErase.classList.add('active');
      btn.classList.remove('active'); // Ensure draw btn is visually off
      
      this._stencilMgr && this._stencilMgr.enable(this._currentWp, () => {
        this.svgEditor.renderBaseIllustration(this._currentWp);
      }, 'erase');
    }
  }

  /*  open */
  open(waypointIndex) {
    const wp = this.wpManager.loadIntoEditor(waypointIndex, this.svgEditor);
    if (!wp) return;
    this._currentWp = wp;

    // Stop any active stencil from previous waypoint
    if (this._stencilActive) {
      this._stencilMgr && this._stencilMgr.disable();
      this._stencilActive = false;
      const btn = document.getElementById('btn-stencil');
      if (btn) { btn.classList.remove('active'); btn.textContent = 'Stencil'; }
    }

    this.commentEl.value   = wp.comment || '';
    this.distPrevEl.value  = this.wpManager.formatDistance(wp.distFromPrev);
    this.distTotalEl.value = this.wpManager.formatDistance(wp.distTotal);

    document.getElementById('wp-editor-header').querySelector('h2').textContent =
      `Waypoint ${waypointIndex + 1} — ${wp.instruction || wp.type}`;

    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    this.svgEditor.setTool('select');
    this.iconProps.classList.add('hidden');

    this.panel.classList.remove('hidden');
    void this.panel.offsetWidth;
    this.panel.classList.add('open');
    document.getElementById('wp-editor-backdrop').classList.remove('hidden');

    this._focusMapOnWaypoint(wp);

    // Re-show stencil map lines for this waypoint
    this._stencilMgr && this._stencilMgr.showMapLines(wp);
  }

  /* map focus + route window */
  _focusMapOnWaypoint(wp) {
    if (!wp.latlng || !this._routeWindow) return;
    const map = window.routeManager && window.routeManager.map;
    if (!map) return;

    map.setView(wp.latlng, Math.max(map.getZoom(), 15), { animate: true });

    const bounds = this._computeWindowBounds(wp);
    wp.routeWindowBounds = bounds;

    this._routeWindow._cb = (newBounds) => {
      wp.routeWindowBounds = newBounds;
      this._redrawFromBounds(wp, newBounds);
    };

    this._routeWindow.show(bounds, wp.latlng);
    this._redrawFromBounds(wp, bounds);
  }

  _computeWindowBounds(wp) {
    if (wp.routeWindowBounds) {
      // If from JSON, it might be a plain object. Re-create it as a Leaflet object.
      if (wp.routeWindowBounds._southWest && wp.routeWindowBounds._northEast) {
        return L.latLngBounds(wp.routeWindowBounds._southWest, wp.routeWindowBounds._northEast);
      }
      // Otherwise, it might be a valid Leaflet object already.
      return wp.routeWindowBounds;
    }

    const before = (wp.nearCoords && wp.nearCoords.before) ? wp.nearCoords.before : [];
    const after  = (wp.nearCoords && wp.nearCoords.after)  ? wp.nearCoords.after  : [];
    const all    = [...before, wp.latlng, ...after].filter(Boolean);

    if (all.length >= 2) {
      const lats = all.map(p => p.lat), lngs = all.map(p => p.lng);
      const pad  = 0.0003;
      return L.latLngBounds(
        [Math.min(...lats) - pad, Math.min(...lngs) - pad],
        [Math.max(...lats) + pad, Math.max(...lngs) + pad]
      );
    }

    const { lat, lng } = wp.latlng;
    return L.latLngBounds([lat - 0.001, lng - 0.0015], [lat + 0.001, lng + 0.0015]);
  }

  /**
   * Bug 5 fix: ALWAYS re-filter from the complete global route coords.
   * The old code kept stale nearCoords when the rectangle was expanded.
   * Now we always use the current bounds to slice the global route,
   * and use a generous pad so points near the edge are included.
   */
  _redrawFromBounds(wp, bounds) {
    const allRouteCoords = window.routeManager && window.routeManager.routeCoords;

    if (allRouteCoords && allRouteCoords.length >= 2) {
      // Slightly expanded bounds to catch coords sitting exactly on the edge
      const pad = 0.00001;
      const expandedBounds = L.latLngBounds(
        [bounds.getSouth() - pad, bounds.getWest() - pad],
        [bounds.getNorth() + pad, bounds.getEast() + pad]
      );

      const inside = allRouteCoords.filter(c => expandedBounds.contains(c));

      if (inside.length >= 2) {
        const map = window.routeManager.map;
        let bestIdx = 0, bestDist = Infinity;
        inside.forEach((c, i) => {
          const d = map.distance(c, wp.latlng);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        });
        wp.nearCoords = {
          before: inside.slice(0, bestIdx),
          after:  inside.slice(bestIdx + 1)
        };
      }
      // If still < 2 inside (rect too small), keep existing nearCoords
    }

    this.svgEditor.renderBaseIllustration(wp);
  }

  /* ---- close ---- */
  close() {
    // Stop stencil mode
    if (this._stencilActive) {
      this._stencilMgr && this._stencilMgr.disable();
      this._stencilActive = false;
      const btn = document.getElementById('btn-stencil');
      if (btn) { btn.classList.remove('active'); btn.textContent = 'Stencil'; }
      document.getElementById('btn-stencil-eraser').classList.remove('active');
    }

    // Hide stencil map lines
    this._stencilMgr && this._currentWp && this._stencilMgr.hideMapLines();

    this.panel.classList.remove('open');
    document.getElementById('wp-editor-backdrop').classList.add('hidden');
    if (this._routeWindow) this._routeWindow.hide();
    this._currentWp = null;

    this.panel.addEventListener('transitionend', () => {
      this.panel.classList.add('hidden');
    }, { once: true });
  }

  showIconProps({ scale, rotation }) {
    this.iconProps.classList.remove('hidden');
    this.iconScaleEl.value        = scale;
    this.iconScaleVal.textContent = `${scale}×`;
    this.iconRotEl.value          = rotation;
    this.iconRotVal.textContent   = `${rotation}°`;
  }
  hideIconProps() { this.iconProps.classList.add('hidden'); }
}

/* =====================================================
   ViaEditorPanel
   A slide-in panel (from the left, same motion as
   WaypointEditorUI) for editing a via-point's note
   and PDF-include flag.
   ===================================================== */
class ViaEditorPanel {
  constructor() {
    this._via      = null;  // the via-point object currently being edited
    this._onSave   = null;  // () => void  called whenever data changes
    this._panel    = null;
    this._backdrop = null;
    this._build();
  }

  /* ---- DOM construction ---- */
  _build() {
    /* Backdrop */
    this._backdrop = document.createElement('div');
    this._backdrop.id = 'via-editor-backdrop';
    this._backdrop.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:1100',
      'background:rgba(0,0,0,0.45)', 'backdrop-filter:blur(2px)',
      'display:none', 'opacity:0', 'transition:opacity 0.25s'
    ].join(';');
    this._backdrop.addEventListener('click', () => this.close());
    document.body.appendChild(this._backdrop);

    /* Panel — slides in from the left */
    this._panel = document.createElement('div');
    this._panel.id = 'via-editor-panel';
    this._panel.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'bottom:0',
      'width:340px', 'max-width:92vw',
      'z-index:1101',
      'background:var(--panel-bg,#151a28)',
      'border-right:1px solid var(--border,#2a3048)',
      'display:flex', 'flex-direction:column',
      'transform:translateX(-100%)',
      'transition:transform 0.28s cubic-bezier(0.4,0,0.2,1)',
      'box-shadow:4px 0 32px rgba(0,0,0,0.55)'
    ].join(';');
    document.body.appendChild(this._panel);

    /* Header */
    const header = document.createElement('div');
    header.id = 'via-editor-header';
    header.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:14px 16px 12px',
      'background:var(--header-bg,#0f1117)',
      'border-bottom:1px solid var(--border,#2a3048)',
      'flex-shrink:0'
    ].join(';');

    this._titleEl = document.createElement('h2');
    this._titleEl.style.cssText = 'margin:0;font-size:15px;font-weight:700;color:var(--accent,#f5a623);letter-spacing:0.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;';
    this._titleEl.textContent = 'Via Point';

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = [
      'background:none', 'border:none', 'color:var(--text-muted,#8888aa)',
      'font-size:20px', 'cursor:pointer', 'line-height:1', 'padding:0 2px',
      'flex-shrink:0'
    ].join(';');
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());

    header.appendChild(this._titleEl);
    header.appendChild(closeBtn);
    this._panel.appendChild(header);

    /* Body */
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:20px 18px;display:flex;flex-direction:column;gap:20px;';

    /* ── Location info ── */
    this._locationEl = document.createElement('div');
    this._locationEl.style.cssText = [
      'font-size:11px', 'color:var(--text-muted,#8888aa)',
      'background:var(--input-bg,#10141e)',
      'border:1px solid var(--border,#2a3048)',
      'border-radius:6px', 'padding:8px 10px', 'line-height:1.5'
    ].join(';');
    body.appendChild(this._locationEl);

    /* ── Note field ── */
    const noteSection = document.createElement('div');
    noteSection.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    const noteLabel = document.createElement('label');
    noteLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text,#e0e0f0);letter-spacing:0.3px;';
    noteLabel.textContent = 'Note';

    this._noteEl = document.createElement('textarea');
    this._noteEl.placeholder = 'Add a note for this via point…';
    this._noteEl.rows = 5;
    this._noteEl.style.cssText = [
      'width:100%', 'box-sizing:border-box',
      'resize:vertical', 'min-height:100px',
      'background:var(--input-bg,#10141e)',
      'color:var(--text,#e0e0f0)',
      'border:1px solid var(--border,#2a3048)',
      'border-radius:6px',
      'padding:8px 10px',
      'font-size:13px', 'font-family:inherit', 'line-height:1.5',
      'transition:border-color 0.15s'
    ].join(';');
    this._noteEl.addEventListener('focus', () => {
      this._noteEl.style.borderColor = 'var(--accent,#f5a623)';
      this._noteEl.style.outline = 'none';
    });
    this._noteEl.addEventListener('blur',  () => {
      this._noteEl.style.borderColor = 'var(--border,#2a3048)';
    });
    this._noteEl.addEventListener('input', () => {
      if (this._via) {
        this._via.note = this._noteEl.value;
        if (this._onSave) this._onSave();
      }
    });

    noteSection.appendChild(noteLabel);
    noteSection.appendChild(this._noteEl);
    body.appendChild(noteSection);

    /* ── PDF include toggle ── */
    const pdfSection = document.createElement('div');
    pdfSection.style.cssText = [
      'display:flex', 'align-items:flex-start', 'gap:12px',
      'background:var(--input-bg,#10141e)',
      'border:1px solid var(--border,#2a3048)',
      'border-radius:8px', 'padding:12px 14px'
    ].join(';');

    this._pdfCheckEl = document.createElement('input');
    this._pdfCheckEl.type = 'checkbox';
    this._pdfCheckEl.style.cssText = [
      'width:17px', 'height:17px', 'margin-top:1px', 'flex-shrink:0',
      'accent-color:var(--accent,#f5a623)', 'cursor:pointer'
    ].join(';');
    this._pdfCheckEl.addEventListener('change', () => {
      if (this._via) {
        this._via.includeInPDF = this._pdfCheckEl.checked;
        if (this._onSave) this._onSave();
      }
    });

    const pdfTextWrap = document.createElement('div');
    pdfTextWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    const pdfLabel = document.createElement('label');
    pdfLabel.style.cssText = 'font-size:13px;font-weight:600;color:var(--text,#e0e0f0);cursor:pointer;';
    pdfLabel.textContent = 'Include in PDF';
    pdfLabel.addEventListener('click', () => {
      this._pdfCheckEl.click();
    });

    const pdfHint = document.createElement('span');
    pdfHint.style.cssText = 'font-size:11px;color:var(--text-muted,#8888aa);line-height:1.4;';
    pdfHint.textContent = 'Include this via point as a row in the exported roadbook PDF.';

    pdfTextWrap.appendChild(pdfLabel);
    pdfTextWrap.appendChild(pdfHint);
    pdfSection.appendChild(this._pdfCheckEl);
    pdfSection.appendChild(pdfTextWrap);
    body.appendChild(pdfSection);

    /* ── Done button ── */
    const doneBtn = document.createElement('button');
    doneBtn.style.cssText = [
      'margin-top:auto',
      'width:100%', 'padding:11px',
      'background:var(--accent,#f5a623)',
      'color:#1a1a2e', 'border:none', 'border-radius:7px',
      'font-size:13px', 'font-weight:700', 'letter-spacing:0.5px',
      'text-transform:uppercase', 'cursor:pointer',
      'transition:opacity 0.15s'
    ].join(';');
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('mouseenter', () => { doneBtn.style.opacity = '0.85'; });
    doneBtn.addEventListener('mouseleave', () => { doneBtn.style.opacity = '1'; });
    doneBtn.addEventListener('click', () => this.close());
    body.appendChild(doneBtn);

    this._panel.appendChild(body);
  }

  /* ---- public API ---- */

  /**
   * Open the panel for a given via-point object.
   * @param {object} via        — the via-point data object from app.viaPoints
   * @param {number} num        — 1-based display number
   * @param {function} onSave   — called each time note/checkbox changes
   */
  open(via, num, onSave) {
    this._via    = via;
    this._onSave = onSave;

    /* Populate fields */
    this._titleEl.textContent    = `Via Point ${num}`;
    this._locationEl.textContent = via.label || `Via ${num}`;
    this._noteEl.value           = via.note || '';
    this._pdfCheckEl.checked     = !!via.includeInPDF;

    /* Show backdrop + slide panel in */
    this._backdrop.style.display = 'block';
    void this._backdrop.offsetWidth;   // force reflow
    this._backdrop.style.opacity = '1';

    this._panel.style.display = 'flex';
    void this._panel.offsetWidth;      // force reflow
    this._panel.style.transform = 'translateX(0)';

    /* Focus the textarea after the transition */
    setTimeout(() => this._noteEl.focus(), 300);
  }

  close() {
    this._panel.style.transform = 'translateX(-100%)';
    this._backdrop.style.opacity = '0';

    this._panel.addEventListener('transitionend', () => {
      this._panel.style.display = 'none';
      this._backdrop.style.display = 'none';
    }, { once: true });

    this._via    = null;
    this._onSave = null;
  }
}

window.WaypointManager    = WaypointManager;
window.WaypointEditorUI   = WaypointEditorUI;
window.RouteWindowManager = RouteWindowManager;
window.StencilManager     = StencilManager;
window.ViaEditorPanel     = ViaEditorPanel;