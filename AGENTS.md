# Service Monitor contributor guide

## Stack and layout

- Cinnamon 6.x desklet written in CJS-compatible JavaScript.
- Runtime payload: `service-monitor@mrStorrs/files/service-monitor@mrStorrs/`.
- Catalog metadata and screenshot: `service-monitor@mrStorrs/`.
- Tests use Node's built-in assertion module; no package install is required.

## Commands

- `make check` runs JavaScript syntax, behavior, structure, and archive-layout checks; it creates the package under `dist/`.
- `make package` creates `dist/service-monitor@mrStorrs.zip`.
- `make install-local` copies only the runtime payload to the current user's Cinnamon desklet directory.
- `make clean` removes the generated package.

Desktop behavior involving Cinnamon, systemd D-Bus, notifications, and terminal launching still requires a manual Cinnamon test.

## Hard rules

- Keep the desklet read-only. Never add service start, stop, restart, enable, or disable operations.
- Use the systemd D-Bus API asynchronously; do not parse `systemctl` output.
- Launch external programs with argument arrays, never a shell command.
- Keep user-visible strings translatable and status meaning available through text, not color alone.
- Do not commit personal service names, settings, logs, or machine-specific paths.
- Keep `.dreamers/` and `dist/` out of version control.
- Preserve the upstream Cinnamon Spice directory shape under `service-monitor@mrStorrs/`.
