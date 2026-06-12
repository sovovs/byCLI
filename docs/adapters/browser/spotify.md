# Spotify

**Mode**: 🔑 OAuth API · **Domains**: `accounts.spotify.com`, `api.spotify.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli spotify auth` | Authenticate with Spotify and store tokens locally |
| `bycli spotify status` | Show current playback status |
| `bycli spotify play [query]` | Resume playback or search-and-play a track |
| `bycli spotify pause` | Pause playback |
| `bycli spotify next` | Skip to the next track |
| `bycli spotify prev` | Skip to the previous track |
| `bycli spotify volume <0-100>` | Set playback volume |
| `bycli spotify search <query>` | Search Spotify tracks |
| `bycli spotify queue <query>` | Add a track to the playback queue |
| `bycli spotify shuffle <on|off>` | Toggle shuffle |
| `bycli spotify repeat <off|track|context>` | Set repeat mode |

## Usage Examples

```bash
# First-time setup
bycli spotify auth

# What is playing right now?
bycli spotify status

# Resume playback
bycli spotify play

# Search and immediately play a track
bycli spotify play "Numb Linkin Park"

# Search without playing
bycli spotify search "Daft Punk" --limit 5 -f json

# Queue a track
bycli spotify queue "Get Lucky"

# Playback controls
bycli spotify pause
bycli spotify next
bycli spotify prev
bycli spotify volume 35
bycli spotify shuffle on
bycli spotify repeat track
```

## Setup

1. Create a Spotify app at <https://developer.spotify.com/dashboard>
2. Add `http://127.0.0.1:8888/callback` to the app's Redirect URIs
3. Fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `~/.bycli/spotify.env`
4. Run `bycli spotify auth`

## Notes

- Browser Bridge is not required.
- Tokens are stored locally at `~/.bycli/spotify-tokens.json`.
- Playback commands work best when you already have an active Spotify device/session.
