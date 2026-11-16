# Third-party notices

Kram's source is MIT licensed. Its dependencies and bundled fonts retain their own copyrights and licenses.

The production web build writes `dist/web/third-party-licenses.txt` with the license texts for bundled JavaScript dependencies and fonts. Keep this file with any distributed web build; the application serves it at `/third-party-licenses.txt`. Font license originals are also retained in [licenses/fonts](licenses/fonts).

The Docker image retains dependency license files in `node_modules` and operating-system package notices in their installed locations. ntfy, Caddy, PostgreSQL, age, and rclone are separate projects with their own license terms. Preserve their notices when redistributing images or modified components.

The npm lockfile records dependency versions and license identifiers. [Acknowledgements](ACKNOWLEDGEMENTS.md) credits the main projects and design references.
