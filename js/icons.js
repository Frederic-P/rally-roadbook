/**
 * icons.js — Icon library for Rally Roadbook Creator
 *
 * Icons are defined as inline SVG paths grouped by L1 > L2 > L3.
 * Each icon has: id, name, description, l1, l2, l3, svgContent
 *
 * To add icons: add entries to ICON_LIBRARY below.
 * The svgContent is the inner SVG markup (paths, circles, etc.) for a 32×32 viewBox.
 */

/**
 * IconManager — handles search, grouping, and rendering
 */
class IconManager {
  constructor() {
    // this.icons = ICON_LIBRARY;
    this.icons = [];
    this.onLoad = () => {};
  }

  search(query) {
    if (!query) return this.icons;
    const q = query.toLowerCase();
    return this.icons.filter(ic =>
      ic.name.toLowerCase().includes(q) ||
      // ic.description.toLowerCase().includes(q) ||
      ic.l1.toLowerCase().includes(q) ||
      ic.l2.toLowerCase().includes(q) ||
      ic.l3.toLowerCase().includes(q)
    );
  }

  groupByL1(icons) {
    const groups = {};
    icons.forEach(ic => {
      if (!groups[ic.l1]) groups[ic.l1] = {};
      const key = `${ic.l2} › ${ic.l3}`;
      if (!groups[ic.l1][key]) groups[ic.l1][key] = [];
      groups[ic.l1][key].push(ic);
    });
    return groups;
  }

  renderToContainer(container, query = '') {
    const filtered = this.search(query);
    const groups = this.groupByL1(filtered);
    container.innerHTML = '';

    if (filtered.length === 0) {
      container.innerHTML = `<div style="color:var(--text-muted);padding:16px;text-align:center;font-size:12px;">No icons found</div>`;
      return;
    }

    Object.entries(groups).forEach(([l1, subgroups]) => {
      const header = document.createElement('div');
      header.className = 'icon-level-header';
      header.innerHTML = `<span class="icon-level-toggle open">▶</span> ${l1}`;

      const body = document.createElement('div');
      body.className = 'icon-level-body';

      Object.entries(subgroups).forEach(([subKey, icons]) => {
        const subHeader = document.createElement('div');
        subHeader.style.cssText = 'font-size:10px;color:var(--text-muted);padding:4px 4px 2px;';
        subHeader.textContent = subKey;
        body.appendChild(subHeader);

        const grid = document.createElement('div');
        grid.className = 'icon-group';

        icons.forEach(ic => {
          const item = document.createElement('div');
          item.className = 'icon-item';
          item.title = ic.description;
          item.dataset.iconId = ic.id;
          item.draggable = true;
          item.innerHTML = `
            <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
              ${ic.svgContent}
            </svg>
            <span class="icon-name">${ic.name}</span>
          `;
          grid.appendChild(item);
        });

        body.appendChild(grid);
      });

      header.addEventListener('click', () => {
        const toggle = header.querySelector('.icon-level-toggle');
        const isOpen = toggle.classList.toggle('open');
        body.style.display = isOpen ? '' : 'none';
      });

      container.appendChild(header);
      container.appendChild(body);
    });
  }

  getById(id) {
    return this.icons.find(ic => ic.id === id);
  }

  /**
   * Load additional icons from a JSON config (extensibility)
   */

  
  loadFromJSON(data) {
    if (Array.isArray(data)) {
      this.icons = [...this.icons, ...data];
    }
  }
}

window.iconManager = new IconManager();

Promise.all([
  fetch('data/warning.json').then(r => r.json()),
  fetch('data/prohibition.json').then(r => r.json()),
  fetch('data/mandatory.json').then(r => r.json()),
  fetch('data/priority.json').then(r => r.json()),
  fetch('data/services.json').then(r => r.json()),
  fetch('data/custom-icons.json').then(r => r.json())
]).then(all => {
  const customIcons = all.pop().icons || [];
  const otherIcons = all.flat();
  const combined = [...otherIcons, ...customIcons];
  
  console.log(combined);
  iconManager.loadFromJSON(combined);
  iconManager.onLoad();
});