# IMDb

**Mode**: 🌐 Public (Browser) · **Domain**: `www.imdb.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli imdb search` | Search movies, TV shows, and people |
| `bycli imdb title` | Get movie or TV show details |
| `bycli imdb top` | IMDb Top 250 Movies |
| `bycli imdb trending` | IMDb Most Popular Movies |
| `bycli imdb person` | Get actor or director info |
| `bycli imdb reviews` | Get user reviews for a title |

## Usage Examples

```bash
# Search for a movie
bycli imdb search "inception" --limit 10

# Get movie details
bycli imdb title tt1375666

# Get TV series details (also accepts full URL)
bycli imdb title "https://www.imdb.com/title/tt0903747/"

# Top 250 movies
bycli imdb top --limit 20

# Currently trending movies
bycli imdb trending --limit 10

# Actor/director info with filmography
bycli imdb person nm0634240 --limit 5

# User reviews
bycli imdb reviews tt1375666 --limit 5

# JSON output
bycli imdb top --limit 5 -f json
```

## Prerequisites

- Chrome with Browser Bridge extension installed
- No login required (all data is public)
