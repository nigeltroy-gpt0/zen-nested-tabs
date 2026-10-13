# Zen Nested Tabs

Tree Style Tab–style nesting for Zen's vertical tabs. Zen's tabs keep their usual look and gain parent/child trees you can collapse.

## What it does

- **Automatic nesting.** A tab opened from a link (middle-click, `target=_blank`, `window.open`) becomes a child of the tab that opened it and goes to the end of that tab's children. New tabs from Ctrl/Cmd+T, bookmarks and the URL bar stay at the top level. You can turn this off in the mod's preferences.
- **16px per level by default.** Each level is indented 16px; change it with the *Indent per nesting level* setting (4–64px). Changes apply immediately. Inside a Zen folder, the indent is added on top of the folder's own indent.
- **Carets.** Every tab that has children shows a caret before its favicon. Click it to collapse or expand that tree. Ctrl/Cmd-click collapses or expands every level below it. A collapsed parent shows how many tabs it is hiding (you can turn this off).
- **The sidebar grows with nesting.** The minimum sidebar width is Zen's own minimum plus one indent (16px by default) for each visible level. If a new level doesn't fit, the sidebar widens to the new minimum. When nesting gets shallower, the minimum drops, so you can drag the sidebar narrower again, but the mod never shrinks it for you. Zen's drag-to-resize respects the same minimum.
- **Essentials are never nested.** Essentials, Glance previews and Zen's empty placeholder tab are left out completely.
- **Drag and drop works like TST.** When you drop a tab, its parent comes from where it lands. Dropping it right under a parent makes it that parent's first child. Dropping it among a parent's children makes it their sibling. Its own children move with it.
- **Closing a parent.** Choose one of: *Close the whole tree*, *Close the whole tree, only if collapsed*, or *Move children up one level* (the default).
- **Tab context menu.** *Nest Under Tab Above*, *Move Out One Level*, *Collapse/Expand Tree*, *Collapse All Trees*, *Expand All Trees*.
- **The tree is saved with your session**, using SessionStore's custom tab values, so it survives restarts.

Trees stay inside one list: a space's normal tabs, its pinned tabs, or a single folder. If a tab moves to another list (pinning it, putting it in a folder, moving it to another space), it leaves its tree.

## Why this needs JavaScript

Zen Mods from the official store are CSS only. CSS can indent and hide tabs, but it can't track which tab opened which, save the tree, handle a caret click, or resize the sidebar. So this mod comes in two parts:

| File | Role |
| --- | --- |
| `chrome.css` | All the visuals: indent, caret, counter, guide lines, hiding collapsed tabs |
| `js/nested-tabs.uc.js` | The tree model, event handling, session saving, sidebar width |
| `preferences.json` | Preferences, in the Zen Mods / Sine format |
| `theme.json` | Mod manifest, in the Sine format (declares the script) |

## Install

### Option A: Sine (recommended)

[Sine](https://github.com/CosmoCreeper/Sine) is a community mod manager that supports the Zen mod format and also loads `.uc.js` scripts.

1. Install Sine (see its README).
2. The mod is hosted at `nigeltroy-gpt0/zen-nested-tabs`.
3. Open **Settings → Sine Mods** and add the mod by entering `nigeltroy-gpt0/zen-nested-tabs`.
4. Sine only runs JavaScript from mods outside its store if you allow it. Turn on Sine's option to allow unsafe JS for non-store mods, then restart Zen.

### Option B: fx-autoconfig by hand

1. Install [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) for Zen. [zen-autoconfig-script](https://github.com/RayZ3R0/zen-autoconfig-script) can do this for you.
2. Copy `js/nested-tabs.uc.js` to `<profile>/chrome/JS/`.
3. Add `@import "nested-tabs.css";` to the top of `<profile>/chrome/userChrome.css`, and copy `chrome.css` to `<profile>/chrome/nested-tabs.css`.
4. To change the defaults, set the `mod.nestedtabs.*` preferences in `about:config`. The script registers the defaults itself.
5. Open `about:support`, click **Clear startup cache…**, and restart.

## Preferences

| Pref | Default | |
| --- | --- | --- |
| `mod.nestedtabs.auto_nest` | `true` | Nest tabs opened from links |
| `mod.nestedtabs.indent` | `16` | Indent per nesting level in px (4–64); also sets how much the sidebar's minimum width grows per level |
| `mod.nestedtabs.show_guides` | `true` | Faint vertical guide lines for each level |
| `mod.nestedtabs.show_count` | `true` | Hidden-tab count on collapsed parents |
| `mod.nestedtabs.close_behavior` | `promote` | `close_all`, `close_collapsed` or `promote` |

## Debugging

In the Browser Console (Ctrl/Cmd+Shift+J), `gZenNestedTabs` is the live instance. For example, `gZenNestedTabs.normalize()` forces a re-render. Each tab has `_ntId`, `_ntParentId` and `_ntCollapsed`, and the attributes `nt-depth`, `nt-has-children`, `nt-collapsed` and `nt-hidden`.
