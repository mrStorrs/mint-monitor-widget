"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const UUID = "service-monitor@mrStorrs";
const SPICE_ROOT = path.join(ROOT, UUID);
const PAYLOAD = path.join(SPICE_ROOT, "files", UUID);
const DESKLET_PATH = path.join(PAYLOAD, "desklet.js");
const desklet = require(DESKLET_PATH);

const tests = [];

function test(name, callback) {
    tests.push({name, callback});
}

function systemdTuple(unit, activeState, loadState = "loaded", subState = "running") {
    return [
        unit,
        unit,
        loadState,
        activeState,
        subState,
        "",
        `/org/freedesktop/systemd1/unit/${unit.replaceAll(".", "_2e")}`,
        0,
        "",
        "/"
    ];
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

function pngDimensions(filename) {
    const data = fs.readFileSync(filename);
    const expectedSignature = "89504e470d0a1a0a";
    assert.equal(data.subarray(0, 8).toString("hex"), expectedSignature);
    return {
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20)
    };
}

test("AC1 empty configuration renders an actionable state without side effects", async () => {
    const queries = [];
    const renders = [];
    const notifications = [];
    const core = new desklet.ServiceMonitorCore({
        query: (scope, units) => {
            queries.push({scope, units});
            return Promise.resolve([]);
        },
        render: view => renders.push(view),
        notify: event => notifications.push(event)
    });

    core.setWatchlist([]);
    await core.refresh();

    assert.equal(queries.length, 0);
    assert.equal(notifications.length, 0);
    assert.equal(renders.at(-1).kind, "empty");
    assert.equal(renders.at(-1).summary.text, "No services configured");
    assert.equal(renders.at(-1).canOpenSettings, true);
});

test("AC2 refreshes each bus once and restores configured row order", async () => {
    const queries = [];
    const renders = [];
    const core = new desklet.ServiceMonitorCore({
        query: async (scope, units) => {
            queries.push({scope, units});
            if (scope === "system")
                return [systemdTuple("model-worker.service", "active")];
            return [systemdTuple("sync-worker.service", "inactive", "loaded", "dead")];
        },
        render: view => renders.push(view),
        notify: () => {}
    });

    core.setWatchlist([
        {label: "Sync worker", unit: "sync-worker.service", scope: "user"},
        {label: "Model worker", unit: "model-worker.service", scope: "system"},
        {label: "Duplicate", unit: "sync-worker.service", scope: "user"}
    ]);
    await core.refresh();

    assert.deepEqual(queries, [
        {scope: "system", units: ["model-worker.service"]},
        {scope: "user", units: ["sync-worker.service"]}
    ]);
    assert.deepEqual(
        renders.at(-1).rows.map(row => [row.label, row.scope, row.state.kind]),
        [
            ["Sync worker", "user", "stopped"],
            ["Model worker", "system", "healthy"]
        ]
    );
    assert.equal(renders.at(-1).ignoredCount, 1);
});

test("status stylesheet reserves red for failed and errored services", () => {
    const stylesheet = fs.readFileSync(
        path.join(PAYLOAD, "stylesheet.css"),
        "utf8"
    );

    assert.match(
        stylesheet,
        /\.service-monitor-transitional,\s*\.service-monitor-stopped\s*\{\s*color:\s*#facc15;/
    );
    assert.match(
        stylesheet,
        /\.service-monitor-unhealthy,\s*\.service-monitor-errored\s*\{\s*color:\s*#fb7185;/
    );
    assert.match(
        stylesheet,
        /\.service-monitor-missing,\s*\.service-monitor-unknown\s*\{\s*color:\s*#a3a3a3;/
    );
    assert.doesNotMatch(stylesheet, /\.service-monitor-unhealthy,\s*\.service-monitor-missing/);
});

test("status changes preserve summary attention across mixed states", async () => {
    const renders = [];
    const core = new desklet.ServiceMonitorCore({
        query: async scope => {
            if (scope === "user")
                throw new Error("user bus unavailable");

            return [
                systemdTuple("stopped.service", "inactive", "loaded", "dead"),
                systemdTuple("failed.service", "failed", "loaded", "failed"),
                systemdTuple("errored.service", "active", "error", "failed"),
                systemdTuple("missing.service", "inactive", "not-found", "dead")
            ];
        },
        render: view => renders.push(view),
        notify: () => {}
    });

    core.setWatchlist([
        {label: "Stopped", unit: "stopped.service", scope: "system"},
        {label: "Failed", unit: "failed.service", scope: "system"},
        {label: "Errored", unit: "errored.service", scope: "system"},
        {label: "Missing", unit: "missing.service", scope: "system"},
        {label: "Unavailable", unit: "unavailable.service", scope: "user"}
    ]);
    await core.refresh();

    const view = renders.at(-1);
    assert.deepEqual(
        view.rows.map(row => row.state.kind),
        ["stopped", "unhealthy", "errored", "missing", "unknown"]
    );
    assert.equal(view.summary.attention, 5);
});

test("AC7 prevents overlapping refreshes and ignores completion after removal", async () => {
    const pending = deferred();
    const renders = [];
    const notifications = [];
    let queryCount = 0;
    const core = new desklet.ServiceMonitorCore({
        query: () => {
            queryCount += 1;
            return pending.promise;
        },
        render: view => renders.push(view),
        notify: event => notifications.push(event)
    });

    core.setWatchlist([
        {label: "Demo", unit: "demo.service", scope: "system"}
    ]);
    const first = core.refresh();
    const second = core.refresh();
    assert.equal(queryCount, 1);

    core.remove();
    const rendersBeforeCompletion = renders.length;
    pending.resolve([systemdTuple("demo.service", "failed", "loaded", "failed")]);
    await Promise.all([first, second]);

    assert.equal(renders.length, rendersBeforeCompletion);
    assert.equal(notifications.length, 0);
});

test("AC7 reports query failures as unavailable without false transitions", async () => {
    const renders = [];
    const notifications = [];
    let fail = false;
    const core = new desklet.ServiceMonitorCore({
        query: async () => {
            if (fail)
                throw new Error("bus unavailable");
            return [systemdTuple("demo.service", "active")];
        },
        render: view => renders.push(view),
        notify: event => notifications.push(event)
    });

    core.setWatchlist([
        {label: "Demo", unit: "demo.service", scope: "system"}
    ]);
    await core.refresh();
    fail = true;
    await core.refresh();

    assert.equal(renders.at(-1).rows[0].state.kind, "unknown");
    assert.equal(renders.at(-1).rows[0].state.label, "Unavailable");
    assert.equal(notifications.length, 0);
});

test("AC5 and AC7 queue a replacement watchlist without overlapping polls", async () => {
    const firstPoll = deferred();
    const replacementPoll = deferred();
    const replacementStarted = deferred();
    const queries = [];
    const renders = [];
    const notifications = [];
    const core = new desklet.ServiceMonitorCore({
        query: (scope, units) => {
            queries.push({scope, units});
            if (units[0] === "old-worker.service")
                return firstPoll.promise;
            replacementStarted.resolve();
            return replacementPoll.promise;
        },
        render: view => renders.push(view),
        notify: event => notifications.push(event)
    });

    core.setWatchlist([
        {label: "Old worker", unit: "old-worker.service", scope: "system"}
    ]);
    const firstRefresh = core.refresh();
    core.setWatchlist([
        {label: "New worker", unit: "new-worker.service", scope: "system"}
    ]);
    assert.equal(await core.refresh(), false);
    assert.deepEqual(queries, [
        {scope: "system", units: ["old-worker.service"]}
    ]);

    firstPoll.resolve([systemdTuple("old-worker.service", "active")]);
    await replacementStarted.promise;
    assert.equal(queries.length, 2);
    assert.equal(
        renders.filter(view => (
            view.kind === "services"
            && view.rows.some(row => row.unit === "old-worker.service")
        )).length,
        0
    );

    replacementPoll.resolve([
        systemdTuple("new-worker.service", "failed", "loaded", "failed")
    ]);
    await firstRefresh;

    assert.equal(renders.at(-1).rows[0].unit, "new-worker.service");
    assert.equal(renders.at(-1).rows[0].state.kind, "unhealthy");
    assert.equal(notifications.length, 0);
});

test("action-triggered refreshes queue behind an in-flight poll", async () => {
    const firstPoll = deferred();
    const secondPoll = deferred();
    const queries = [];
    const renders = [];
    const core = new desklet.ServiceMonitorCore({
        query: () => {
            queries.push(queries.length + 1);
            return queries.length === 1 ? firstPoll.promise : secondPoll.promise;
        },
        render: view => renders.push(view),
        notify: () => {}
    });

    core.setWatchlist([
        {label: "Worker", unit: "worker.service", scope: "system"}
    ]);
    const firstRefresh = core.refresh();
    assert.equal(await core.refresh(), false);
    assert.deepEqual(queries, [1]);

    firstPoll.resolve([systemdTuple("worker.service", "active")]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(queries, [1, 2]);
    secondPoll.resolve([systemdTuple("worker.service", "inactive", "loaded", "dead")]);
    await firstRefresh;
    assert.deepEqual(queries, [1, 2]);
    assert.equal(renders.at(-1).rows[0].unit, "worker.service");
    assert.equal(renders.at(-1).rows[0].state.kind, "stopped");
    assert.equal(renders.at(-1).summary.kind, "attention");
});

test("AC6 forwards exactly-once core events and honors the notification toggle", async () => {
    const notifications = [];
    let enabled = true;
    let activeState = "active";
    const core = new desklet.ServiceMonitorCore({
        query: async () => [
            systemdTuple(
                "queue-worker.service",
                activeState,
                "loaded",
                activeState === "active" ? "running" : "failed"
            )
        ],
        render: () => {},
        notify: event => notifications.push(event),
        notificationsEnabled: () => enabled
    });

    core.setWatchlist([
        {label: "Queue worker", unit: "queue-worker.service", scope: "user"}
    ]);
    await core.refresh();
    activeState = "failed";
    await core.refresh();
    await core.refresh();
    activeState = "active";
    await core.refresh();
    await core.refresh();

    assert.deepEqual(
        notifications.map(event => [
            event.type,
            event.row.label,
            event.row.unit,
            event.row.scope
        ]),
        [
            ["failure", "Queue worker", "queue-worker.service", "user"],
            ["recovery", "Queue worker", "queue-worker.service", "user"]
        ]
    );

    enabled = false;
    activeState = "failed";
    await core.refresh();
    activeState = "active";
    await core.refresh();
    assert.equal(notifications.length, 2);
});

test("journal AC1 and AC2 launch with default and exact custom line counts", () => {
    const spawned = [];
    const adapters = {
        spawn: argv => spawned.push(argv),
        copy: () => assert.fail("clipboard fallback was not expected"),
        notifyFallback: () => assert.fail("fallback notification was not expected")
    };

    assert.equal(
        desklet.launchJournal(
            {label: "Sync worker", unit: "sync-worker.service", scope: "user"},
            ["kitty"],
            ["--"],
            adapters
        ),
        true
    );
    assert.equal(
        desklet.launchJournal(
            {label: "Model worker", unit: "model-worker.service", scope: "system"},
            ["kitty"],
            ["--"],
            adapters,
            100000
        ),
        true
    );
    assert.deepEqual(spawned, [
        [
            "kitty",
            "--",
            "journalctl",
            "--user",
            "--unit",
            "sync-worker.service",
            "--lines",
            "1000",
            "--follow"
        ],
        [
            "kitty",
            "--",
            "journalctl",
            "--unit",
            "model-worker.service",
            "--lines",
            "100000",
            "--follow"
        ]
    ]);
});

test("journal AC3 normalizes malformed and out-of-range line counts", () => {
    const cases = [
        [-10, "1"],
        [0, "1"],
        [1, "1"],
        [42.4, "42"],
        [42.5, "43"],
        [100000, "100000"],
        [100001, "100000"],
        ["2501", "2501"],
        [false, "1000"],
        [true, "1000"],
        [[], "1000"],
        [[2501], "1000"],
        [{value: 2501}, "1000"],
        ["", "1000"],
        [null, "1000"],
        [Number.NaN, "1000"],
        [Number.POSITIVE_INFINITY, "1000"],
        ["not-a-number", "1000"]
    ];

    for (const [configured, expected] of cases) {
        const spawned = [];
        assert.equal(
            desklet.launchJournal(
                {label: "Worker", unit: "worker.service", scope: "system"},
                ["kitty"],
                ["--"],
                {
                    spawn: argv => spawned.push(argv),
                    copy: () => assert.fail("clipboard fallback was not expected"),
                    notifyFallback: () => assert.fail("fallback notification was not expected")
                },
                configured
            ),
            true
        );
        const lineIndex = spawned[0].indexOf("--lines");
        assert.equal(spawned[0][lineIndex + 1], expected, String(configured));
    }
});

test("journal AC4 copies the exact custom command and notifies on launch failure", () => {
    const copied = [];
    const notifications = [];
    const result = desklet.launchJournal(
        {label: "Sync worker", unit: "sync-worker.service", scope: "user"},
        ["missing-terminal"],
        ["--"],
        {
            spawn: () => {
                throw new Error("not found");
            },
            copy: text => copied.push(text),
            notifyFallback: entry => notifications.push(entry)
        },
        100001
    );

    assert.equal(result, false);
    assert.deepEqual(copied, [
        "journalctl --user --unit sync-worker.service --lines 100000 --follow"
    ]);
    assert.deepEqual(notifications, [
        {label: "Sync worker", unit: "sync-worker.service", scope: "user"}
    ]);
});

test("service actions use validated D-Bus method names and replace mode", () => {
    assert.deepEqual(
        desklet.serviceActionRequest("start", "worker.service"),
        {method: "StartUnit", args: ["worker.service", "replace"]}
    );
    assert.deepEqual(
        desklet.serviceActionRequest("stop", "worker.service"),
        {method: "StopUnit", args: ["worker.service", "replace"]}
    );
    assert.throws(
        () => desklet.serviceActionRequest("restart", "worker.service"),
        /Invalid service action/
    );
    assert.throws(
        () => desklet.serviceActionRequest("start", "bad;touch.service"),
        /Invalid service unit/
    );
});

test("service action orchestration covers scope, duplicates, errors, retry, and removal", async () => {
    const row = {
        key: "user:worker.service",
        unit: "worker.service",
        scope: "user",
        state: {loadState: "loaded", activeState: "inactive"}
    };
    const secondRow = {
        ...row,
        key: "system:other.service",
        unit: "other.service",
        scope: "system"
    };
    const inFlight = new Set();
    const calls = [];
    const refreshes = [];
    const failures = [];
    let removed = false;
    const pending = deferred();
    const adapters = {
        removed: () => removed,
        inFlight,
        call: (scope, action, unit) => {
            calls.push({scope, action, unit});
            return pending.promise;
        },
        refresh: () => {
            refreshes.push(true);
            return Promise.resolve(true);
        },
        notifyFailure: (failedRow, action) => failures.push([failedRow.key, action])
    };

    const first = desklet.runServiceAction(row, "start", adapters);
    assert.equal(inFlight.has(row.key), true);
    assert.equal(
        await desklet.runServiceAction(row, "start", adapters),
        false
    );
    const second = desklet.runServiceAction(secondRow, "start", adapters);
    pending.resolve("job");
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(calls[0], {scope: "user", action: "start", unit: "worker.service"});
    assert.deepEqual(calls[1], {scope: "system", action: "start", unit: "other.service"});
    assert.equal(refreshes.length, 2);
    assert.equal(inFlight.size, 0);

    const callCountBeforeUnavailable = calls.length;
    assert.equal(
        await desklet.runServiceAction({
            ...row,
            key: "user:missing.service",
            unit: "missing.service",
            state: {loadState: "not-found", activeState: "inactive"}
        }, "start", adapters),
        false
    );
    assert.equal(calls.length, callCountBeforeUnavailable);

    adapters.call = () => Promise.reject(new Error("denied"));
    assert.equal(await desklet.runServiceAction(row, "start", adapters), false);
    assert.deepEqual(failures, [[row.key, "start"]]);

    const late = deferred();
    adapters.call = () => late.promise;
    const removedAction = desklet.runServiceAction(row, "start", adapters);
    removed = true;
    late.reject(new Error("removed"));
    assert.equal(await removedAction, false);
    assert.deepEqual(failures, [[row.key, "start"]]);
});

test("AC8 rejects an unsafe unit before attempting a launch", () => {
    let spawnCalled = false;
    assert.throws(
        () => desklet.launchJournal(
            {label: "Unsafe", unit: "bad;touch.service", scope: "system"},
            ["kitty"],
            ["--"],
            {
                spawn: () => {
                    spawnCalled = true;
                },
                copy: () => {},
                notifyFallback: () => {}
            }
        ),
        /Invalid service unit/
    );
    assert.equal(spawnCalled, false);
});

test("AC10 includes an upstream-shaped, internally consistent Spice payload", () => {
    const requiredPaths = [
        "info.json",
        "README.md",
        "screenshot.png",
        `files/${UUID}/metadata.json`,
        `files/${UUID}/desklet.js`,
        `files/${UUID}/serviceState.js`,
        `files/${UUID}/settings-schema.json`,
        `files/${UUID}/stylesheet.css`,
        `files/${UUID}/icon.svg`,
        `files/${UUID}/icon.png`,
        `files/${UUID}/po/${UUID}.pot`
    ];

    for (const relativePath of requiredPaths)
        assert.equal(fs.existsSync(path.join(SPICE_ROOT, relativePath)), true, relativePath);

    const info = JSON.parse(fs.readFileSync(path.join(SPICE_ROOT, "info.json"), "utf8"));
    const metadata = JSON.parse(
        fs.readFileSync(path.join(PAYLOAD, "metadata.json"), "utf8")
    );
    const settings = JSON.parse(
        fs.readFileSync(path.join(PAYLOAD, "settings-schema.json"), "utf8")
    );

    assert.equal(info.author, "mrStorrs");
    assert.equal(metadata.uuid, UUID);
    assert.equal(metadata.name, "Service Monitor");
    assert.equal(metadata.version, 3);
    assert.equal(metadata["max-instances"], 10);
    assert.deepEqual(settings.services.default, [
        {
            label: "Minecraft Server",
            unit: "minecraft-server.service",
            user: true
        }
    ]);
    assert.equal(settings["refresh-interval"].default, 5);
    assert.equal(settings["show-notifications"].default, true);
    assert.deepEqual(
        settings["journal-lines"],
        {
            type: "spinbutton",
            default: 1000,
            min: 1,
            max: 100000,
            step: 100,
            units: "lines",
            description: "Journal history lines"
        }
    );
    assert.equal(settings.services.type, "list");
    assert.deepEqual(
        settings.services.columns.map(column => column.id),
        ["label", "unit", "user"]
    );
    assert.equal(settings.services.columns[2].type, "boolean");

    const pot = fs.readFileSync(
        path.join(PAYLOAD, "po", `${UUID}.pot`),
        "utf8"
    );
    assert.match(pot, /Project-Id-Version: service-monitor@mrStorrs 3/);
    assert.match(pot, /msgid "Journal history lines"/);
    assert.match(pot, /msgid "lines"/);
    assert.match(pot, /msgid "Start"/);
    assert.match(pot, /msgid "Stop"/);

    const projectReadme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const catalogReadme = fs.readFileSync(path.join(SPICE_ROOT, "README.md"), "utf8");
    assert.match(projectReadme, /1,000/);
    assert.match(projectReadme, /100,000/);
    assert.match(catalogReadme, /1,000/);
    assert.match(catalogReadme, /100,000/);
});

test("AC10 keeps runtime code asynchronous and free of shell/systemctl calls", () => {
    const source = fs.readFileSync(DESKLET_PATH, "utf8");
    const forbidden = [
        "spawnCommandLine",
        "spawn_command_line",
        "systemctl",
        "call_sync",
        "new_for_bus_sync"
    ];

    for (const token of forbidden)
        assert.equal(source.includes(token), false, token);

    assert.match(source, /ListUnitsByNames/);
    assert.match(source, /StartUnit/);
    assert.match(source, /StopUnit/);
    assert.match(source, /new GLib\.Variant\("\(ss\)"/);
    assert.match(source, /ALLOW_INTERACTIVE_AUTHORIZATION/);
    assert.match(source, /BUTTON_SECONDARY/);
    assert.match(source, /new_for_bus/);
    assert.match(source, /Gio\.SubprocessLauncher/);
});

test("Minecraft companion files stay outside the Spice payload", () => {
    const serviceRoot = process.env.MINT_MONITOR_MINECRAFT_SERVICE_ROOT;
    if (!serviceRoot) {
        console.log("ok - Minecraft companion files stay outside the Spice payload (local companion not configured)");
        return;
    }
    if (!fs.existsSync(serviceRoot)) {
        console.log("ok - Minecraft companion files stay outside the Spice payload (configured path not present)");
        return;
    }

    for (const filename of [
        "README.md",
        "install.sh",
        "test-install.sh",
        "test-wrapper.sh",
        "minecraft-server.service",
        "minecraft-server-wrapper.sh"
    ])
        assert.equal(fs.existsSync(path.join(serviceRoot, filename)), true, filename);

    const unitSource = fs.readFileSync(
        path.join(serviceRoot, "minecraft-server.service"),
        "utf8"
    );
    assert.match(unitSource, /KillMode=mixed/);
    assert.match(unitSource, /TimeoutStopSec=120/);
    assert.match(unitSource, /SendSIGKILL=yes/);
    assert.match(unitSource, /FinalKillSignal=SIGKILL/);

    assert.ok(!fs.existsSync(path.join(PAYLOAD, "minecraft-server.service")));
    assert.ok(!fs.existsSync(path.join(PAYLOAD, "minecraft-server-wrapper.sh")));
});

test("AC10 packages only the UUID directory at the archive root", () => {
    childProcess.execFileSync("make", ["package"], {
        cwd: ROOT,
        stdio: "pipe"
    });

    const archive = path.join(ROOT, "dist", `${UUID}.zip`);
    assert.equal(fs.existsSync(archive), true);
    const entries = childProcess.execFileSync(
        "unzip",
        ["-Z1", archive],
        {encoding: "utf8"}
    ).trim().split("\n");

    assert.ok(entries.length > 5);
    assert.ok(entries.every(entry => entry.startsWith(`${UUID}/`)));
    assert.ok(entries.every(entry => !entry.includes(".dreamers")));
    assert.ok(entries.every(entry => !entry.startsWith("tests/")));
    for (const companionName of [
        "minecraft-server.service",
        "minecraft-server-wrapper.sh",
        "install.sh",
        "test-install.sh",
        "test-wrapper.sh"
    ])
        assert.ok(entries.every(entry => !entry.endsWith(`/${companionName}`)), companionName);
});

test("AC11 provides a catalog screenshot captured at desktop scale", () => {
    const dimensions = pngDimensions(path.join(SPICE_ROOT, "screenshot.png"));
    assert.ok(dimensions.width >= 400, dimensions.width);
    assert.ok(dimensions.height >= 200, dimensions.height);
});

test("local install script targets only the per-user Cinnamon desklet directory", () => {
    const source = fs.readFileSync(
        path.join(ROOT, "scripts", "install-local.sh"),
        "utf8"
    );
    assert.match(source, /uuid="service-monitor@mrStorrs"/);
    assert.match(
        source,
        /destination="\$\{HOME\}\/\.local\/share\/cinnamon\/desklets\/\$\{uuid\}"/
    );
    assert.equal(source.includes("sudo"), false);
    assert.equal(source.includes("pkexec"), false);
});

(async () => {
    let failures = 0;

    for (const {name, callback} of tests) {
        try {
            await callback();
            console.log(`ok - ${name}`);
        } catch (error) {
            failures += 1;
            console.error(`not ok - ${name}`);
            console.error(error.stack);
        }
    }

    if (failures > 0)
        process.exitCode = 1;
})();
