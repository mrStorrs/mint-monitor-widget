"use strict";

const DEFAULT_POLL_INTERVAL = 5;
const MIN_POLL_INTERVAL = 2;
const MAX_POLL_INTERVAL = 300;
const SERVICE_UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;
const STABLE_KINDS = new Set([
    "healthy",
    "stopped",
    "unhealthy",
    "errored",
    "missing"
]);
const FAILURE_KINDS = new Set(["stopped", "unhealthy", "errored", "missing"]);

function isValidServiceUnit(unit) {
    return typeof unit === "string" && SERVICE_UNIT_PATTERN.test(unit);
}

function normalizeWatchlist(rawEntries) {
    if (!Array.isArray(rawEntries))
        return {entries: [], ignoredCount: rawEntries == null ? 0 : 1};

    const entries = [];
    const seen = new Set();
    let ignoredCount = 0;

    for (const rawEntry of rawEntries) {
        if (rawEntry == null || typeof rawEntry !== "object") {
            ignoredCount += 1;
            continue;
        }

        const unit = typeof rawEntry.unit === "string"
            ? rawEntry.unit.trim()
            : "";
        const scope = rawEntry.scope
            || (typeof rawEntry.user === "boolean"
                ? (rawEntry.user ? "user" : "system")
                : "");

        if (!isValidServiceUnit(unit) || (scope !== "system" && scope !== "user")) {
            ignoredCount += 1;
            continue;
        }

        const key = `${scope}:${unit}`;
        if (seen.has(key)) {
            ignoredCount += 1;
            continue;
        }

        seen.add(key);
        const rawLabel = typeof rawEntry.label === "string"
            ? rawEntry.label.trim()
            : "";
        entries.push({
            key,
            label: rawLabel || unit,
            unit,
            scope
        });
    }

    return {entries, ignoredCount};
}

function groupEntriesByScope(entries) {
    const grouped = {system: [], user: []};

    for (const entry of entries)
        grouped[entry.scope].push(entry.unit);

    return grouped;
}

function unavailableState() {
    return {
        kind: "unknown",
        label: "Unavailable",
        loadState: "",
        activeState: "",
        subState: ""
    };
}

function serviceActionAvailability(state) {
    if (!state || state.loadState !== "loaded") {
        return {
            canStart: false,
            canStop: false
        };
    }

    return {
        canStart: state.activeState === "inactive" || state.activeState === "failed",
        canStop: [
            "active",
            "activating",
            "reloading",
            "deactivating"
        ].includes(state.activeState)
    };
}

function classifyUnit(tuple) {
    if (!Array.isArray(tuple) || tuple.length < 5)
        return unavailableState();

    const loadState = tuple[2];
    const activeState = tuple[3];
    const subState = tuple[4];
    let kind = "unknown";
    let label = "Unavailable";

    if (loadState === "not-found") {
        kind = "missing";
        label = "Not found";
    } else if (loadState === "error") {
        kind = "errored";
        label = "Unavailable";
    } else if (loadState !== "loaded") {
        return unavailableState();
    } else if (activeState === "active") {
        kind = "healthy";
        label = "Running";
    } else if (activeState === "activating") {
        kind = "transitional";
        label = "Starting";
    } else if (activeState === "reloading") {
        kind = "transitional";
        label = "Reloading";
    } else if (activeState === "deactivating") {
        kind = "transitional";
        label = "Stopping";
    } else if (activeState === "failed") {
        kind = "unhealthy";
        label = "Failed";
    } else if (activeState === "inactive") {
        kind = "stopped";
        label = "Stopped";
    }

    return {kind, label, loadState, activeState, subState};
}

function summarizeStates(states, options = {}) {
    const total = states.length;
    if (total === 0) {
        return {
            kind: "empty",
            text: "No services configured",
            total: 0,
            attention: 0
        };
    }

    if (options.checking) {
        return {
            kind: "checking",
            text: `Checking ${total} ${total === 1 ? "service" : "services"}\u2026`,
            total,
            attention: 0
        };
    }

    const attention = states.filter(item => item.kind !== "healthy").length;
    if (attention === 0) {
        return {
            kind: "healthy",
            text: `All ${total} ${total === 1 ? "service" : "services"} healthy`,
            total,
            attention: 0
        };
    }

    return {
        kind: "attention",
        text: `${attention} of ${total} ${total === 1 ? "service needs" : "services need"} attention`,
        total,
        attention
    };
}

function clampPollInterval(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return DEFAULT_POLL_INTERVAL;

    return Math.min(MAX_POLL_INTERVAL, Math.max(MIN_POLL_INTERVAL, Math.round(parsed)));
}

class TransitionTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this._hasBaseline = false;
        this._stableStates = new Map();
    }

    update(rows) {
        const events = [];

        if (!this._hasBaseline) {
            for (const row of rows) {
                if (STABLE_KINDS.has(row.state.kind))
                    this._stableStates.set(row.key, row.state.kind);
            }
            this._hasBaseline = true;
            return events;
        }

        for (const row of rows) {
            const current = row.state.kind;
            if (!STABLE_KINDS.has(current))
                continue;

            const previous = this._stableStates.get(row.key);
            const wasFailure = FAILURE_KINDS.has(previous);
            const isFailure = FAILURE_KINDS.has(current);

            if (previous === "healthy" && isFailure) {
                events.push({
                    key: row.key,
                    type: "failure",
                    from: previous,
                    to: current
                });
            } else if (wasFailure && current === "healthy") {
                events.push({
                    key: row.key,
                    type: "recovery",
                    from: previous,
                    to: current
                });
            }

            this._stableStates.set(row.key, current);
        }

        return events;
    }
}

module.exports = {
    TransitionTracker,
    clampPollInterval,
    classifyUnit,
    groupEntriesByScope,
    isValidServiceUnit,
    normalizeWatchlist,
    serviceActionAvailability,
    summarizeStates,
    unavailableState
};
