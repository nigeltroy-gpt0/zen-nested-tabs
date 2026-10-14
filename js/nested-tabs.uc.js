// ==UserScript==
// @name           Zen Nested Tabs
// @description    Tree Style Tab-like nesting for Zen Browser's vertical tabs.
// @include        main
// @version        1.0.8
// ==/UserScript==

/*
 * Model
 * -----
 * The tab tree is the source of truth: one parent pointer per tab (a stable
 * id saved with SessionStore custom tab values). Children are ordered by
 * sidebar order. Only explicit tree operations change the tree: open (nest
 * under the opener), close (promote or close the subtree), move/drag
 * (re-parent from the drop position and bring the subtree along), nest /
 * un-nest, and leaving a list (pinning, folders, spaces, Essentials), where
 * the tab's children move up to its parent.
 *
 * Rendering (#normalize) only reads the tree. Depth, hidden state and child
 * counts come from parent pointers, never from sidebar order, so a tab that
 * is briefly out of place (closing, mid-move, just opened) can't cut anyone
 * off.
 *
 * Lists: nesting only happens between tabs that share a DOM parent (the
 * normal tabs list of a space, the pinned list, or a Zen folder). Essentials,
 * Glance tabs and Zen's empty placeholder tab are never part of a tree.
 */
(() => {
  "use strict";

  if (window.location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }
  if (window.gZenNestedTabs) {
    return;
  }

  const DEFAULT_INDENT_PX = 16;
  const MIN_INDENT_PX = 4;
  const MAX_INDENT_PX = 64;

  const PREF_AUTO_NEST = "mod.nestedtabs.auto_nest";
  const PREF_CLOSE_BEHAVIOR = "mod.nestedtabs.close_behavior";
  const PREF_INDENT = "mod.nestedtabs.indent";
  const PREF_CARET_POSITION = "mod.nestedtabs.caret_position";

  /**
   * Where the caret sits:
   *   "edge"  (default) far right, after the close button, so the close button
   *           appearing on hover never slides into the caret's spot
   *   "right" after the title, before the close button
   *   "left"  before the favicon
   */
  const CARET_POSITIONS = ["edge", "right", "left"];
  const readCaretPosition = () => {
    const value = Services.prefs.getStringPref(PREF_CARET_POSITION, "edge");
    return CARET_POSITIONS.includes(value) ? value : "edge";
  };

  /**
   * Indent per level in px. Mod managers may store this text setting as a
   * string ("16", "16px") or, when it looks numeric, as an integer pref.
   */
  const readIndent = () => {
    let raw;
    try {
      switch (Services.prefs.getPrefType(PREF_INDENT)) {
        case Services.prefs.PREF_INT:
          raw = Services.prefs.getIntPref(PREF_INDENT);
          break;
        case Services.prefs.PREF_STRING:
          raw = Services.prefs.getStringPref(PREF_INDENT);
          break;
      }
    } catch (e) {}
    const px = parseFloat(raw);
    if (!Number.isFinite(px)) {
      return DEFAULT_INDENT_PX;
    }
    return Math.min(MAX_INDENT_PX, Math.max(MIN_INDENT_PX, Math.round(px)));
  };

  const KEY_ID = "zenNestedTabsId";
  const KEY_PARENT = "zenNestedTabsParent";
  const KEY_COLLAPSED = "zenNestedTabsCollapsed";

  // browser.xhtml already exposes SessionStore as a window global. The module
  // moved from resource:///modules/ to moz-src:/// in newer Firefox, so only
  // import it ourselves as a fallback.
  const lazy = {};
  ChromeUtils.defineLazyGetter(lazy, "SessionStore", () => {
    if (window.SessionStore) {
      return window.SessionStore;
    }
    for (const url of [
      "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
      "resource:///modules/sessionstore/SessionStore.sys.mjs",
    ]) {
      try {
        return ChromeUtils.importESModule(url).SessionStore;
      } catch (e) {}
    }
    throw new Error("[Zen Nested Tabs] SessionStore module not found");
  });

  const newId = () => Services.uuid.generateUUID().toString().slice(1, -1);

  class ZenNestedTabs {
    /** Extra px Zen's getSidebarMinWidth() should add for the current nesting. */
    #extraMinWidth = 0;
    /** >0 while we are moving tabs ourselves; TabMove handling is skipped. */
    #internalMoves = 0;
    #initialized = false;
    #normalizeQueued = false;
    #indentPx = DEFAULT_INDENT_PX;
    #caretPosition = "edge";
    /** Active tab drag: { tab, subtree, startX, x, clientY, moved, dropped }. */
    #drag = null;
    #dropIndicatorQueued = false;

    async init() {
      // Mod managers don't reliably apply preferences.json defaults, and the
      // CSS -moz-pref() queries treat a missing pref as false.
      const defaults = Services.prefs.getDefaultBranch("");
      defaults.setBoolPref(PREF_AUTO_NEST, true);
      defaults.setBoolPref("mod.nestedtabs.show_guides", true);
      defaults.setBoolPref("mod.nestedtabs.show_count", true);
      defaults.setStringPref(PREF_CLOSE_BEHAVIOR, "promote");
      defaults.setStringPref(PREF_CARET_POSITION, "edge");

      await this.#whenDelayedStartupFinished();
      await window.gZenWorkspaces?.promiseInitialized;
      await lazy.SessionStore.promiseAllWindowsRestored;

      for (const tab of gBrowser.tabs) {
        this.#loadFromSession(tab);
      }

      this.#applyIndent();
      this.#applyCaretPosition();
      this.#patchSidebarMinWidth();
      this.#addListeners();
      this.#addContextMenu();

      this.#initialized = true;
      this.normalize();
    }

    // -- Startup helpers -----------------------------------------------------

    #whenDelayedStartupFinished() {
      if (window.gBrowserInit?.delayedStartupFinished) {
        return Promise.resolve();
      }
      return new Promise(resolve => {
        const observer = subject => {
          if (subject === window) {
            Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
            resolve();
          }
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      });
    }

    #loadFromSession(tab) {
      const ss = lazy.SessionStore;
      tab._ntId = ss.getCustomTabValue(tab, KEY_ID) || tab._ntId || newId();
      tab._ntParentId = ss.getCustomTabValue(tab, KEY_PARENT) || null;
      tab._ntCollapsed = ss.getCustomTabValue(tab, KEY_COLLAPSED) === "true";
      ss.setCustomTabValue(tab, KEY_ID, tab._ntId);
    }

    #save(tab) {
      const ss = lazy.SessionStore;
      try {
        tab._ntId ??= newId();
        ss.setCustomTabValue(tab, KEY_ID, tab._ntId);
        if (tab._ntParentId) {
          ss.setCustomTabValue(tab, KEY_PARENT, tab._ntParentId);
        } else {
          ss.deleteCustomTabValue(tab, KEY_PARENT);
        }
        if (tab._ntCollapsed) {
          ss.setCustomTabValue(tab, KEY_COLLAPSED, "true");
        } else {
          ss.deleteCustomTabValue(tab, KEY_COLLAPSED);
        }
        tab._ntPersisted = true;
      } catch (e) {
        // Tabs that are closing or not yet registered with SessionStore throw.
      }
    }

    // -- Tree queries ----------------------------------------------------------

    isEligible(tab) {
      return (
        !!tab &&
        tab.isConnected &&
        !tab.closing &&
        !tab.hasAttribute("zen-essential") &&
        !tab.hasAttribute("zen-glance-tab") &&
        !tab.hasAttribute("zen-empty-tab")
      );
    }

    #idMap() {
      const map = new Map();
      for (const t of gBrowser.tabs) {
        if (t._ntId) {
          map.set(t._ntId, t);
        }
      }
      return map;
    }

    parentOf(tab, map = null) {
      if (!tab?._ntParentId) {
        return null;
      }
      return (map || this.#idMap()).get(tab._ntParentId) || null;
    }

    /**
     * Eligible tabs in the same container as `tab`, in sidebar order. `tab`
     * itself is always included, even while it is closing.
     */
    #siblingsInContainer(tab) {
      const container = tab.parentNode;
      return gBrowser.tabs.filter(t => t === tab || (t.parentNode === container && this.isEligible(t)));
    }

    #isAncestor(maybeAncestor, tab, map = this.#idMap()) {
      let p = this.parentOf(tab, map);
      for (let guard = 0; p && guard < 1000; guard++) {
        if (p === maybeAncestor) {
          return true;
        }
        p = this.parentOf(p, map);
      }
      return false;
    }

    /**
     * The tab's descendants in sidebar order. Uses parent pointers rather than
     * rendered depth, so it is correct mid-move and for brand new tabs.
     */
    descendantsOf(tab) {
      const map = this.#idMap();
      return this.#siblingsInContainer(tab).filter(t => t !== tab && this.#isAncestor(tab, t, map));
    }

    childrenOf(tab) {
      return this.#siblingsInContainer(tab).filter(t => t !== tab && t._ntParentId === tab._ntId);
    }

    // -- Mutations --------------------------------------------------------------

    setParent(tab, parent) {
      if (parent && (parent === tab || this.#isAncestor(tab, parent))) {
        return; // would create a cycle
      }
      tab._ntParentId = parent ? parent._ntId : null;
      this.#save(tab);
    }

    setCollapsed(tab, collapsed) {
      if (!!tab._ntCollapsed === !!collapsed) {
        return;
      }
      tab._ntCollapsed = !!collapsed;
      this.#save(tab);

      // Folding a tree that contains the selected tab: select the parent so the
      // active tab never disappears from the sidebar.
      if (collapsed && this.descendantsOf(tab).includes(gBrowser.selectedTab)) {
        gBrowser.selectedTab = tab;
      }
    }

    toggleCollapsed(tab, { recursive = false } = {}) {
      const collapse = !tab._ntCollapsed;
      this.setCollapsed(tab, collapse);
      if (recursive) {
        for (const d of this.descendantsOf(tab)) {
          if (this.childrenOf(d).length) {
            this.setCollapsed(d, collapse);
          }
        }
      }
      this.normalize();
    }

    #expandAncestors(tab) {
      const map = this.#idMap();
      for (let p = this.parentOf(tab, map), guard = 0; p && guard < 1000; p = this.parentOf(p, map), guard++) {
        this.setCollapsed(p, false);
      }
    }

    /** Move `tab` to directly after `target`, without triggering our TabMove logic. */
    #moveAfter(tab, target) {
      if (tab === target || tab.previousElementSibling === target) {
        return;
      }
      this.#internalMoves++;
      try {
        if (typeof gBrowser.moveTabAfter === "function") {
          gBrowser.moveTabAfter(tab, target);
        } else {
          let index = target._tPos;
          if (tab._tPos > index) {
            index++;
          }
          gBrowser.moveTabTo(tab, { tabIndex: index });
        }
      } catch (e) {
        console.error("[Zen Nested Tabs] move failed", e);
      } finally {
        this.#internalMoves--;
      }
    }

    /** Keep `tab`'s subtree (`descendants`, in order) directly below it. */
    #bringDescendants(tab, descendants) {
      let anchor = tab;
      for (const d of descendants) {
        if (d.parentNode === tab.parentNode) {
          this.#moveAfter(d, anchor);
          anchor = d;
        }
      }
    }

    /** Make `tab` the last child of `parent` (moving it and its subtree). */
    nestUnder(tab, parent) {
      if (!this.isEligible(tab) || !this.isEligible(parent) || tab.parentNode !== parent.parentNode) {
        return;
      }
      const subtree = this.descendantsOf(tab);
      const parentSubtree = this.descendantsOf(parent).filter(t => t !== tab && !subtree.includes(t));
      this.setParent(tab, parent);
      this.setCollapsed(parent, false);
      this.#moveAfter(tab, parentSubtree.at(-1) || parent);
      this.#bringDescendants(tab, subtree);
      this.normalize();
    }

    /** Context menu: become the last child of the sibling above. */
    indent(tab) {
      const prev = this.#previousSibling(tab);
      if (prev) {
        this.nestUnder(tab, prev);
      }
    }

    /** Context menu: become the next sibling of the current parent. */
    outdent(tab) {
      const parent = this.parentOf(tab);
      if (!parent) {
        return;
      }
      const subtree = this.descendantsOf(tab);
      const parentSubtree = this.descendantsOf(parent).filter(t => t !== tab && !subtree.includes(t));
      this.setParent(tab, this.parentOf(parent));
      this.#moveAfter(tab, parentSubtree.at(-1) || parent);
      this.#bringDescendants(tab, subtree);
      this.normalize();
    }

    #previousSibling(tab) {
      const list = this.#siblingsInContainer(tab);
      for (let i = list.indexOf(tab) - 1; i >= 0; i--) {
        if (list[i]._ntParentId === tab._ntParentId) {
          return list[i];
        }
        if ((list[i]._ntDepth || 0) < (tab._ntDepth || 0)) {
          return null; // reached our parent: no earlier sibling
        }
      }
      return null;
    }

    setAllCollapsed(collapsed) {
      for (const tab of gBrowser.tabs) {
        if (this.isEligible(tab) && tab.hasAttribute("nt-has-children")) {
          this.setCollapsed(tab, collapsed);
        }
      }
      this.normalize();
    }

    // -- Normalize + render ------------------------------------------------------

    /** Coalesce many structural events into one pass per frame. */
    scheduleNormalize() {
      if (this.#normalizeQueued || !this.#initialized) {
        return;
      }
      this.#normalizeQueued = true;
      requestAnimationFrame(() => {
        this.#normalizeQueued = false;
        this.normalize();
      });
    }

    /**
     * Render the tree. This only *reads* the tree: depth, hidden state and
     * child counts come from parent pointers, never from sidebar order, so a
     * tab that is momentarily out of place (closing, mid-move, just opened)
     * can't cut anyone off. The only changes made here are for tabs that have
     * really left their list (see #leaveList).
     */
    normalize() {
      if (!this.#initialized) {
        return;
      }
      this.#applyListChanges();

      const map = this.#idMap();
      const activeSpace = window.gZenWorkspaces?.activeWorkspace;
      const info = new Map(); // tab -> { depth, hidden, descendants }
      let maxVisibleDepth = 0;

      for (const tab of gBrowser.tabs) {
        if (!this.isEligible(tab)) {
          this.#clearTab(tab);
          continue;
        }
        if (tab._ntPending) {
          continue; // not placed yet, see #onTabOpen
        }
        if (!tab._ntPersisted) {
          this.#save(tab);
        }
        const ancestors = this.#ancestors(tab, map);
        info.set(tab, { depth: ancestors.length, hidden: ancestors.some(a => a._ntCollapsed), ancestors, descendants: 0 });
      }

      for (const [tab, { depth, hidden, ancestors }] of info) {
        for (const ancestor of ancestors) {
          info.get(ancestor).descendants++;
        }
        const inActiveSpace =
          !activeSpace || !tab.hasAttribute("zen-workspace-id") || tab.getAttribute("zen-workspace-id") === activeSpace;
        if (!hidden && inActiveSpace && !tab.hidden) {
          maxVisibleDepth = Math.max(maxVisibleDepth, depth);
        }
      }

      for (const [tab, { depth, hidden, descendants }] of info) {
        if (!descendants && tab._ntCollapsed) {
          tab._ntCollapsed = false;
          this.#save(tab);
        }
        tab._ntList = tab.parentNode;
        this.#renderTab(tab, depth, hidden, descendants);
      }

      this.#updateSidebarWidth(maxVisibleDepth);
      this.#updateGuideGap();
    }

    /**
     * The tab's ancestors that count for display, nearest first. A parent only
     * counts while it is a live, placed tree tab in the same list; otherwise
     * the chain stops there (without changing the stored tree).
     */
    #ancestors(tab, map) {
      const result = [];
      let current = tab;
      while (result.length < 1000) {
        const parent = this.parentOf(current, map);
        if (
          !parent ||
          parent === tab ||
          !this.isEligible(parent) ||
          parent._ntPending ||
          parent.parentNode !== tab.parentNode
        ) {
          break;
        }
        result.push(parent);
        current = parent;
      }
      return result;
    }

    /**
     * Tree operation: take `tab` out of its tree. Its children move up to its
     * parent (they stay where they are, so the tree stays contiguous) and the
     * tab itself becomes top-level.
     */
    #leaveTree(tab) {
      const grandparent = this.parentOf(tab);
      for (const child of gBrowser.tabs.filter(t => t !== tab && t._ntParentId === tab._ntId)) {
        this.setParent(child, grandparent);
      }
      this.setParent(tab, null);
    }

    /**
     * Tabs that really left their list since the last render: moved into a
     * folder, the pinned list, another space, or became an Essential / Glance.
     * Closing tabs are handled by #onTabClose instead.
     */
    #applyListChanges() {
      for (const tab of gBrowser.tabs) {
        if (tab.closing || tab._ntPending) {
          continue;
        }
        const leftList = tab._ntList && tab._ntList !== tab.parentNode;
        const leftTrees = !this.isEligible(tab) && (tab._ntParentId || gBrowser.tabs.some(t => t._ntParentId === tab._ntId));
        if (leftList || leftTrees) {
          this.#leaveTree(tab);
          tab._ntList = tab.parentNode;
          if (leftList && this.isEligible(tab)) {
            // Join whatever tree it landed in, like a drop.
            this.setParent(tab, this.#parentFromPosition(tab));
          }
        }
      }
    }

    #renderTab(tab, depth, hidden, descendants) {
      tab._ntDepth = depth;
      if (tab.getAttribute("nt-depth") !== String(depth)) {
        tab.setAttribute("nt-depth", depth);
        tab.style.setProperty("--nt-depth", depth);
      }
      tab.toggleAttribute("nt-hidden", hidden);
      tab.toggleAttribute("nt-has-children", descendants > 0);
      tab.toggleAttribute("nt-collapsed", descendants > 0 && !!tab._ntCollapsed);

      if (descendants > 0) {
        const { twisty, count } = this.#ensureDecorations(tab);
        count.textContent = descendants;
        twisty.setAttribute("aria-label", tab._ntCollapsed ? "Expand tree" : "Collapse tree");
        twisty.setAttribute("aria-expanded", String(!tab._ntCollapsed));
      }
    }

    #clearTab(tab) {
      tab._ntDepth = 0;
      for (const attr of ["nt-depth", "nt-hidden", "nt-has-children", "nt-collapsed"]) {
        tab.removeAttribute(attr);
      }
      tab.style.removeProperty("--nt-depth");
    }

    #ensureDecorations(tab) {
      const content = tab.querySelector(".tab-content");
      let twisty = content.querySelector(":scope > .nt-twisty");
      let count = content.querySelector(":scope > .nt-count");
      if (!count) {
        count = document.createXULElement("hbox");
        count.className = "nt-count";
        const labelContainer = content.querySelector(".tab-label-container");
        if (labelContainer) {
          labelContainer.after(count);
        } else {
          content.append(count);
        }
      }
      if (!twisty) {
        twisty = document.createXULElement("hbox");
        twisty.className = "nt-twisty";
        twisty.setAttribute("role", "button");
      }
      // See readCaretPosition(). Only touch the DOM when it is out of place.
      if (this.#caretPosition === "left") {
        if (content.firstElementChild !== twisty) {
          content.prepend(twisty);
        }
      } else if (this.#caretPosition === "edge") {
        if (content.lastElementChild !== twisty) {
          content.append(twisty);
        }
      } else if (count.nextElementSibling !== twisty) {
        count.after(twisty);
      }
      return { twisty, count };
    }

    /**
     * Guide lines are drawn per row, on each tab's .tab-stack. To join up
     * without overlapping (the line is translucent, so overlaps show as darker
     * joints) each segment extends by exactly half the gap between rows.
     */
    #updateGuideGap() {
      // Any two adjacent visible rows will do; take the first nested one.
      const tab = gBrowser.tabs.find(
        t =>
          t.getAttribute("nt-depth") > 0 &&
          !t.hasAttribute("nt-hidden") &&
          t.previousElementSibling?.classList?.contains("tabbrowser-tab") &&
          !t.previousElementSibling.hasAttribute("nt-hidden")
      );
      const above = tab?.previousElementSibling.querySelector(".tab-stack")?.getBoundingClientRect();
      const below = tab?.querySelector(".tab-stack")?.getBoundingClientRect();
      if (!above?.height || !below?.height) {
        return;
      }
      const halfGap = Math.max(0, below.top - above.bottom) / 2;
      const value = `${Math.round(halfGap * 100) / 100}px`;
      if (document.documentElement.style.getPropertyValue("--nt-guide-overhang") !== value) {
        document.documentElement.style.setProperty("--nt-guide-overhang", value);
      }
    }

    // -- Sidebar width ----------------------------------------------------------

    /**
     * Zen's own resizer and _updateMaxWidth() both ask
     * gZenVerticalTabsManager.getSidebarMinWidth() for the minimum width, so we
     * wrap it and add 16px per visible nesting level.
     */
    #patchSidebarMinWidth() {
      const manager = window.gZenVerticalTabsManager;
      if (!manager || manager._ntPatched || typeof manager.getSidebarMinWidth !== "function") {
        return;
      }
      const original = manager.getSidebarMinWidth;
      const self = this;
      manager.getSidebarMinWidth = function (...args) {
        return original.apply(this, args) + self.#extraMinWidth;
      };
      manager._ntPatched = true;
    }

    #updateSidebarWidth(maxDepth) {
      const extra = maxDepth * this.#indentPx;
      const manager = window.gZenVerticalTabsManager;
      const toolbox = window.gNavToolbox;
      if (!manager || !toolbox) {
        return;
      }

      if (extra !== this.#extraMinWidth) {
        this.#extraMinWidth = extra;
        // Re-publishes --zen-toolbox-min-width for CSS and the drag resizer.
        if (typeof manager._updateMaxWidth === "function") {
          manager._updateMaxWidth();
        } else {
          toolbox.style.setProperty("--zen-toolbox-min-width", `${manager.getSidebarMinWidth()}px`);
        }
      }

      if (toolbox.getAttribute("zen-sidebar-expanded") !== "true") {
        return;
      }

      // Grow only. When nesting shrinks the minimum drops, but we leave the
      // user's current width alone.
      const maxWidth = parseFloat(toolbox.style.maxWidth);
      let required = manager.getSidebarMinWidth();
      if (Number.isFinite(maxWidth)) {
        required = Math.min(required, maxWidth);
      }
      const current = parseFloat(toolbox.getAttribute("width")) || toolbox.getBoundingClientRect().width;
      if (current < required) {
        const value = `${Math.round(required)}px`;
        toolbox.style.width = value;
        toolbox.style.setProperty("--zen-sidebar-width", value);
        toolbox.setAttribute("width", value);
        window.dispatchEvent(new Event("resize"));
      }
    }

    // -- Events -----------------------------------------------------------------

    /** Publish the indent for chrome.css; the width math uses #indentPx. */
    /** Publish the caret side for chrome.css; #ensureDecorations places it. */
    #applyCaretPosition() {
      this.#caretPosition = readCaretPosition();
      document.documentElement.setAttribute("nt-caret", this.#caretPosition);
    }

    #applyIndent() {
      this.#indentPx = readIndent();
      document.documentElement.style.setProperty("--nt-indent", `${this.#indentPx}px`);
    }

    #addListeners() {
      // Live-update when the setting changes; no restart needed.
      const indentObserver = () => {
        this.#applyIndent();
        this.normalize();
      };
      const caretObserver = () => {
        this.#applyCaretPosition();
        this.normalize(); // re-places every caret
      };
      Services.prefs.addObserver(PREF_INDENT, indentObserver);
      Services.prefs.addObserver(PREF_CARET_POSITION, caretObserver);
      window.addEventListener(
        "unload",
        () => {
          Services.prefs.removeObserver(PREF_INDENT, indentObserver);
          Services.prefs.removeObserver(PREF_CARET_POSITION, caretObserver);
        },
        { once: true }
      );

      const container = gBrowser.tabContainer;
      container.addEventListener("TabOpen", this);
      container.addEventListener("TabClose", this);
      container.addEventListener("TabMove", this);
      container.addEventListener("TabSelect", this);
      container.addEventListener("TabPinned", this);
      container.addEventListener("TabUnpinned", this);
      container.addEventListener("SSTabRestoring", this);
      container.addEventListener("TabGrouped", this);
      container.addEventListener("TabUngrouped", this);

      // Capture so the caret wins before the tab's own select/drag handlers.
      for (const type of ["mousedown", "mouseup", "click", "auxclick", "dblclick", "dragstart"]) {
        container.addEventListener(type, this, true);
      }

      // Drag right/left to nest/un-nest. Zen's own drag & drop still does the
      // reordering; we only read the pointer to decide the new level.
      for (const type of ["dragover", "drop", "dragend"]) {
        window.addEventListener(type, this, true);
      }

      window.addEventListener("ZenWorkspacesUIUpdate", this);
      window.addEventListener("ZenWorkspaceDataChanged", this);

      // Zen toggles this attribute when expanding/collapsing the sidebar.
      new MutationObserver(() => this.scheduleNormalize()).observe(window.gNavToolbox, {
        attributes: true,
        attributeFilter: ["zen-sidebar-expanded"],
      });
    }

    handleEvent(event) {
      switch (event.type) {
        case "mousedown":
        case "mouseup":
        case "click":
        case "auxclick":
        case "dblclick":
          this.#onTwistyEvent(event);
          break;
        case "dragstart":
          this.#onTwistyEvent(event);
          if (!event.defaultPrevented) {
            this.#onDragStart(event);
          }
          break;
        case "dragover":
        case "drop":
          this.#onDragOver(event);
          break;
        case "dragend":
          this.#onDragEnd();
          break;
        case "TabOpen":
          this.#onTabOpen(event.target);
          break;
        case "TabClose":
          this.#onTabClose(event.target);
          break;
        case "TabMove":
          this.#onTabMove(event.target);
          break;
        case "TabSelect":
          if (event.target.hasAttribute("nt-hidden")) {
            this.#expandAncestors(event.target);
          }
          this.scheduleNormalize();
          break;
        case "SSTabRestoring":
          this.#onTabRestoring(event.target);
          break;
        default:
          this.scheduleNormalize();
      }
    }

    #onTwistyEvent(event) {
      const twisty = event.target.closest?.(".nt-twisty");
      if (!twisty) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      if (event.type === "click" && event.button === 0) {
        const tab = twisty.closest(".tabbrowser-tab");
        this.toggleCollapsed(tab, { recursive: event.ctrlKey || event.metaKey });
      }
    }

    #onTabOpen(tab) {
      tab._ntId ??= newId();
      tab._ntParentId = null;
      tab._ntCollapsed = false;
      this.#save(tab);

      // Only real "opened from this page" relations. `tab.owner` is also set
      // for Ctrl+T, which TST does not nest either.
      const opener = Services.prefs.getBoolPref(PREF_AUTO_NEST, true) ? tab.openerTab : null;

      // Until it is placed, a new tab may sit between a parent and its
      // children (Firefox/Zen often insert related tabs right after the
      // opener). Mark it pending so #normalize() looks through it instead of
      // treating it as a break in the tree and detaching those children.
      tab._ntPending = true;

      // Zen places the tab into its space/section after TabOpen; wait for that.
      setTimeout(() => {
        tab._ntPending = false;
        if (!this.isEligible(tab)) {
          this.scheduleNormalize();
          return;
        }
        if (tab._ntParentId) {
          // Restored or duplicated tab: SessionStore already gave it a parent.
          this.normalize();
        } else if (opener && this.isEligible(opener) && !tab.pinned && tab.parentNode === opener.parentNode) {
          this.nestUnder(tab, opener);
        } else {
          // Not auto-nested: take the parent implied by where it was inserted,
          // so a tab dropped into the middle of a tree never splits it.
          this.setParent(tab, this.#parentFromPosition(tab));
          this.normalize();
        }
      }, 0);
    }

    #onTabClose(tab) {
      const children = this.childrenOf(tab);
      if (!children.length) {
        this.scheduleNormalize();
        return;
      }

      const behavior = Services.prefs.getStringPref(PREF_CLOSE_BEHAVIOR, "promote");
      const closeTree = behavior === "close_all" || (behavior === "close_collapsed" && tab._ntCollapsed);

      if (closeTree) {
        const descendants = this.descendantsOf(tab);
        setTimeout(() => gBrowser.removeTabs(descendants.filter(t => t.isConnected && !t.closing)), 0);
      } else {
        for (const child of children) {
          this.setParent(child, this.parentOf(tab));
        }
      }
      this.scheduleNormalize();
    }

    #onTabRestoring(tab) {
      const restoredId = lazy.SessionStore.getCustomTabValue(tab, KEY_ID);
      const original = restoredId && gBrowser.tabs.find(t => t !== tab && t._ntId === restoredId);
      this.#loadFromSession(tab);

      if (original) {
        // Duplicated tab: give it its own identity, make it a sibling of the
        // original and keep the original's subtree intact by moving the copy
        // below it.
        tab._ntId = newId();
        tab._ntParentId = original._ntParentId;
        tab._ntCollapsed = false;
        this.#save(tab);
        if (tab.parentNode === original.parentNode) {
          this.#moveAfter(tab, this.descendantsOf(original).at(-1) || original);
        }
      }
      this.scheduleNormalize();
    }

    /**
     * A tab was moved by the user (drag & drop, keyboard, another add-on).
     * Like TST, its new parent comes from where it landed, and its subtree
     * follows it.
     */
    #onTabMove(tab) {
      if (this.#internalMoves || !this.#initialized || !this.isEligible(tab) || tab._ntPending) {
        return;
      }

      if (tab._ntList && tab._ntList !== tab.parentNode) {
        // Moved to another list (folder, pinned, space): its children stay
        // behind under its old parent, and it joins the tree where it landed.
        this.#leaveTree(tab);
        tab._ntList = tab.parentNode;
        this.setParent(tab, this.#parentFromPosition(tab));
        this.scheduleNormalize();
        return;
      }

      // Use the tree as it was before the move to find the subtree.
      const map = this.#idMap();
      const subtree = new Set();
      for (const t of gBrowser.tabs) {
        if (t !== tab && this.#isAncestor(tab, t, map)) {
          subtree.add(t);
        }
      }

      const drag = this.#drag?.tab === tab ? this.#drag : null;
      if (drag) {
        drag.moved = true;
      }
      const { prev, next } = this.#neighbors(tab, subtree);
      const newParent = drag
        ? this.#dropParent(prev, next, drag.x - drag.startX, map)
        : this.#positionalParent(prev, next, map);
      this.setParent(tab, newParent);
      if (newParent) {
        this.#expandAncestors(tab);
      }

      const ordered = gBrowser.tabs.filter(t => subtree.has(t));
      this.#bringDescendants(tab, ordered);
      this.scheduleNormalize();
    }

    /** Previous/next eligible tabs around `tab` in its container, skipping `exclude`. */
    #neighbors(tab, exclude = new Set()) {
      const list = this.#siblingsInContainer(tab).filter(t => t === tab || (!exclude.has(t) && !t._ntPending));
      const index = list.indexOf(tab);
      return { prev: list[index - 1] || null, next: list[index + 1] || null };
    }

    /** The parent implied by `tab`'s current position (see #positionalParent). */
    #parentFromPosition(tab, exclude = new Set(), map = this.#idMap()) {
      const { prev, next } = this.#neighbors(tab, exclude);
      return this.#positionalParent(prev, next, map);
    }

    /**
     * TST's drop rule: a tab placed between `prev` and `next` joins the level
     * of `next` when `next` is nested under `prev` or one of its ancestors;
     * otherwise it is top-level.
     */
    #positionalParent(prev, next, map) {
      if (!prev || !next?._ntParentId) {
        return null;
      }
      const nextParent = this.parentOf(next, map);
      if (!nextParent || (nextParent !== prev && !this.#isAncestor(nextParent, prev, map))) {
        return null;
      }
      return nextParent;
    }

    #depthOf(tab, map) {
      let depth = 0;
      for (let p = this.parentOf(tab, map); p && depth < 1000; p = this.parentOf(p, map)) {
        depth++;
      }
      return depth;
    }

    /**
     * Parent for a tab placed between `prev` and `next` at the requested
     * depth. The depth is clamped so the tree stays valid: at most one level
     * deeper than `prev` (its child), and at least `next`'s depth (so `next`
     * keeps its parent).
     */
    #parentForDepth(prev, next, wanted, map) {
      if (!prev) {
        return null;
      }
      const prevDepth = this.#depthOf(prev, map);
      const minDepth = next ? this.#depthOf(next, map) : 0;
      const depth = Math.max(minDepth, Math.min(prevDepth + 1, wanted));
      let parent = prev;
      for (let d = prevDepth; parent && d > depth - 1; d--) {
        parent = this.parentOf(parent, map);
      }
      return depth === 0 ? null : parent;
    }

    /**
     * Drag gesture: start from the normal drop rule, then go one level deeper
     * per step dragged right, or shallower per step dragged left. A step is
     * one indent (at least 24px, so normal vertical drags don't nest by
     * accident) and needs 60% of a step to count.
     */
    #dropParent(prev, next, dx, map) {
      const base = this.#positionalParent(prev, next, map);
      const baseDepth = base ? this.#depthOf(base, map) + 1 : 0;
      const step = Math.max(this.#indentPx, 24);
      const raw = dx / step;
      const steps = raw >= 0 ? Math.floor(raw + 0.4) : -Math.floor(-raw + 0.4);
      return this.#parentForDepth(prev, next, baseDepth + steps, map);
    }

    // -- Drag to nest -----------------------------------------------------------

    #onDragStart(event) {
      this.#clearDropIndicator();
      this.#drag = null;
      const tab = event.target.closest?.(".tabbrowser-tab");
      if (
        !tab ||
        !this.isEligible(tab) ||
        window.gNavToolbox.getAttribute("zen-sidebar-expanded") !== "true" ||
        (tab.multiselected && gBrowser.selectedTabs.length > 1)
      ) {
        return; // multi-tab drags keep the plain drop rule
      }
      const map = this.#idMap();
      const subtree = new Set(gBrowser.tabs.filter(t => t !== tab && this.#isAncestor(tab, t, map)));
      this.#drag = {
        tab,
        subtree,
        startX: event.screenX,
        x: event.screenX,
        clientY: event.clientY,
        moved: false,
        dropped: false,
      };
    }

    #onDragOver(event) {
      const drag = this.#drag;
      if (!drag) {
        return;
      }
      // Some platforms report 0,0 for synthetic drag events; ignore those.
      if (event.screenX || event.screenY) {
        drag.x = event.screenX;
        drag.clientY = event.clientY;
        drag.overTabs = !!event.target.closest?.("#tabbrowser-tabs, .zen-workspace-tabs-section");
      }
      if (event.type === "drop") {
        drag.dropped = true;
        this.#clearDropIndicator();
        return;
      }
      if (!this.#dropIndicatorQueued) {
        this.#dropIndicatorQueued = true;
        requestAnimationFrame(() => {
          this.#dropIndicatorQueued = false;
          this.#updateDropIndicator();
        });
      }
    }

    #onDragEnd() {
      const drag = this.#drag;
      this.#clearDropIndicator();
      if (!drag) {
        return;
      }
      // Firefox fires no TabMove when a tab is dropped where it already was,
      // which is exactly the "drag right to indent in place" case.
      setTimeout(() => {
        if (this.#drag === drag) {
          if (drag.dropped && !drag.moved && drag.tab.isConnected) {
            this.#onTabMove(drag.tab);
          }
          this.#drag = null;
        }
      }, 50);
    }

    /** Outline the tab that would become the parent if dropped now. */
    #updateDropIndicator() {
      this.#clearDropIndicator();
      const drag = this.#drag;
      if (!drag || drag.dropped || !drag.overTabs) {
        return;
      }
      const list = this.#siblingsInContainer(drag.tab).filter(
        t => t !== drag.tab && !drag.subtree.has(t) && !t._ntPending && !t.hasAttribute("nt-hidden")
      );
      let prev = null;
      let next = null;
      for (const t of list) {
        const rect = t.getBoundingClientRect();
        if (!rect.height) {
          continue;
        }
        if (rect.top + rect.height / 2 < drag.clientY) {
          prev = t;
        } else {
          next = t;
          break;
        }
      }
      const parent = this.#dropParent(prev, next, drag.x - drag.startX, this.#idMap());
      if (parent) {
        parent.setAttribute("nt-drop-parent", "");
        drag.indicated = parent;
      }
    }

    #clearDropIndicator() {
      for (const t of document.querySelectorAll(".tabbrowser-tab[nt-drop-parent]")) {
        t.removeAttribute("nt-drop-parent");
      }
      if (this.#drag) {
        this.#drag.indicated = null;
      }
    }

    // -- Context menu -------------------------------------------------------------

    #addContextMenu() {
      const menu = document.getElementById("tabContextMenu");
      if (!menu) {
        return;
      }
      const anchor = document.getElementById("context_moveTabOptions") || menu.firstElementChild;

      const separator = document.createXULElement("menuseparator");
      separator.className = "nt-menu-separator";

      const items = [
        ["nt-ctx-indent", "Nest Under Tab Above", tab => this.indent(tab)],
        ["nt-ctx-outdent", "Move Out One Level", tab => this.outdent(tab)],
        ["nt-ctx-toggle", "Collapse Tree", tab => this.toggleCollapsed(tab)],
        ["nt-ctx-collapse-all", "Collapse All Trees", () => this.setAllCollapsed(true)],
        ["nt-ctx-expand-all", "Expand All Trees", () => this.setAllCollapsed(false)],
      ].map(([id, label, action]) => {
        const item = document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("label", label);
        item.addEventListener("command", () => {
          const tab = TabContextMenu.contextTab;
          if (tab) {
            action(tab);
          }
        });
        return item;
      });

      anchor.before(separator, ...items);

      menu.addEventListener("popupshowing", event => {
        if (event.target !== menu) {
          return;
        }
        const tab = TabContextMenu.contextTab;
        const eligible = this.isEligible(tab) && !tab.multiselected;
        const byId = id => document.getElementById(id);

        separator.hidden = !eligible;
        byId("nt-ctx-indent").hidden = !eligible || !this.#previousSibling(tab);
        byId("nt-ctx-outdent").hidden = !eligible || !tab._ntParentId;

        const isParent = eligible && tab.hasAttribute("nt-has-children");
        const toggle = byId("nt-ctx-toggle");
        toggle.hidden = !isParent;
        toggle.setAttribute("label", tab?._ntCollapsed ? "Expand Tree" : "Collapse Tree");

        const anyTrees = gBrowser.tabs.some(t => t.hasAttribute("nt-has-children"));
        byId("nt-ctx-collapse-all").hidden = !eligible || !anyTrees;
        byId("nt-ctx-expand-all").hidden = !eligible || !anyTrees;
      });
    }
  }

  window.gZenNestedTabs = new ZenNestedTabs();
  window.gZenNestedTabs.init().catch(e => console.error("[Zen Nested Tabs] init failed", e));
})();
