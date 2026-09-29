// dsh-file-link-menu — 右键菜单 for markdown file links in the DSH Web UI.
// Identifies DSH markdown file links (button.fileMention.fileLink rendered by
// @deepseek-ai/dsh-client-ui-primitives MarkdownFileLink, plus a[href^="dsh-resource://file/"]),
// and offers: open with an associated application (Session Remote) / reveal in file
// manager / copy absolute path / copy relative path. Non-file targets keep the
// browser's native context menu untouched.
window.__ModuleLoader__.load({
  id: 'dsh-file-link-menu',
  factory(require) {
    'use strict';

    const RESOURCE_PREFIX = 'dsh-resource://file/session/';
    const ABS_PATH_RE = /^(?:\/|\\|[a-zA-Z]:[\\/])/;
    const FILE_CLASS_RE = /fileMention|fileLink/;
    const MAX_APPS = 10;
    const state = { remote: null, sessions: null };

    function isLikelyPath(value) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
      if (/[\u0000-\u001f\u007f]/.test(value)) return false;
      if (/^(?:https?:|dsh-resource:|dsh-app:|data:|mailto:|javascript:)/i.test(value)) return false;
      const bare = value.replace(/:\d+(?:-\d+)?(?::\d+)?$/, '');
      if (bare.length === 0) return false;
      if (ABS_PATH_RE.test(bare)) return true;
      if (bare.includes('/') || bare.includes('\\')) return true;
      return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|go|rs|java|kt|kts|swift|c|h|cpp|hpp|cc|hh|m|mm|cs|rb|php|vue|svelte|css|scss|less|html|htm|xml|yaml|yml|toml|ini|conf|sh|bash|zsh|sql|proto|graphql|gql|gradle|lock|txt|log|csv)$/i.test(bare);
    }

    function parseResourceAddress(href) {
      if (typeof href !== 'string' || !href.startsWith(RESOURCE_PREFIX)) return undefined;
      const rest = href.slice(RESOURCE_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) return undefined;
      try {
        const sessionId = decodeURIComponent(rest.slice(0, slash));
        const raw = rest.slice(slash + 1).split('?')[0];
        const hash = raw.indexOf('#');
        const noHash = hash < 0 ? raw : raw.slice(0, hash);
        const path = noHash.split('/').map((segment) => decodeURIComponent(segment)).join('/');
        return path ? { sessionId, path } : undefined;
      } catch {
        return undefined;
      }
    }

    function sessionsSnapshot() {
      try {
        return state.sessions?.list?.getSnapshot?.() ?? null;
      } catch {
        return null;
      }
    }

    function cwdOf(sessionId) {
      const snapshot = sessionsSnapshot();
      const row = sessionId && snapshot?.byId?.[sessionId];
      if (typeof row?.cwd === 'string' && row.cwd) return row.cwd;
      const rows = snapshot?.byId ? Object.values(snapshot.byId) : [];
      const main = rows.find((entry) => (entry?.retainedBy?.mainView ?? 0) > 0)
        ?? rows.find((entry) => typeof entry?.cwd === 'string' && entry.cwd);
      return typeof main?.cwd === 'string' && main.cwd ? main.cwd : undefined;
    }

    function toAbsolute(path, sessionId) {
      if (ABS_PATH_RE.test(path)) return path;
      const cwd = cwdOf(sessionId);
      if (!cwd) return undefined;
      return cwd.replace(/\/+$/, '') + '/' + path.replace(/^\.\//, '').replace(/^\/+/, '');
    }

    function relativeFrom(path, abs) {
      if (!ABS_PATH_RE.test(path)) return path;
      const cwd = cwdOf();
      const trimmed = cwd ? cwd.replace(/\/+$/, '') : undefined;
      if (trimmed && abs.startsWith(trimmed + '/')) return abs.slice(trimmed.length + 1);
      return undefined;
    }

    // ---------------------------------------------------------------- menu ---

    let menu = null;
    const dismissers = [];

    function bindDismiss() {
      const onPointerDown = (event) => {
        if (menu && !menu.contains(event.target)) closeMenu();
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') closeMenu();
      };
      const onScrollResize = () => closeMenu();
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onScrollResize, true);
      window.addEventListener('resize', onScrollResize);
      dismissers.push(() => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', onScrollResize, true);
        window.removeEventListener('resize', onScrollResize);
      });
    }

    function closeMenu() {
      menu?.remove();
      menu = null;
      while (dismissers.length) {
        try { dismissers.pop()?.(); } catch { /* ignore */ }
      }
    }

    function el(tag, className, children) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      for (const child of children ?? []) {
        if (child === null || child === undefined) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
      return node;
    }

    function iconImg(src) {
      if (!src) return null;
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.className = 'flm-app-icon';
      img.addEventListener('error', () => img.remove(), { once: true });
      return img;
    }

    async function openWorkspacePath(request) {
      const response = await state.remote.session.openWorkspacePath(request);
      if (!response || response.ok !== true) throw new Error('openWorkspacePath rejected');
    }

    async function queryApplications(abs, signal) {
      try {
        const response = await state.remote.session.workspacePathApplications({ path: abs }, signal);
        if (!response || response.ok !== true) return null;
        const value = response.value;
        return Array.isArray(value) ? value : Array.isArray(value?.apps) ? value.apps : null;
      } catch {
        return null;
      }
    }

    function copyText(text) {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
      }
      return Promise.resolve(legacyCopy(text));
    }

    function legacyCopy(text) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      area.remove();
    }

    function menuItem(label, action, options) {
      const disabled = options?.disabled === true;
      const item = el('div', 'flm-item' + (disabled ? ' flm-disabled' : ''), [label]);
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        if (disabled) return;
        closeMenu();
        Promise.resolve()
          .then(action)
          .catch((error) => {
            console.warn('[file-link-menu] action failed:', error);
          });
      });
      return item;
    }

    function appRow(app, abs) {
      const row = el('div', 'flm-item flm-app-row', [
        iconImg(app?.icon),
        el('span', 'flm-app-name', [String(app?.name ?? app?.id ?? '应用')]),
        app?.default === true ? el('span', 'flm-app-default', ['（默认）']) : null,
      ]);
      row.setAttribute('role', 'menuitem');
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenu();
        openWorkspacePath({ path: abs, application: app.id }).catch((error) => {
          console.warn('[file-link-menu] open with app failed:', error);
        });
      });
      return row;
    }

    function renderApplications(container, abs) {
      container.replaceChildren(el('div', 'flm-item flm-muted', ['读取打开方式…']));
      const controller = new AbortController();
      dismissers.push(() => controller.abort());
      queryApplications(abs, controller.signal).then((apps) => {
        if (!container.isConnected || !menu) return;
        container.replaceChildren();
        if (!apps || apps.length === 0) {
          container.appendChild(menuItem('用默认应用打开', () => openWorkspacePath({ path: abs })));
          return;
        }
        const ordered = [...apps]
          .sort((a, b) => Number(b?.default === true) - Number(a?.default === true))
          .slice(0, MAX_APPS);
        for (const app of ordered) container.appendChild(appRow(app, abs));
      });
    }

    function openMenu(x, y, info) {
      const abs = info.abs;
      const canOpen = Boolean(abs) && Boolean(state.remote?.session);
      const canCopyAbs = Boolean(abs);
      const rel = relativeFrom(info.path, abs ?? '');

      const menuChildren = [];
      if (canOpen) menuChildren.push(
        el('div', 'flm-group-label', ['打开']),
        el('div', 'flm-apps'),
        el('div', 'flm-sep'),
      );
      if (canOpen) menuChildren.push(
        menuItem('显示文件位置', () => openWorkspacePath({ path: abs, action: 'reveal' })),
      );
      menuChildren.push(el('div', 'flm-sep'));
      menuChildren.push(
        menuItem('复制绝对路径', () => copyText(abs), { disabled: !canCopyAbs }),
        menuItem('复制相对路径', () => copyText(rel ?? info.path)),
      );

      menu = el('div', 'flm-menu', menuChildren);
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-file-link-menu', '');
      document.body.appendChild(menu);

      const width = Math.max(menu.offsetWidth, 210);
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + 'px';
      const height = menu.offsetHeight || 180;
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - height - 8)) + 'px';

      bindDismiss();
      if (canOpen) renderApplications(menu.querySelector('.flm-apps'), abs);
    }

    // ---------------------------------------------------------------- style ---

    const STYLE_ID = 'file-link-menu-style';
    const STYLE_TEXT = `
      .flm-menu {
        position: fixed; z-index: 2147483000; min-width: 210px; max-width: 340px;
        padding: 5px; margin: 0; user-select: none;
        border-radius: var(--dsw-radius-lg, 10px);
        border: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.22));
        background: var(--dsw-alias-bg-layer-1, #fff);
        color: var(--dsw-alias-label-primary, #1f2328);
        box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.18));
        font: 500 12.5px/1.45 var(--dsw-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif);
        cursor: default;
      }
      .flm-group-label {
        padding: 4px 10px 3px; font-size: 11px; font-weight: 600;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      .flm-item {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-radius: var(--dsw-radius-md, 7px);
        color: var(--dsw-alias-label-primary, #1f2328); white-space: nowrap;
      }
      .flm-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
      .flm-apps .flm-item { min-width: 190px; }
      .flm-app-row { max-width: 330px; }
      .flm-app-icon { width: 15px; height: 15px; flex: 0 0 15px; border-radius: 3px; }
      .flm-app-name { overflow: hidden; text-overflow: ellipsis; }
      .flm-app-default { color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 11.5px; }
      .flm-muted { color: var(--dsw-alias-label-tertiary, #8a8f98); }
      .flm-disabled { color: var(--dsw-alias-label-tertiary, #8a8f98); pointer-events: none; }
      .flm-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-secondary, rgba(127,127,127,.18)); }
      .flm-diag { padding: 6px 10px; max-width: 420px; font-size: 11.5px; line-height: 1.5;
        color: var(--dsw-alias-label-tertiary, #8a8f98); white-space: normal; word-break: break-all; }
    `;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
    }

    // ------------------------------------------------------------ targeting ---

    function resolveTarget(target) {
      if (!target || typeof target.closest !== 'function') return undefined;
      if (target.closest('.flm-menu')) return undefined;
      if (target.closest('input, textarea, [contenteditable="true"]')) return undefined;

      // 1) DSH resource-address links: <a href="dsh-resource://file/session/<id>/<path>">
      const anchor = target.closest('a[href]');
      if (anchor) {
        const parsed = parseResourceAddress(anchor.getAttribute('href'));
        if (parsed) return parsed;
      }

      // 2) Explicit opt-in marker.
      const marked = target.closest('[data-file-path]');
      if (marked) {
        const value = marked.getAttribute('data-file-path');
        if (value && isLikelyPath(value)) return { path: value };
      }

      // 3) Markdown file links render as <button title="<path>">. The title is the stable
      //    signal; CSS-module class names are build-generated and must not be required.
      const button = target.closest('button');
      if (button) {
        const title = button.getAttribute('title');
        if (title && isLikelyPath(title)) return { path: title };
        const className = typeof button.className === 'string' ? button.className : '';
        if (FILE_CLASS_RE.test(className)) {
          const label = (button.textContent ?? '').trim().replace(/:\d+(?:-\d+)?(?::\d+)?$/, '');
          if (isLikelyPath(label)) return { path: label };
        }
      }

      // 4) Inline code whose whole text is a file path — plain-text paths in chat output
      //    (e.g. `src/devices/h5/runtime.ts:250-261`) are printed this way. Fenced code
      //    blocks are excluded so code editing keeps its native context menu.
      const code = target.closest('code');
      if (code && !code.closest('pre')) {
        const text = (code.textContent ?? '').trim();
        if (isLikelyPath(text)) return { path: text };
      }

      return undefined;
    }

    let probeEl = null;
    function setProbe(text) {
      try {
        if (!probeEl || !probeEl.isConnected) {
          probeEl = document.createElement('div');
          probeEl.id = 'flm-probe';
          probeEl.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;padding:2px 8px;border-radius:10px;background:#e5484d;color:#fff;font:600 11px/1.7 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 0 0 2px rgba(255,255,255,.65);pointer-events:none;white-space:nowrap';
          (document.body ?? document.documentElement).appendChild(probeEl);
        }
        probeEl.textContent = text;
      } catch { /* ignore */ }
    }

    function onContextMenu(event) {
      if (event.__flmHandled === true) return;
      event.__flmHandled = true;
      try {
        if (event.defaultPrevented) return;
        if (event.target?.closest?.('.flm-menu')) return;
        const hit = resolveTarget(event.target);
        if (hit === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        openMenu(event.clientX, event.clientY, {
          path: hit.path,
          abs: toAbsolute(hit.path, hit.sessionId),
        });
      } catch (error) {
        // Silent in normal use; a red badge appears only if the menu build ever throws.
        setProbe(`FLM 错误: ${String(error?.message ?? error).slice(0, 80)}`);
      }
    }

    // ---------------------------------------------------------------- apply ---

    return {
      inject: ['slots', 'remote', 'remote.session', 'sessions'],
      apply(ctx) {
        state.remote = ctx.remote;
        state.sessions = ctx.sessions;
        // The client module system executes a plugin's side effects only once something
        // uses it ("插件首次被使用之前什么都不会运行"). Registering a slot gives the shell
        // that consumer, so the contextmenu listener below actually gets installed; the
        // rendered component itself is intentionally empty.
        for (const slotName of ['conversation.session.header.utilities', 'conversation.composer.dock']) {
          try {
            ctx.slots.inject(slotName, () => ctx.slots.register({
              name: slotName,
              id: 'file-link-menu',
              order: 50,
            }, () => null));
          } catch (error) {
            console.warn('[file-link-menu] slot registration failed:', slotName, error);
          }
        }
        // Registering on window + document at apply() top level, so a missing effect run or
        // an earlier capturing listener cannot silently swallow the gesture.
        try { ensureStyle(); } catch (error) { console.warn('[file-link-menu] style injection failed:', error); }
        window.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('contextmenu', onContextMenu, true);
        ctx.effect(() => () => {
          window.removeEventListener('contextmenu', onContextMenu, true);
          document.removeEventListener('contextmenu', onContextMenu, true);
          document.getElementById(STYLE_ID)?.remove();
          closeMenu();
        }, 'file-link-menu: contextmenu listener');
      },
    };
  },
});
