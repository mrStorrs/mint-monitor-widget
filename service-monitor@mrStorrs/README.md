# Service Monitor

Service Monitor is a compact, read-only Cinnamon desklet for selected systemd services.

## Configure it

1. Add the desklet to the desktop.
2. Open its settings.
3. Add a display name and a unit ending in `.service`.
4. Check **User service** for units shown by `systemctl --user`; leave it unchecked for machine-wide units.

The first completed check, including the first check after changing the watchlist, is silent. If a running service later becomes failed, stopped, or not found, Cinnamon sends one notification and sends one more when that service recovers. A D-Bus query error appears as **Unavailable** without creating an alert.

Select a service row to open its journal and follow new entries in the configured terminal. **Journal history lines** defaults to 1,000 and accepts values from 1 through 100,000. Changes apply to subsequently opened terminals; already-open journals are unchanged. Large histories can make noisy journals slower to open and use more terminal memory. If the terminal cannot be opened, the desklet copies the scoped `journalctl` command to the clipboard and tells you.

Invalid and duplicate entries are ignored and reported on the card. Service Monitor never changes service state and never requests elevated privileges.

The refresh interval, journal history, notifications, background, transparency, and text size are configurable. This desklet monitors only local, continuous systemd services. It does not monitor remote hosts, timers, containers, or whole-machine outages.
