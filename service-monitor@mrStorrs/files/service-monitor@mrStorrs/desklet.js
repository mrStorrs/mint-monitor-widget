"use strict";

const ServiceState = require("./serviceState.js");
const IS_NODE = typeof imports === "undefined";
const UUID = "service-monitor@mrStorrs";

let Clutter;
let Desklet;
let Gettext;
let Gio;
let GLib;
let Main;
let Settings;
let St;

if (!IS_NODE) {
    Clutter = imports.gi.Clutter;
    Gio = imports.gi.Gio;
    GLib = imports.gi.GLib;
    St = imports.gi.St;
    Desklet = imports.ui.desklet;
    Gettext = imports.gettext;
    Main = imports.ui.main;
    Settings = imports.ui.settings;
    Gettext.bindtextdomain(
        UUID,
        GLib.build_filenamev([GLib.get_home_dir(), ".local", "share", "locale"])
    );
}

function translate(text) {
    return IS_NODE ? text : Gettext.dgettext(UUID, text);
}

function formatText(template, ...values) {
    let index = 0;
    return template.replace(/%[sd]/g, () => String(values[index++]));
}

class ServiceMonitorCore {
    constructor(adapters) {
        this._query = adapters.query;
        this._render = adapters.render;
        this._notify = adapters.notify;
        this._notificationsEnabled = adapters.notificationsEnabled || (() => true);
        this._tracker = new ServiceState.TransitionTracker();
        this._entries = [];
        this._ignoredCount = 0;
        this._generation = 0;
        this._inFlight = false;
        this._refreshPending = false;
        this._removed = false;
        this._hasSnapshot = false;
    }

    setWatchlist(rawEntries) {
        const normalized = ServiceState.normalizeWatchlist(rawEntries);
        this._entries = normalized.entries;
        this._ignoredCount = normalized.ignoredCount;
        this._generation += 1;
        if (this._inFlight)
            this._refreshPending = true;
        this._hasSnapshot = false;
        this._tracker.reset();

        if (this._entries.length === 0)
            this._render(this._emptyView());
        else
            this._render(this._checkingView());
    }

    refresh() {
        if (this._removed || this._inFlight)
            return Promise.resolve(false);

        if (this._entries.length === 0) {
            this._render(this._emptyView());
            return Promise.resolve(true);
        }

        this._inFlight = true;
        const generation = this._generation;
        if (!this._hasSnapshot)
            this._render(this._checkingView());

        const grouped = ServiceState.groupEntriesByScope(this._entries);
        const requests = [];

        for (const scope of ["system", "user"]) {
            if (grouped[scope].length === 0)
                continue;

            let response;
            try {
                response = this._query(scope, grouped[scope]);
            } catch (error) {
                response = Promise.reject(error);
            }

            requests.push(
                Promise.resolve(response).then(
                    tuples => ({scope, tuples, failed: false}),
                    () => ({scope, tuples: [], failed: true})
                )
            );
        }

        return Promise.all(requests).then(results => {
            if (this._removed)
                return false;

            if (generation !== this._generation) {
                this._inFlight = false;
                if (this._refreshPending) {
                    this._refreshPending = false;
                    return this.refresh();
                }
                return false;
            }

            this._inFlight = false;
            const tuplesByScope = {
                system: new Map(),
                user: new Map()
            };
            const failedScopes = new Set();

            for (const result of results) {
                if (result.failed || !Array.isArray(result.tuples)) {
                    failedScopes.add(result.scope);
                    continue;
                }

                for (const tuple of result.tuples) {
                    if (Array.isArray(tuple) && typeof tuple[0] === "string")
                        tuplesByScope[result.scope].set(tuple[0], tuple);
                }
            }

            const rows = this._entries.map(entry => {
                const tuple = failedScopes.has(entry.scope)
                    ? null
                    : tuplesByScope[entry.scope].get(entry.unit) || null;
                return {
                    ...entry,
                    state: ServiceState.classifyUnit(tuple)
                };
            });
            const events = this._tracker.update(rows);
            this._hasSnapshot = true;

            this._render({
                kind: "services",
                rows,
                ignoredCount: this._ignoredCount,
                canOpenSettings: true,
                summary: ServiceState.summarizeStates(
                    rows.map(row => row.state),
                    {checking: false}
                )
            });

            if (this._notificationsEnabled()) {
                const rowsByKey = new Map(rows.map(row => [row.key, row]));
                for (const event of events)
                    this._notify({...event, row: rowsByKey.get(event.key)});
            }

            return true;
        });
    }

    remove() {
        this._removed = true;
        this._generation += 1;
        this._inFlight = false;
        this._refreshPending = false;
    }

    _emptyView() {
        return {
            kind: "empty",
            rows: [],
            ignoredCount: this._ignoredCount,
            canOpenSettings: true,
            summary: ServiceState.summarizeStates([], {checking: false})
        };
    }

    _checkingView() {
        const rows = this._entries.map(entry => ({
            ...entry,
            state: ServiceState.unavailableState()
        }));
        return {
            kind: "checking",
            rows,
            ignoredCount: this._ignoredCount,
            canOpenSettings: true,
            summary: ServiceState.summarizeStates(
                rows.map(row => row.state),
                {checking: true}
            )
        };
    }
}

function journalArguments(entry) {
    if (!ServiceState.isValidServiceUnit(entry.unit))
        throw new Error(`Invalid service unit: ${entry.unit}`);
    if (entry.scope !== "system" && entry.scope !== "user")
        throw new Error(`Invalid service scope: ${entry.scope}`);

    const args = ["journalctl"];
    if (entry.scope === "user")
        args.push("--user");
    args.push("--unit", entry.unit, "--lines", "100", "--follow");
    return args;
}

function launchJournal(entry, terminalArgv, terminalExecArgv, adapters) {
    const journalArgv = journalArguments(entry);
    const command = journalArgv.join(" ");

    try {
        if (!Array.isArray(terminalArgv) || terminalArgv.length === 0)
            throw new Error("No terminal command is configured");

        adapters.spawn([
            ...terminalArgv,
            ...(Array.isArray(terminalExecArgv) ? terminalExecArgv : []),
            ...journalArgv
        ]);
        return true;
    } catch (error) {
        adapters.copy(command);
        adapters.notifyFallback(entry);
        return false;
    }
}

function parseCommandField(value) {
    if (typeof value !== "string" || value.trim() === "")
        return [];

    const [success, argv] = GLib.shell_parse_argv(value);
    return success ? argv : [];
}

function summaryText(summary) {
    if (summary.kind === "empty")
        return translate("No services configured");
    if (summary.kind === "checking") {
        const template = summary.total === 1
            ? translate("Checking %d service\u2026")
            : translate("Checking %d services\u2026");
        return formatText(template, summary.total);
    }
    if (summary.kind === "healthy") {
        const template = summary.total === 1
            ? translate("All %d service healthy")
            : translate("All %d services healthy");
        return formatText(template, summary.total);
    }

    const template = summary.total === 1
        ? translate("%d of %d service needs attention")
        : translate("%d of %d services need attention");
    return formatText(template, summary.attention, summary.total);
}

function colorWithTransparency(color, transparency) {
    const alpha = 1 - Math.min(1, Math.max(0, Number(transparency)));
    const rgbMatch = String(color).match(
        /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/
    );
    if (rgbMatch)
        return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;

    const hexMatch = String(color).match(/^#([0-9a-f]{6})$/i);
    if (hexMatch) {
        const value = hexMatch[1];
        const red = parseInt(value.slice(0, 2), 16);
        const green = parseInt(value.slice(2, 4), 16);
        const blue = parseInt(value.slice(4, 6), 16);
        return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }

    return `rgba(31, 36, 43, ${alpha})`;
}

let ServiceMonitorDesklet = null;

if (!IS_NODE) {
    ServiceMonitorDesklet = class ServiceMonitorDesklet extends Desklet.Desklet {
        constructor(metadata, deskletId) {
            super(metadata, deskletId);

            this._active = false;
            this._timerId = 0;
            this._managerProxies = {system: null, user: null};
            this._cancellable = new Gio.Cancellable();
            this._terminalSettings = new Gio.Settings({
                schema_id: "org.cinnamon.desktop.default-applications.terminal"
            });

            this.services = [];
            this.refreshInterval = 5;
            this.showNotifications = true;
            this.backgroundColor = "rgb(31,36,43)";
            this.backgroundTransparency = 0.08;
            this.textSize = 14;

            this._card = new St.BoxLayout({
                vertical: true,
                style_class: "service-monitor-card"
            });
            this.setContent(this._card);
            this.setHeader(translate("Service Monitor"));

            this._settings = new Settings.DeskletSettings(
                this,
                metadata.uuid,
                deskletId
            );
            this._settings.bind(
                "services",
                "services",
                this._onServicesChanged.bind(this)
            );
            this._settings.bind(
                "refresh-interval",
                "refreshInterval",
                this._onRefreshIntervalChanged.bind(this)
            );
            this._settings.bind(
                "show-notifications",
                "showNotifications"
            );
            this._settings.bind(
                "background-color",
                "backgroundColor",
                this._onAppearanceChanged.bind(this)
            );
            this._settings.bind(
                "background-transparency",
                "backgroundTransparency",
                this._onAppearanceChanged.bind(this)
            );
            this._settings.bind(
                "text-size",
                "textSize",
                this._onAppearanceChanged.bind(this)
            );

            this._core = new ServiceMonitorCore({
                query: this._queryUnits.bind(this),
                render: this._render.bind(this),
                notify: this._notifyTransition.bind(this),
                notificationsEnabled: () => this.showNotifications
            });
            this._applyAppearance();
            this._core.setWatchlist(this.services);
        }

        on_desklet_added_to_desktop() {
            this._active = true;
            this._core.refresh();
            this._restartTimer();
        }

        on_desklet_removed() {
            this._active = false;
            if (this._timerId !== 0) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
            this._cancellable.cancel();
            this._core.remove();
            this._settings.finalize();
        }

        _onServicesChanged() {
            if (!this._core)
                return;

            this._core.setWatchlist(this.services);
            if (this._active)
                this._core.refresh();
        }

        _onRefreshIntervalChanged() {
            if (this._active)
                this._restartTimer();
        }

        _onAppearanceChanged() {
            if (this._card)
                this._applyAppearance();
        }

        _restartTimer() {
            if (this._timerId !== 0) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }

            const interval = ServiceState.clampPollInterval(this.refreshInterval);
            this._timerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                interval,
                () => {
                    this._core.refresh();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        _getManagerProxy(scope) {
            if (this._managerProxies[scope])
                return this._managerProxies[scope];

            const busType = scope === "user"
                ? Gio.BusType.SESSION
                : Gio.BusType.SYSTEM;
            const pending = new Promise((resolve, reject) => {
                Gio.DBusProxy.new_for_bus(
                    busType,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    "org.freedesktop.systemd1",
                    "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager",
                    this._cancellable,
                    (source, result) => {
                        try {
                            resolve(Gio.DBusProxy.new_for_bus_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            });

            this._managerProxies[scope] = pending.catch(error => {
                this._managerProxies[scope] = null;
                throw error;
            });
            return this._managerProxies[scope];
        }

        _queryUnits(scope, units) {
            return this._getManagerProxy(scope).then(proxy => new Promise(
                (resolve, reject) => {
                    proxy.call(
                        "ListUnitsByNames",
                        new GLib.Variant("(as)", [units]),
                        Gio.DBusCallFlags.NONE,
                        10000,
                        this._cancellable,
                        (source, result) => {
                            try {
                                resolve(source.call_finish(result).deep_unpack()[0]);
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                }
            ));
        }

        _render(view) {
            for (const child of this._card.get_children())
                child.destroy();

            const heading = new St.BoxLayout({
                vertical: true,
                style_class: "service-monitor-heading"
            });
            heading.add_child(new St.Label({
                text: translate("Service Monitor"),
                style_class: "service-monitor-title"
            }));
            heading.add_child(new St.Label({
                text: summaryText(view.summary),
                style_class: `service-monitor-summary service-monitor-summary-${view.summary.kind}`
            }));
            this._card.add_child(heading);

            if (view.kind === "empty") {
                const settingsButton = new St.Button({
                    label: translate("Open settings"),
                    style_class: "service-monitor-settings-button",
                    reactive: true,
                    can_focus: true
                });
                settingsButton.connect("clicked", () => this.configureDesklet());
                this._card.add_child(settingsButton);
            } else {
                for (const row of view.rows)
                    this._card.add_child(this._createServiceRow(row));
            }

            if (view.ignoredCount > 0) {
                const template = view.ignoredCount === 1
                    ? translate("%d configuration entry was ignored.")
                    : translate("%d configuration entries were ignored.");
                this._card.add_child(new St.Label({
                    text: formatText(template, view.ignoredCount),
                    style_class: "service-monitor-warning"
                }));
            }
        }

        _createServiceRow(row) {
            const content = new St.BoxLayout({
                style_class: "service-monitor-row-content",
                x_expand: true
            });
            content.add_child(new St.Label({
                text: this._statusGlyph(row.state.kind),
                style_class: `service-monitor-indicator service-monitor-${row.state.kind}`
            }));
            content.add_child(new St.Label({
                text: row.label,
                style_class: "service-monitor-name",
                x_expand: true,
                x_align: Clutter.ActorAlign.START
            }));
            content.add_child(new St.Label({
                text: translate(row.state.label),
                style_class: `service-monitor-state service-monitor-${row.state.kind}`,
                x_align: Clutter.ActorAlign.END
            }));

            const button = new St.Button({
                child: content,
                style_class: "service-monitor-row",
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_fill: true,
                accessible_name: formatText(
                    translate("Open the journal for %s"),
                    row.label
                )
            });
            button.connect("clicked", () => this._openJournal(row));
            button.connect("key-press-event", (actor, event) => {
                const symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                    this._openJournal(row);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return button;
        }

        _statusGlyph(kind) {
            if (kind === "healthy")
                return "\u25cf";
            if (kind === "transitional")
                return "\u25c6";
            if (kind === "unhealthy" || kind === "missing")
                return "\u25b2";
            return "\u25cb";
        }

        _notifyTransition(event) {
            if (event.type === "failure") {
                Main.notify(
                    translate("Service needs attention"),
                    formatText(
                        translate("\u201c%s\u201d needs attention: %s."),
                        event.row.label,
                        translate(event.row.state.label)
                    )
                );
                return;
            }

            Main.notify(
                translate("Service recovered"),
                formatText(
                    translate("\u201c%s\u201d is running again."),
                    event.row.label
                )
            );
        }

        _openJournal(entry) {
            let terminalArgv = [];
            let terminalExecArgv = [];

            try {
                terminalArgv = parseCommandField(
                    this._terminalSettings.get_string("exec")
                );
                terminalExecArgv = parseCommandField(
                    this._terminalSettings.get_string("exec-arg")
                );
            } catch (error) {
                terminalArgv = [];
                terminalExecArgv = [];
            }

            launchJournal(entry, terminalArgv, terminalExecArgv, {
                spawn: argv => {
                    const launcher = Gio.SubprocessLauncher.new(
                        Gio.SubprocessFlags.NONE
                    );
                    launcher.spawnv(argv);
                },
                copy: command => {
                    St.Clipboard.get_default().set_text(
                        St.ClipboardType.CLIPBOARD,
                        command
                    );
                },
                notifyFallback: failedEntry => {
                    Main.notify(
                        translate("Journal command copied"),
                        formatText(
                            translate(
                                "Could not open a terminal for \u201c%s\u201d. The journal command was copied to the clipboard."
                            ),
                            failedEntry.label
                        )
                    );
                }
            });
        }

        _applyAppearance() {
            const background = colorWithTransparency(
                this.backgroundColor,
                this.backgroundTransparency
            );
            const textSize = Math.min(
                24,
                Math.max(10, Number(this.textSize) || 14)
            );
            this._card.set_style(
                `background-color: ${background}; font-size: ${textSize}px;`
            );
        }
    };
}

function main(metadata, deskletId) {
    return new ServiceMonitorDesklet(metadata, deskletId);
}

module.exports = {
    ServiceMonitorCore,
    launchJournal,
    main
};
