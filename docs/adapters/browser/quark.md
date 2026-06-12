# Quark Drive

**Mode**: 🔐 Browser · **Domain**: `pan.quark.cn`

## Prerequisites

- [Browser Bridge extension](/guide/browser-bridge) installed
- Logged in to Quark Drive (`pan.quark.cn`) in Chrome

## Commands

| Command | Description |
|---------|-------------|
| `bycli quark ls [path]` | List files in your Quark Drive |
| `bycli quark mkdir <name>` | Create a folder |
| `bycli quark mv <fids>` | Move files to a folder |
| `bycli quark rename <fid>` | Rename a file or folder |
| `bycli quark rm <fids>` | Delete files |
| `bycli quark save <url>` | Save shared files to your Drive |
| `bycli quark share-tree <url>` | Get directory tree from a share link as nested JSON |

## Usage Examples

```bash
# List root directory
bycli quark ls

# List a specific folder with depth 3
bycli quark ls "Documents/Projects" --depth 3

# Create a folder in root
bycli quark mkdir "New Folder"

# Create a folder inside a specific parent (by path)
bycli quark mkdir "Sub Folder" --parent "Documents"

# Create a folder inside a specific parent (by fid)
bycli quark mkdir "Sub Folder" --parent-fid <fid>

# Move files to a folder
bycli quark mv "fid1,fid2" --to "Documents"

# Rename a file
bycli quark rename <fid> --name "new-name.txt"

# Delete files
bycli quark rm "fid1,fid2"

# Save all files from a share link
bycli quark save https://pan.quark.cn/s/abc123 --to "来自：分享"

# Save specific files by fid (get fids from share-tree)
bycli quark save https://pan.quark.cn/s/abc123 --to "My Folder" --fids "fid1,fid2" --stoken <stoken>

# Save to a specific folder by fid
bycli quark save https://pan.quark.cn/s/abc123 --to-fid <fid>

# Move files to a folder by fid
bycli quark mv "fid1,fid2" --to-fid <fid>

# Get full tree from a share link
bycli quark share-tree https://pan.quark.cn/s/abc123
```

## Notes

- `share-tree` returns a `stoken` value that is required when using `save --fids` to save specific files from a share link.
- `--to` resolves a folder path by name; `--to-fid` uses a folder ID directly. These flags cannot be combined.
