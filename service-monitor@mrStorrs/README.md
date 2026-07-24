# Service Monitor

Service Monitor is a compact Cinnamon desklet for selected systemd services.

## Configure it

1. Add the desklet to the desktop.
2. Open its settings.
3. Keep or edit the default **Minecraft Server** row, or add a display name and a unit ending in `.service`.
4. Check **User service** for units shown by `systemctl --user`; leave it unchecked for machine-wide units.

The first completed check, including the first check after changing the watchlist, is silent. If a running service later becomes failed, stopped, or not found, Cinnamon sends one notification and sends one more when that service recovers. A D-Bus query error appears as **Unavailable** without creating an alert.

Select a service row to open its journal and follow new entries in the configured terminal. **Journal history lines** defaults to 1,000 and accepts values from 1 through 100,000. Changes apply to subsequently opened terminals; already-open journals are unchanged. Large histories can make noisy journals slower to open and use more terminal memory. If the terminal cannot be opened, the desklet copies the scoped `journalctl` command to the clipboard and tells you.

Right-click a row for **Start** or **Stop**. The action is sent through the matching systemd D-Bus manager; system-scoped actions may require normal authorization. Invalid, duplicate, unknown, and missing entries cannot be changed and are reported on the card.

The Minecraft companion user service is kept outside this Spice under `~/projects/games/minecraft/service`. Its installer does not enable or start the unit at login; start it manually from the desklet or with `systemctl --user start` when wanted. Its stop handler sends the server's `stop` console command and waits for graceful exit so the world can save. Run that directory's installer using the directory targeted by your `minecraft-server` alias.

The refresh interval, journal history, notifications, background, transparency, and text size are configurable. This desklet monitors only local, continuous systemd services. It does not monitor remote hosts, timers, containers, or whole-machine outages.
