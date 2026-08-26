# Install & Usage

## Install

```bash
npm install -g defuddle-cli
```

Verify: `defuddle --version`

## Usage

### Clean a URL directly

```bash
defuddle https://example.com/article
```

Outputs clean markdown to stdout.

### Save to .raw/

```bash
defuddle https://example.com/article > .raw/articles/article-slug-$(date +%Y-%m-%d).md
```

### Add frontmatter after saving

```bash
SLUG="article-slug-$(date +%Y-%m-%d)"
{
  echo "---"
  echo "source_url: https://example.com/article"
  echo "fetched: $(date +%Y-%m-%d)"
  echo "---"
  echo ""
  defuddle https://example.com/article
} > .raw/articles/$SLUG.md
```

### Clean a local HTML file

```bash
defuddle page.html
```

## When to Use

Use: articles/blogs/docs from URLs with surrounding content, long articles on token budget.
Skip: clean markdown/PDF, dashboards/apps/structured data, defuddle not installed + short article.

## Fallback

If not installed: use WebFetch directly. Content is less clean but workable.

## Integration with /memo-ingest

`/memo-ingest` calls defuddle automatically if available when given a URL. Manual path: run save command above, then `/memo-ingest .raw/articles/[slug].md`.
