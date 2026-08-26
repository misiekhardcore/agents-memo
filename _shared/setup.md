# Vault Setup & Configuration

Guide for bootstrapping and configuring the Obsidian vault for agent use.

## 1. Obsidian CLI Installation
agents-memo uses Obsidian CLI (1.12.7+).
- **Prerequisite**: Obsidian must be running with the vault open.
- **Linux (Flatpak)**: Invoke via `flatpak run md.obsidian.Obsidian --cli`. Recommended alias: `alias obsidian='flatpak run md.obsidian.Obsidian --cli'`.
- **Registration**: Register the vault once per machine:
  ```bash
  obsidian register vault=/absolute/path/to/vault
  ```
- **Verify**: `obsidian list vaults` should show the registered path.

## 2. Essential Plugins
|Plugin|Type|Purpose|
|-|-|-|
|**Bases**|Core|Powers `.base` DB views and `memo-obsidian-bases` skill. Required for dashboards.|
|**Templater**|Community|Resolves `<% tp... %>` syntax in `_templates/` for auto-populated frontmatter.|

## 3. Git Integration
Initialize git in the vault root for versioning and safety.
```bash
cd "$VAULT_PATH"
git init && git add -A && git commit -m "Initial vault scaffold"
```
- **Ignore**: `.gitignore` covers `workspace.json`, `.trash/`, and `.smart-connections/`.
- **Backup**: Optional remote backup via `git remote add origin <url>`.

## 4. Vault-Wide CSS/Styling
Custom callouts are defined in `.obsidian/snippets/vault-colors.css`.
- **Standard Callouts**: `[!contradiction]`, `[!gap]`, `[!key-insight]`, `[!stale]`.
- **Usage**: Use these in wiki pages to flag knowledge state without modifying the data model.
