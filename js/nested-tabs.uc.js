// ==UserScript==
// @name           Zen Nested Tabs
// @description    Tree Style Tab-like nesting for Zen Browser's vertical tabs.
// @include        main
// @version        1.0.0
// ==/UserScript==

/*
 * Model
 * -----
 * The tree is stored as one parent pointer per tab (a stable id saved with
 * SessionStore custom tab values). Tab order is never stored: it is whatever
 * order the tabs are in the sidebar. `#normalize()` walks the tabs in order and
 * enforces the one invariant that matters: a tab's parent must appear above it
 * in the same container, with only that parent's descendants in between. Any
 * tab that breaks the rule becomes a root tab. Depth, carets, collapsing and
 * the minimum sidebar width are all derived from that single walk.
 *
 * Containers: nesting only happens between tabs that share a DOM parent (the
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

  const INDENT_PX = 16;

  const PREF_AUTO_NEST = "mod.nestedtabs.auto_nest";
  const PREF_CLOSE_BEHAVIOR = "mod.nestedtabs.close_behavior";

  const KEY_ID = "zenNestedTabsId";
  const KEY_PARENT = "zenNestedTabsParent";
  const KEY_COLLAPSED = "zenNestedTabsCollapsed";

  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  });

  const newId = () => Services.uuid.generateUUID().toString().slice(1, -1);

  class ZenNestedTabs {
    /** Extra px Zen's getSidebarMinWidth() should add for the current nesting. */
    #extraMinWidth = 0;
    /** >0 while we are moving tabs ourselves; TabMove handling is skipped. */
    #internalMoves = 0;
    #initialized = false;
    #normalizeQueued = false;

    async init() {
      // Mod managers don't reliably apply preferences.json defaults, and the
      // CSS -moz-pref() queries treat a missing pref as false.
      const defaults = Services.prefs.getDefaultBranch("");
      defaults.setBoolPref(PREF_AUTO_NEST, true);
      defaults.setBoolPref("mod.nestedtabs.show_guides", true);
      defaults.setBoolPref("mod.nestedtabs.show_count", true);
      defaults.setStringPref(PREF_CLOSE_BEHAVIOR, "promote");

      await this.#whenDelayedStartupFinished();
      await window.gZenWorkspaces?.promiseInitialized;
      await lazy.SessionStore.promiseAllWindowsRestored;

      for (const tab of gBrowser.tabs) {
        this.#loadFromSession(tab);
      }

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

    normalize() {
      if (!this.#initialized) {
        return;
      }
      const activeSpace = window.gZenWorkspaces?.activeWorkspace;
      let maxVisibleDepth = 0;

      // Group eligible tabs by container, keeping sidebar order.
      const containers = new Map();
      for (const tab of gBrowser.tabs) {
        if (!this.isEligible(tab)) {
          this.#clearTab(tab);
          continue;
        }
        if (!tab._ntPersisted) {
          this.#save(tab);
        }
        if (!containers.has(tab.parentNode)) {
          containers.set(tab.parentNode, []);
        }
        containers.get(tab.parentNode).push(tab);
      }

      for (const tabs of containers.values()) {
        const stack = []; // ancestors of the current position
        const info = new Map(); // tab -> { depth, hidden, descendants }

        for (const tab of tabs) {
          let parentIndex = -1;
          if (tab._ntParentId) {
            parentIndex = stack.findLastIndex(t => t._ntId === tab._ntParentId);
            if (parentIndex === -1) {
              // Parent is gone, elsewhere, or not directly above us: detach.
              tab._ntParentId = null;
              this.#save(tab);
            }
          }
          stack.length = parentIndex + 1;

          const depth = stack.length;
          const hidden = stack.some(t => t._ntCollapsed);
          for (const ancestor of stack) {
            info.get(ancestor).descendants++;
          }
          info.set(tab, { depth, hidden, descendants: 0 });
          stack.push(tab);

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
          this.#renderTab(tab, depth, hidden, descendants);
        }
      }

      this.#updateSidebarWidth(maxVisibleDepth);
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
      if (!twisty) {
        twisty = document.createXULElement("hbox");
        twisty.className = "nt-twisty";
        twisty.setAttribute("role", "button");
        content.prepend(twisty);
      }
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
      return { twisty, count };
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
      const extra = maxDepth * INDENT_PX;
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

    #addListeners() {
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
        case "dragstart":
          this.#onTwistyEvent(event);
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
      const opener = tab.openerTab;
      if (!opener || !Services.prefs.getBoolPref(PREF_AUTO_NEST, true)) {
        this.scheduleNormalize();
        return;
      }

      // Zen places the tab into its space/section after TabOpen; wait for that.
      setTimeout(() => {
        if (
          this.isEligible(tab) &&
          this.isEligible(opener) &&
          !tab.pinned &&
          !tab._ntParentId &&
          tab.parentNode === opener.parentNode
        ) {
          this.nestUnder(tab, opener);
        } else {
          this.scheduleNormalize();
        }
      }, 0);
    }

    #onTabClose(tab) {
      const children = this.childrenOf(tab);
      if (!children.length) {
        this.scheduleNormalize();
        return;
      }

      const closeTree =
        tab._ntCollapsed && Services.prefs.getStringPref(PREF_CLOSE_BEHAVIOR, "promote") === "close_collapsed";

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
      if (this.#internalMoves || !this.#initialized || !this.isEligible(tab)) {
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

      const list = this.#siblingsInContainer(tab).filter(t => !subtree.has(t));
      const index = list.indexOf(tab);
      const next = list[index + 1] || null;
      const prev = list[index - 1] || null;

      let newParent = null;
      if (next && next._ntParentId) {
        // Landing above a nested tab means joining that tab's level.
        const nextParent = this.parentOf(next, map);
        if (nextParent && nextParent !== tab && list.indexOf(nextParent) < index) {
          newParent = nextParent;
        }
      }
      if (newParent && prev && newParent !== prev && !this.#isAncestor(newParent, prev, map)) {
        newParent = null;
      }

      this.setParent(tab, newParent);
      if (newParent) {
        this.#expandAncestors(tab);
      }

      const ordered = gBrowser.tabs.filter(t => subtree.has(t));
      this.#bringDescendants(tab, ordered);
      this.scheduleNormalize();
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
