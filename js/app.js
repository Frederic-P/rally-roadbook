class App {
  constructor() {
    this.appVersion = '0.0.0'; 

    this.routeManager  = new RouteManager(document.getElementById('map'));
    this.wpManager     = new WaypointManager();
    this.editorUI      = new WaypointEditorUI(this.wpManager);
    this.exportManager = new ExportManager(this.wpManager, this.routeManager);

    this._routeWindow = new RouteWindowManager(this.routeManager.map, () => {});
    this.editorUI.setRouteWindowManager(this._routeWindow);

    // StencilManager lives on the map; wire into the editor
    this._stencilMgr = new StencilManager(this.routeManager.map);
    this.editorUI.setStencilManager(this._stencilMgr);

    this.viaPoints  = [];
    this.startLabel = '';
    this.endLabel   = '';

    // Shared marker-click handler — always the same reference
    this._markerClickFn = (clickedWP) => {
      const idx = this.wpManager.waypoints.indexOf(clickedWP);
      if (idx !== -1) this._openWaypoint(idx);
    };

    // Shared marker-contextmenu handler (Right Click)
    this._markerRightClickFn = (clickedWP, event) => {
      this._showWaypointContextMenu(clickedWP, event.latlng);
    };

    // Wire double-click on route line -> add waypoint
    this.routeManager.onRouteLineDblClick = (latlng) => this._onRouteLineDblClick(latlng);
    this.routeManager.onRouteLineRightClick = (latlng) => this._onRouteLineDblClick(latlng);
    this.routeManager.onViaDragEnd        = (latlng) => this._onViaDragEnd(latlng);

    window.routeManager = this.routeManager;
    window.app = this;

    this._bindUI();
    this._loadFromStorage();
  }

  /* UI BINDINGS */
  _bindUI() {
    ['input-start', 'input-end'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') this._calcRoute();
      });
    });

    document.getElementById('btn-pick-start').addEventListener('click', () => {
      this.routeManager.startPickMode('start', async (mode, latlng) => {
        const label = await this.routeManager.reverseGeocode(latlng);
        document.getElementById('input-start').value = label;
        this.routeManager.startPoint = latlng;
        this.startLabel = label;
      });
    });

    document.getElementById('btn-pick-end').addEventListener('click', () => {
      this.routeManager.startPickMode('end', async (mode, latlng) => {
        const label = await this.routeManager.reverseGeocode(latlng);
        document.getElementById('input-end').value = label;
        this.routeManager.endPoint = latlng;
        this.endLabel = label;
      });
    });

    document.getElementById('btn-calc-route').addEventListener('click', () => this._calcRoute());

    document.getElementById('btn-add-via').addEventListener('click', () => {
      this.routeManager.startPickMode('via', async (mode, latlng) => {
        await this._addViaPoint(latlng);
      });
    });

    document.getElementById('btn-new-route').addEventListener('click', () => {
      if (confirm('Start a new route? All unsaved data will be cleared.')) this._clearAll();
    });

    document.getElementById('btn-save-zip').addEventListener('click', () => {
      if (!this.wpManager.getAll().length) { alert('No route yet.'); return; }
      this._showLoading('Generating ZIP…');
      this.exportManager.exportZIP().finally(() => this._hideLoading());
    });

    document.getElementById('btn-load-zip').addEventListener('click', () => {
      document.getElementById('input-load-zip').click();
    });
    document.getElementById('input-load-zip').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      this._showLoading('Loading roadbook…');
      this.exportManager.importZIP(file)
        .then(({ routeData, wpData }) => this._restoreFromData(routeData, wpData))
        .catch(err => alert('Error loading ZIP: ' + err.message))
        .finally(() => this._hideLoading());
      e.target.value = '';
    });

    document.getElementById('btn-export-pdf').addEventListener('click', () => {
      if (!this.wpManager.getAll().length) { alert('No waypoints yet.'); return; }
      this._showLoading('Generating PDF…');
      this.exportManager.exportPDF().finally(() => this._hideLoading());
    });

    document.getElementById('btn-export-gpx').addEventListener('click', () => {
      if (!this.wpManager.getAll().length) { alert('No waypoints yet.'); return; }
      this._showLoading('Generating GPX…');
      this.exportManager.exportGPX().finally(() => this._hideLoading());
    });

    // Delete button in editor
    document.getElementById('btn-delete-wp').addEventListener('click', () => {
      if (this.wpManager.currentIndex === null) return;
      const wp = this.wpManager.waypoints[this.wpManager.currentIndex];
      if (confirm('Permanently delete this waypoint?')) {
        this._deleteWaypoint(wp);
      }
    });
  }

  /*  DOUBLE-CLICK ON ROUTE LINE -> add manual waypoint */
  async _onRouteLineDblClick(latlng) {
    const coords     = this.routeManager.routeCoords;
    const nearIdx    = this.routeManager._nearestCoordIdx(latlng);
    const snapLatlng = coords[nearIdx] || latlng;

    const prevIdx    = Math.max(0, nearIdx - 4);
    const nextIdx    = Math.min(coords.length - 1, nearIdx + 4);
    const inBearing  = this.routeManager._bearingBetween(coords[prevIdx], snapLatlng);
    const exitBearing = this.routeManager._bearingBetween(snapLatlng, coords[nextIdx]);

    const distToHere = this._estimateDistToCoord(nearIdx);
    let insertAt = this.wpManager.waypoints.findIndex(wp => wp.distTotal > distToHere);
    if (insertAt === -1) insertAt = this.wpManager.waypoints.length;

    const stepData = {
      latlng:       snapLatlng,
      type:         'straight',
      instruction:  'Added waypoint',
      bearing:      exitBearing,
      inBearing,
      distAB:       0,
      distFromPrev: 0,
      distTotal:    distToHere,
      nearCoords: {
        before: coords.slice(Math.max(0, nearIdx - 12), nearIdx),
        after:  coords.slice(nearIdx + 1, Math.min(coords.length, nearIdx + 13))
      }
    };

    const wp = this.wpManager.createFromStep(stepData, insertAt);
    this.wpManager.waypoints.splice(insertAt, 0, wp);
    this.wpManager._reindex();

    // Place this single new marker directly — no full restore needed
    this.routeManager.placeWaypointMarker(wp, this._markerClickFn, this._markerRightClickFn);

    this.refreshWaypointList();
    this._updateStats();
    this._saveToStorage();
  }

  _estimateDistToCoord(coordIdx) {
    let d = 0;
    const coords = this.routeManager.routeCoords;
    for (let i = 1; i <= coordIdx && i < coords.length; i++) {
      d += this.routeManager.map.distance(coords[i - 1], coords[i]);
    }
    return d;
  }

  /* VIA PONTS
  //TODO; via points need addresses at some point
  //TODO: smarter viapoints
  */
  async _onViaDragEnd(latlng) { await this._addViaPoint(latlng, true); }

  async _addViaPoint(latlng, fromDrag = false) {
    const label = fromDrag
      ? `Via ${this.viaPoints.length + 1}`
      : await this.routeManager.reverseGeocode(latlng);

    const viaIcon = L.divIcon({
      className: '',
      html: `<div style="width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid #aaa;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6]
    });
    const marker = L.marker(latlng, { icon: viaIcon, draggable: true, zIndexOffset: 300 })
      .addTo(this.routeManager.map);

    marker.on('dragend', async () => {
      const idx = this.viaPoints.findIndex(v => v.marker === marker);
      if (idx !== -1) {
        this.viaPoints[idx].latlng = marker.getLatLng();
        await this._calcRoute();
      }
    });

    marker.on('contextmenu', async () => {
      const idx = this.viaPoints.findIndex(v => v.marker === marker);
      if (idx !== -1) {
        this.routeManager.map.removeLayer(marker);
        this.viaPoints.splice(idx, 1);
        this._renderViaList();
        await this._calcRoute();
      }
    });

    this.viaPoints.push({ latlng, label, marker });
    this._renderViaList();
    await this._calcRoute();
  }

  /* OPEN WAYPOINT EDITOR */
  _openWaypoint(index) { this.editorUI.open(index); }

  /* Route calcuation */
  async _calcRoute() {
    let start      = this.routeManager.startPoint;
    let end        = this.routeManager.endPoint;
    const startInput = document.getElementById('input-start').value.trim();
    const endInput   = document.getElementById('input-end').value.trim();

    if (!start && !startInput) { alert('Please set a start point.'); return; }  //TODO remove alert() and use modal
    if (!end   && !endInput)   { alert('Please set an end point.');   return; } //TODO remove alert() and use modal

    this._showLoading('Calculating route…');

    try {
      if (!start && startInput) {
        start = await this.routeManager.geocode(startInput);
        this.routeManager.startPoint = start;
        this.startLabel = startInput;
      }
      if (!end && endInput) {
        end = await this.routeManager.geocode(endInput);
        this.routeManager.endPoint = end;
        this.endLabel = endInput;
      }

      const viaLatLngs = this.viaPoints.map(v => v.latlng);

      // Snapshot existing annotations before route wipes step data
      const existingWPs = this.wpManager.serialize();
      this.wpManager.waypoints = [];

      // calculateRoute() only redraws the line + endpoint flags
      // It does NOT touch waypoint markers
      const steps = await this.routeManager.calculateRoute(start, end, viaLatLngs);

      // Rebuild waypoint list, restoring saved annotations
      steps.forEach((s, i) => {
        const wp    = this.wpManager.createFromStep(s, i);
        const match = existingWPs.find(e =>
          e.latlng && wp.latlng &&
          Math.abs(e.latlng.lat - wp.latlng.lat) < 0.0002 &&
          Math.abs(e.latlng.lng - wp.latlng.lng) < 0.0002
        );
        if (match) {
          wp.comment           = match.comment;
          wp.svgState          = match.svgState;
          wp.routeWindowBounds = match.routeWindowBounds || null;
        }
        this.wpManager.addWaypoint(wp);
      });

      // Also restore any manually-added waypoints that aren't route steps
      // (matched by proximity; already handled above if they were preserved)

      // Re-place ALL markers in one shot — this is the only place markers are (re)created
      this.routeManager.restoreWaypointMarkers(
        this.wpManager.getAll(),
        this._markerClickFn,
        this._markerRightClickFn
      );

      this.routeManager.fitRoute();
      this.refreshWaypointList();
      this._updateStats();
      this._saveToStorage();

    } catch (err) {
      console.error(err);
      alert('Route error: ' + (err.message || err));    //TODO remove alert() and use modal
    } finally {
      this._hideLoading();
    }
  }

  /* List of via points. */
  _renderViaList() {
    const list = document.getElementById('via-points-list');
    list.innerHTML = '';
    this.viaPoints.forEach((v, i) => {
      const item = document.createElement('div');
      item.className = 'via-item';
      const label = v.label.length > 28 ? v.label.substring(0, 28) + '…' : v.label;
      item.innerHTML = `
        <span title="${v.label}">${label}</span>
        <button class="via-remove" title="Remove">✕</button>
      `;
      item.querySelector('.via-remove').addEventListener('click', async () => {
        if (v.marker) this.routeManager.map.removeLayer(v.marker);
        this.viaPoints.splice(i, 1);
        this._renderViaList();
        await this._calcRoute();
      });
      list.appendChild(item);
    });
  }

  /* List of route actions (waypoints) */
  refreshWaypointList() {
    const list  = document.getElementById('waypoints-list');
    const count = document.getElementById('wp-count');
    const wps   = this.wpManager.getAll();
    count.textContent = wps.length;
    list.innerHTML = '';

    wps.forEach((wp, i) => {
      const item = document.createElement('div');
      item.className = `wp-list-item${wp.comment || wp.svgState ? ' has-comment' : ''}`;
      item.innerHTML = `
        <div class="wp-dot-mini"></div>
        <span class="wp-list-label">${i + 1}. ${wp.instruction || wp.type}</span>
        <span class="wp-list-dist">${this.wpManager.formatDistance(wp.distTotal)}</span>
      `;
      item.addEventListener('click', () => this._openWaypoint(i));
      list.appendChild(item);
    });
  }

  _updateStats() {
    document.getElementById('stat-distance').textContent =
      this.wpManager.formatDistance(this.routeManager.totalDistance());
    document.getElementById('stat-wps').textContent = this.wpManager.getAll().length;
  }

  /* Icon gallery */
  showIconProps(props) { this.editorUI.showIconProps(props); }
  hideIconProps()      { this.editorUI.hideIconProps(); }

  /* modify waypoints on mouse clicks. */
  _showWaypointContextMenu(wp, latlng) {
    const container = document.createElement('div');
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.cssText = 'background:#e74c3c;color:#fff;border:none;padding:6px 12px;cursor:pointer;width:100%;font-size:13px;border-radius:4px;';
    btn.textContent = 'Delete Waypoint';
    btn.onclick = () => {
      this.routeManager.map.closePopup();
      if (confirm('Delete this waypoint?')) this._deleteWaypoint(wp);
    };
    container.appendChild(btn);

    L.popup({ offset: [0, -4] })
      .setLatLng(latlng)
      .setContent(container)
      .openOn(this.routeManager.map);
  }

  _deleteWaypoint(wp) {
    if (this.editorUI._currentWp === wp) this.editorUI.close();
    this.wpManager.removeWaypoint(wp.id);
    this.routeManager.restoreWaypointMarkers(this.wpManager.getAll(), this._markerClickFn, this._markerRightClickFn);
    this.refreshWaypointList();
    this._updateStats();
    this._saveToStorage();
  }

  /* Clear when starting a new route: */
  _clearAll() {
    //BUG: does not clear the drawn routes produced by the overpass api
    this.viaPoints.forEach(v => { if (v.marker) this.routeManager.map.removeLayer(v.marker); });
    this.viaPoints = [];
    this.routeManager.clearRoute();   // this DOES clear waypoint markers (intentional full reset)
    this.wpManager.waypoints = [];
    this.startLabel = '';
    this.endLabel   = '';
    document.getElementById('input-start').value = '';
    document.getElementById('input-end').value   = '';
    this._renderViaList();
    this.refreshWaypointList();
    this._updateStats();
    this._saveToStorage();
  }

  /* use local browser storage: let the user resume when tehy revisit later. */
  _saveToStorage() {
    try {
      localStorage.setItem('rally-roadbook-save', JSON.stringify({
        route:      this.routeManager.serialize(),
        waypoints:  this.wpManager.serialize(),
        via:        this.viaPoints.map(v => ({ lat: v.latlng.lat, lng: v.latlng.lng, label: v.label })),
        startLabel: this.startLabel,
        endLabel:   this.endLabel
      }));
    } catch (e) { console.warn('localStorage save failed:', e); }
  }

  _loadFromStorage() {
    try {
      const raw = localStorage.getItem('rally-roadbook-save');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.waypoints && data.waypoints.length > 0) {
        if (confirm(`Restore saved route with ${data.waypoints.length} waypoints?`)) {                      //TODO: replace with a nice modal.
          this._restoreFromData(data.route, data.waypoints, data.via, data.startLabel, data.endLabel);
        }
      }
    } catch (e) { console.warn('localStorage load failed:', e); }
  }

  async _restoreFromData(routeData, wpData, via = [], startLabel = '', endLabel = '') {
    this._showLoading('Restoring route…');
    try {
      if (startLabel) { document.getElementById('input-start').value = startLabel; this.startLabel = startLabel; }
      if (endLabel)   { document.getElementById('input-end').value   = endLabel;   this.endLabel   = endLabel;   }

      // Restore via-point markers
      this.viaPoints.forEach(v => { if (v.marker) this.routeManager.map.removeLayer(v.marker); });
      this.viaPoints = [];
      for (const v of (via || [])) {
        const latlng  = L.latLng(v.lat, v.lng);
        const viaIcon = L.divIcon({
          className: '',
          html: `<div style="width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid #aaa;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
          iconSize: [12, 12], iconAnchor: [6, 6]
        });
        const marker = L.marker(latlng, { icon: viaIcon, draggable: true, zIndexOffset: 300 })
          .addTo(this.routeManager.map);
        this.viaPoints.push({ latlng, label: v.label || 'Via', marker });
      }
      this._renderViaList();

      // Deserialize waypoints (no markers yet)
      this.wpManager.deserialize(wpData);

      if (routeData && routeData.start && routeData.end) {
        this.routeManager.startPoint = L.latLng(routeData.start.lat, routeData.start.lng);
        this.routeManager.endPoint   = L.latLng(routeData.end.lat,   routeData.end.lng);
      }

      // Place waypoint markers BEFORE calculateRoute so they survive the recalc
      this.routeManager.restoreWaypointMarkers(
        this.wpManager.getAll(),
        this._markerClickFn,
        this._markerRightClickFn
      );

      // Recalculate route line (does NOT remove markers)
      if (this.routeManager.startPoint && this.routeManager.endPoint) {
        try {
          const viaLatLngs = this.viaPoints.map(v => v.latlng);
          await this.routeManager.calculateRoute(
            this.routeManager.startPoint,
            this.routeManager.endPoint,
            viaLatLngs
          );
          this.routeManager.fitRoute();
        } catch (e) { console.warn('Route recalc failed:', e); }
      }

      // After calculateRoute the step data is refreshed but our deserialized
      // waypoints (with their markers) are already on the map — just refresh UI
      this.refreshWaypointList();
      this._updateStats();
    } finally {
      this._hideLoading();
    }
  }

  /* LOADING */
  _showLoading(msg = 'Loading…') {
    let el = document.getElementById('loading-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loading-overlay';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
      el.innerHTML = `<div style="background:#1f2535;border:1px solid #2a3048;border-radius:10px;padding:22px 36px;color:#f5a623;font-family:'Barlow Condensed',sans-serif;font-size:17px;font-weight:700;letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;gap:14px;">
        <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" stroke="#f5a623" stroke-width="2.5" fill="none" stroke-dasharray="28 8"><animateTransform attributeName="transform" type="rotate" from="0 11 11" to="360 11 11" dur="0.75s" repeatCount="indefinite"/></circle></svg>
        <span id="loading-msg">${msg}</span>
      </div>`;
      document.body.appendChild(el);
    } else {
      document.getElementById('loading-msg').textContent = msg;
      el.style.display = 'flex';
    }
  }

  _hideLoading() {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => { window.appInstance = new App(); });