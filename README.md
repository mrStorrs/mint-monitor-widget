# Mint Monitor Widget

Mint Monitor Widget packages **Service Monitor**, a compact Cinnamon desklet for watching and controlling selected systemd services. It supports both system services and per-user services, reports failures and recoveries through Cinnamon notifications, opens the relevant journal when a row is selected, and offers Start/Stop actions from each row's right-click menu.

## Features

- Explicit watchlist with a display name, unit, and system/user scope.
- Native asynchronous systemd D-Bus queries without parsing shell output.
- Silent startup baseline followed by one notification per failure or recovery.
- Text, shape, and color status cues in a compact desktop card.
- Native Start/Stop controls through asynchronous systemd D-Bus calls.
- Argument-safe journal launching with configurable history in Cinnamon's configured terminal.

## Requirements

- Cinnamon 6.x.
- A systemd-based Linux distribution.
- `journalctl` for the row action.
- Node.js, `make`, `zip`, and `unzip` only for development checks and packaging.

## Install from source

```bash
make check
make install-local
```

The install target copies the runtime payload into the current user's Cinnamon desklet directory and does not require root privileges. Then open **System Settings > Desklets**, add or reload **Service Monitor**, and use its settings to edit the watchlist. New settings instances include a user-scoped `minecraft-server.service` row; remove it if the companion service is not installed. Check **User service** for units managed by `systemctl --user`; leave it unchecked for system services.

Right-click a service row for **Start** and **Stop**. The available action follows the last known state; unknown or missing units cannot be changed. System-scoped actions may require the normal systemd authorization prompt. Action failures are shown as Cinnamon notifications.

The Minecraft companion files live separately in `~/projects/games/minecraft/service` so the public Spice does not contain a machine-specific launcher path. Install that user service with the local installer in that directory, passing the directory that contains the `run.sh` targeted by your `minecraft-server` alias. Installation does not enable or start it at login; start it manually from the desklet or with `systemctl --user start minecraft-server.service` when wanted. Its stop handler sends the Minecraft `stop` console command and waits for the server to exit so the world can save; after 120 seconds, systemd hard-kills any remaining service processes as the final fallback.

The first completed check, including the first check after changing the watchlist, establishes a silent baseline. If a running service later becomes failed, stopped, or missing, the desklet sends one notification; it sends one more when that service recovers. Query errors appear as **Unavailable** without creating a failure or recovery alert.

Selecting a service opens its journal and follows new entries. **Journal history lines** defaults to 1,000 and accepts values from 1 through 100,000. Changes apply the next time a service row is selected; they do not alter an already-open journal terminal.

## Development and packaging

```bash
make check
make package
```

The archive is written to `dist/service-monitor@mrStorrs.zip`. The project keeps the [official Cinnamon desklet structure](https://github.com/linuxmint/cinnamon-spices-desklets#file-structure), so the top-level `service-monitor@mrStorrs/` directory can later be copied into the upstream repository.

## Limits

Service Monitor checks continuous `.service` units on the local machine every 2–300 seconds, with a default interval of 5 seconds. It does not monitor remote hosts, containers, HTTP endpoints, timer schedules, or whether the whole computer is offline. Because notifications are produced by the Cinnamon session, it cannot alert while that session or the whole computer is down. It does not restart, enable, disable, mask, or edit services.

Large journal-history values can make noisy services slower to open and increase terminal memory use. The setting changes only how much retained history `journalctl` initially displays; it does not change journal retention or terminal scrollback limits.

For a general command-output widget, see [Command Result](https://cinnamon-spices.linuxmint.com/desklets/view/50). For network endpoint checks, see [Host Check](https://cinnamon-spices.linuxmint.com/desklets/view/49).

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
