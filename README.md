
# Auto Move Windows (Multi-Monitor Edition)


A modified version of the official GNOME Shell extension `auto-move-windows`. In addition to assigning applications to specific workspaces, this fork allows pinning applications to designated displays/monitors upon launch.

## Features

* **Workspace Assignment:** Automatically move target application windows to specified workspaces.
* **Multi-Monitor Support:** Select which physical display an application should launch on.
* **Native GNOME Preferences:** Monitor selector integrated directly into the extension's settings UI.

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone [https://github.com/De1tago/automove-display.git](https://github.com/De1tago/automove-display.git)
   ```

2. Copy or symlink the extension directory to your local GNOME Shell extensions path:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions
   cp -r automove-display ~/.local/share/gnome-shell/extensions/auto-move-windows@gnome-shell-extensions.gcampax.github.com
   ```


3. Compile the GSettings schemas:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/auto-move-windows@gnome-shell-extensions.gcampax.github.com/schemas/
   ```


4. Restart GNOME Shell (log out and log back in on Wayland, or press `Alt + F2`, type `r`, and hit `Enter` on X11).
5. Enable the extension via **GNOME Extensions** or CLI:
   ```bash
   gnome-extensions enable auto-move-windows@gnome-shell-extensions.gcampax.github.com
   ```



## Configuration

Open the extension settings via the **Extensions** app to add applications and configure their target workspace and display index.

