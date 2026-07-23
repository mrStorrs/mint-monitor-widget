"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const state = require(path.join(
    __dirname,
    "..",
    "service-monitor@mrStorrs",
    "files",
    "service-monitor@mrStorrs",
    "serviceState.js"
));

let failures = 0;

function test(name, callback) {
    try {
        callback();
        console.log(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`not ok - ${name}`);
        console.error(error.stack);
    }
}

function tuple(unit, loadState, activeState, subState) {
    return [
        unit,
        unit,
        loadState,
        activeState,
        subState,
        "",
        "/org/freedesktop/systemd1/unit/example",
        0,
        "",
        "/"
    ];
}

test("AC3 classifies every supported systemd state", () => {
    const cases = [
        [tuple("active.service", "loaded", "active", "running"), "healthy", "Running"],
        [tuple("starting.service", "loaded", "activating", "start"), "transitional", "Starting"],
        [tuple("reload.service", "loaded", "reloading", "reload"), "transitional", "Reloading"],
        [tuple("stopping.service", "loaded", "deactivating", "stop"), "transitional", "Stopping"],
        [tuple("failed.service", "loaded", "failed", "failed"), "unhealthy", "Failed"],
        [tuple("stopped.service", "loaded", "inactive", "dead"), "unhealthy", "Stopped"],
        [tuple("missing.service", "not-found", "inactive", "dead"), "missing", "Not found"],
        [tuple("error.service", "error", "active", "running"), "unknown", "Unavailable"],
        [tuple("masked.service", "masked", "inactive", "dead"), "unknown", "Unavailable"],
        [null, "unknown", "Unavailable"],
        [["malformed"], "unknown", "Unavailable"]
    ];

    for (const [input, expectedKind, expectedLabel] of cases) {
        const actual = state.classifyUnit(input);
        assert.equal(actual.kind, expectedKind);
        assert.equal(actual.label, expectedLabel);
    }
});

test("AC4 normalizes, validates, deduplicates, and preserves watchlist order", () => {
    const actual = state.normalizeWatchlist([
        {label: "  API worker  ", unit: "api-worker.service", scope: "system"},
        {label: "Duplicate", unit: "api-worker.service", scope: "system"},
        {label: "", unit: "api-worker.service", scope: "user"},
        {label: "No suffix", unit: "api-worker", scope: "system"},
        {label: "Unsafe", unit: "../api-worker.service", scope: "system"},
        {label: "Wrong scope", unit: "other.service", scope: "remote"},
        null
    ]);

    assert.deepEqual(actual.entries, [
        {
            key: "system:api-worker.service",
            label: "API worker",
            unit: "api-worker.service",
            scope: "system"
        },
        {
            key: "user:api-worker.service",
            label: "api-worker.service",
            unit: "api-worker.service",
            scope: "user"
        }
    ]);
    assert.equal(actual.ignoredCount, 5);
    assert.deepEqual(state.groupEntriesByScope(actual.entries), {
        system: ["api-worker.service"],
        user: ["api-worker.service"]
    });
});

test("AC4 maps the localized settings checkbox to user and system scopes", () => {
    const actual = state.normalizeWatchlist([
        {label: "User worker", unit: "worker.service", user: true},
        {label: "System worker", unit: "worker.service", user: false}
    ]);

    assert.deepEqual(
        actual.entries.map(entry => [entry.label, entry.scope]),
        [
            ["User worker", "user"],
            ["System worker", "system"]
        ]
    );
    assert.equal(actual.ignoredCount, 0);
});

test("AC4 rejects non-ASCII, whitespace, slash, and non-service unit names", () => {
    const invalidNames = [
        "",
        "ssh",
        "two words.service",
        "path/unit.service",
        "snowman-\u2603.service"
    ];

    for (const unit of invalidNames)
        assert.equal(state.isValidServiceUnit(unit), false, unit);

    const validNames = [
        "ssh.service",
        "dbus-org.bluez.service",
        "worker@.service",
        "worker@alpha:1.service"
    ];

    for (const unit of validNames)
        assert.equal(state.isValidServiceUnit(unit), true, unit);
});

test("AC5 establishes an unhealthy first snapshot without events", () => {
    const tracker = new state.TransitionTracker();
    const events = tracker.update([
        {key: "system:failed.service", state: {kind: "unhealthy"}},
        {key: "user:missing.service", state: {kind: "missing"}}
    ]);

    assert.deepEqual(events, []);
});

test("AC5 resets to a silent baseline when the watchlist changes", () => {
    const tracker = new state.TransitionTracker();
    tracker.update([{key: "system:a.service", state: {kind: "healthy"}}]);
    assert.equal(
        tracker.update([{key: "system:a.service", state: {kind: "unhealthy"}}]).length,
        1
    );

    tracker.reset();
    assert.deepEqual(
        tracker.update([{key: "system:a.service", state: {kind: "unhealthy"}}]),
        []
    );
});

test("AC6 emits exactly one failure and one recovery across stable transitions", () => {
    const tracker = new state.TransitionTracker();
    const key = "system:demo.service";

    assert.deepEqual(tracker.update([{key, state: {kind: "healthy"}}]), []);
    assert.deepEqual(tracker.update([{key, state: {kind: "healthy"}}]), []);
    assert.deepEqual(
        tracker.update([{key, state: {kind: "unhealthy"}}]),
        [{key, type: "failure", from: "healthy", to: "unhealthy"}]
    );
    assert.deepEqual(tracker.update([{key, state: {kind: "unhealthy"}}]), []);
    assert.deepEqual(
        tracker.update([{key, state: {kind: "healthy"}}]),
        [{key, type: "recovery", from: "unhealthy", to: "healthy"}]
    );
    assert.deepEqual(tracker.update([{key, state: {kind: "healthy"}}]), []);
});

test("AC6 ignores transitional and unknown states without losing stable history", () => {
    const tracker = new state.TransitionTracker();
    const key = "user:demo.service";

    tracker.update([{key, state: {kind: "healthy"}}]);
    assert.deepEqual(tracker.update([{key, state: {kind: "transitional"}}]), []);
    assert.deepEqual(tracker.update([{key, state: {kind: "unknown"}}]), []);
    assert.deepEqual(
        tracker.update([{key, state: {kind: "missing"}}]),
        [{key, type: "failure", from: "healthy", to: "missing"}]
    );
    assert.deepEqual(tracker.update([{key, state: {kind: "unhealthy"}}]), []);
    assert.deepEqual(
        tracker.update([{key, state: {kind: "healthy"}}]),
        [{key, type: "recovery", from: "unhealthy", to: "healthy"}]
    );
});

test("AC9 summarizes empty, checking, healthy, and attention states", () => {
    assert.deepEqual(state.summarizeStates([], {checking: false}), {
        kind: "empty",
        text: "No services configured",
        total: 0,
        attention: 0
    });
    assert.deepEqual(
        state.summarizeStates(
            [{kind: "unknown"}, {kind: "unknown"}],
            {checking: true}
        ),
        {
            kind: "checking",
            text: "Checking 2 services\u2026",
            total: 2,
            attention: 0
        }
    );
    assert.deepEqual(
        state.summarizeStates(
            [{kind: "healthy"}, {kind: "healthy"}],
            {checking: false}
        ),
        {
            kind: "healthy",
            text: "All 2 services healthy",
            total: 2,
            attention: 0
        }
    );
    assert.deepEqual(
        state.summarizeStates(
            [{kind: "healthy"}, {kind: "unhealthy"}, {kind: "unknown"}],
            {checking: false}
        ),
        {
            kind: "attention",
            text: "2 of 3 services need attention",
            total: 3,
            attention: 2
        }
    );
});

test("AC9 uses singular grammar and counts transitional rows as attention", () => {
    assert.equal(
        state.summarizeStates([{kind: "healthy"}], {checking: false}).text,
        "All 1 service healthy"
    );
    assert.equal(
        state.summarizeStates([{kind: "transitional"}], {checking: false}).text,
        "1 of 1 service needs attention"
    );
});

test("poll interval clamps to the supported 2 to 300 second range", () => {
    assert.equal(state.clampPollInterval(0), 2);
    assert.equal(state.clampPollInterval("5"), 5);
    assert.equal(state.clampPollInterval(999), 300);
    assert.equal(state.clampPollInterval("bad"), 5);
});

if (failures > 0)
    process.exitCode = 1;
