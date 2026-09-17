// SPDX-FileCopyrightText: 2011 Giovanni Campagna <gcampagna@src.gnome.org>
// SPDX-FileCopyrightText: 2011 Alessandro Crismani <alessandro.crismani@gmail.com>
// SPDX-FileCopyrightText: 2014 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MOVE_RETRY_TIMEOUT_MS = 300;
const MOVE_RETRY_MAX_ATTEMPTS = 20;

class WindowMover {
    constructor(settings) {
        this._settings = settings;
        this._appSystem = Shell.AppSystem.get_default();
        this._appConfigs = new Map();
        this._appData = new Map();
        this._pendingMoves = new Set();
        this._monitorManager = global.backend.get_monitor_manager();

        this._appSystem.connectObject('installed-changed',
            () => this._updateAppData(), this);

        this._settings.connectObject('changed',
            this._updateAppConfigs.bind(this), this);

        // Fallback for windows that the per-app 'windows-changed' signal
        // misses (e.g. when Shell resolves the window to a different App
        // object or the signal fires before we connect).
        this._displayId = global.display.connect('window-created',
            (_display, window) => this._onWindowCreated(window));

        this._updateAppConfigs();
    }

    _updateAppConfigs() {
        this._appConfigs.clear();

        this._settings.get_strv('application-list').forEach(v => {
            const [appId, num, monitor = ''] = v.split(':');
            this._appConfigs.set(appId, {
                workspaceIndex: parseInt(num) - 1,
                monitor,
            });
        });

        this._updateAppData();
    }

    _updateAppData() {
        const ids = [...this._appConfigs.keys()];
        const removedApps = [...this._appData.keys()]
            .filter(a => !ids.includes(a.id));
        removedApps.forEach(app => {
            app.disconnectObject(this);
            this._appData.delete(app);
        });

        const addedApps = ids
            .map(id => this._appSystem.lookup_app(id))
            .filter(app => app && !this._appData.has(app));
        addedApps.forEach(app => {
            app.connectObject('windows-changed',
                this._appWindowsChanged.bind(this), this);
            this._appData.set(app, {windows: app.get_windows()});
        });
    }

    destroy() {
        this._appSystem.disconnectObject(this);
        this._appSystem = null;

        this._settings.disconnectObject(this);
        this._settings = null;

        if (this._displayId) {
            global.display.disconnect(this._displayId);
            this._displayId = 0;
        }

        this._pendingMoves.clear();
        this._pendingMoves = null;

        this._monitorManager = null;

        this._appConfigs.clear();
        this._updateAppData();
    }

    _getConnector(monitorIndex) {
        const logical = this._monitorManager.get_logical_monitors()
            .find(m => m.get_number() === monitorIndex);
        if (!logical)
            return null;
        const monitors = logical.get_monitors();
        if (!monitors || monitors.length === 0)
            return null;
        return monitors[0].get_connector();
    }

    // Returns true when the monitor requirement is satisfied (moved or
    // nothing to do), false when the window isn't ready yet or the move
    // didn't stick and should be retried later.
    _moveWindow(window, appConfig, retryAttempt = 0) {
        if (window.skip_taskbar)
            return true;

        const current = window.get_monitor();
        const workspaceIndex = appConfig.workspaceIndex;
        const monitorIndex = appConfig.monitor
            ? this._monitorManager.get_monitor_for_connector(appConfig.monitor)
            : -1;

        // The window must actually be mapped on a monitor before
        // move_to_monitor() has any effect; while it's hidden/unplaced
        // mutter only records a target monitor that isn't used for
        // initial placement, which silently discards the move.
        const ready = !window.is_hidden() &&
            window.get_compositor_private() !== null &&
            !window.is_on_all_workspaces();

        log(`[automove-display] moving ${window.get_id()} ` +
            `"${window.get_title()}" ` +
            `wm_class=${window.get_wm_class() ?? window.get_wm_class_instance()} ` +
            `sandboxed=${window.get_sandboxed_app_id() ?? ''} ` +
            `gtk_app=${window.get_gtk_application_id() ?? ''} ` +
            `skip_taskbar=${window.skip_taskbar} ` +
            `ready=${ready} attempt=${retryAttempt} ` +
            `monitor=${current}(${this._getConnector(current) ?? '?'}) ` +
            `target=${appConfig.monitor ? `${appConfig.monitor}(idx=${monitorIndex})` : 'Default'} ` +
            `workspace_target=${workspaceIndex}`);

        if (!ready)
            return false;

        if (monitorIndex >= 0 && current !== monitorIndex) {
            // Move the window to the target monitor before changing the
            // workspace, since the monitor change itself can alter the
            // workspace assignment.
            window.move_to_monitor(monitorIndex);
        }

        // ensure we have the required number of workspaces
        const workspaceManager = global.workspace_manager;
        for (let i = workspaceManager.n_workspaces; i <= workspaceIndex; i++) {
            window.change_workspace_by_index(i - 1, false);
            workspaceManager.append_new_workspace(false, 0);
        }

        window.change_workspace_by_index(workspaceIndex, false);

        return monitorIndex < 0 || window.get_monitor() === monitorIndex;
    }

    _attemptMove(window, appConfig) {
        if (!this._moveWindow(window, appConfig)) {
            if (!this._pendingMoves.has(window))
                this._scheduleRetry(window, appConfig, 1);
        }
    }

    _scheduleRetry(window, appConfig, attempt) {
        if (attempt > MOVE_RETRY_MAX_ATTEMPTS || !window.is_alive) {
            this._pendingMoves.delete(window);
            log(`[automove-display] giving up on ${window.get_id()}: ` +
                'monitor/workspace not applied in time');
            return;
        }

        this._pendingMoves.add(window);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOVE_RETRY_TIMEOUT_MS, () => {
            if (!this._pendingMoves)
                return GLib.SOURCE_REMOVE;
            this._pendingMoves.delete(window);
            if (!window.is_alive)
                return GLib.SOURCE_REMOVE;
            if (!this._moveWindow(window, appConfig, attempt))
                this._scheduleRetry(window, appConfig, attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onWindowCreated(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        if (!app || !this._appConfigs.has(app.id))
            return;

        log(`[automove-display] window-created resolved app ${app.id}`);

        const data = this._appData.get(app);
        if (data && data.windows.includes(window))
            return;

        this._attemptMove(window, this._appConfigs.get(app.id));
    }

    _appWindowsChanged(app) {
        const data = this._appData.get(app);
        const windows = app.get_windows();

        // If get_compositor_private() returns non-NULL on a removed windows,
        // the window still exists and is just moved to a different workspace
        // or something; assume it'll be added back immediately, so keep it
        // to avoid moving it again
        windows.push(...data.windows.filter(w => {
            return !windows.includes(w) && w.get_compositor_private() !== null;
        }));

        const appConfig = this._appConfigs.get(app.id);
        windows.filter(w => !data.windows.includes(w)).forEach(window => {
            this._attemptMove(window, appConfig);
        });
        data.windows = windows;
    }
}

export default class AutoMoveExtension extends Extension {
    enable() {
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(Main.wm._workspaceTracker, '_checkWorkspaces',
            originalMethod => this._getCheckWorkspaceOverride(originalMethod));

        this._windowMover = new WindowMover(this.getSettings());
    }

    disable() {
        this._injectionManager.clear();
        this._injectionManager = null;

        this._windowMover.destroy();
        this._windowMover = null;
    }

    _getCheckWorkspaceOverride(originalMethod) {
        /* eslint-disable no-invalid-this */
        return function () {
            const keepAliveWorkspaces = [];
            let foundNonEmpty = false;
            for (let i = this._workspaces.length - 1; i >= 0; i--) {
                if (!foundNonEmpty) {
                    foundNonEmpty = this._workspaces[i].list_windows().some(
                        w => !w.is_on_all_workspaces());
                } else if (!this._workspaces[i]._keepAliveId) {
                    keepAliveWorkspaces.push(this._workspaces[i]);
                }
            }

            // make sure the original method only removes empty workspaces at the end
            keepAliveWorkspaces.forEach(ws => (ws._keepAliveId = 1));
            try {
                return originalMethod.call(this);
            } finally {
                keepAliveWorkspaces.forEach(ws => delete ws._keepAliveId);
            }
        };
        /* eslint-enable no-invalid-this */
    }
}