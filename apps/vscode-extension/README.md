# Folder Relay

Folder Relay synchronizes project files between local VS Code folders. A shared folder can contain source code, Markdown, CSV data, LaTeX and images. Each member works with real local files that editors, scripts, and compilers can use directly.

1. Open a local folder and click **Folder Relay 连接工作区** in the status bar, or run **LSW: Join Shared Project**.
2. In the connection form, enter the server address, workspace ID and token supplied by the host. The first member opens the existing project folder. Other members can join from empty folders to download the shared files.
3. Reopen the same folder to reconnect automatically. You can edit saved files offline. The extension retries when the connection returns and preserves copies when edits conflict.

The extension connects to a separately running collaboration server. A host can run it locally for a two-window test or provide a reachable encrypted address for other computers. Changes sync as saved file versions. Supported text files can merge non-overlapping edits; binary files sync as whole files and conflicting versions are preserved.

Folder Relay was previously named LaTeX Sync Workspace. The extension keeps its existing identity and the `LSW:` command prefix for upgrades.

The project mode automatically saves eligible editor changes and synchronizes files written by external tools, including AI tools. Each member can edit and compile their own local copy when peers are offline. Disjoint text edits merge when the clients reconnect. Overlapping changes are kept for review while the rest of the project keeps syncing.

## Legacy single-file mode

Open a local UTF-8 `.tex` file and run **LSW: Connect Single File (Legacy)**. Enter the server URL, document ID and workspace token. A mismatch requires confirmation and stores a local copy before the shared text is applied.

Edits in the native buffer are synchronized through Yjs. **Saved** means the full local Yjs update matches the digest committed by the server. Save the native file with Ctrl+S or VS Code Auto Save before compiling it locally.

Before asking an AI tool to write directly to disk, save the file and run **LSW: Prepare AI Edit**. LSW records the shared revision and imports the external write if that revision is still current. Unexpected writes and stale revisions pause synchronization and preserve the editor, disk and shared versions in local storage. The disk import command requires the 0.1.2 server.

**LSW: Review Conflict** opens a read-only comparison of the shared version and the external disk copy. After a reload, select the saved conflict by time. Merge the changes you want to keep into a still-connected editor and wait for **Saved**. In the paused window, disconnect LSW and use **File: Revert File** to reload the disk copy. Then reconnect, load the shared version and save the file.

**LSW: Show Sync Status** displays connection and synchronization state. **LSW: Disconnect** stops the session and keeps its local cache.
