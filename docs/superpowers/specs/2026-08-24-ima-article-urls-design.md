# ima knowledge-base article URL adapter

## Goal

Provide a private byCLI command that reads one named or identified knowledge
base from the currently signed-in local ima application. The command enumerates
its folders and content, then returns each item with its title and public or
canonical URL where one exists.

## Command

```sh
bycli ima knowledge <knowledge-base-name-or-id> -f json
```

The command returns one row per article with this shape:

```json
{
  "knowledgeBaseId": "example-id",
  "knowledgeBase": "Example knowledge base",
  "folderPath": ["Folder"],
  "title": "Article title",
  "url": "https://example.com/article",
  "contentType": "公众号",
  "addedDate": "6/18"
}
```

`url`, `contentType`, and `addedDate` are `null` when ima does not expose the
corresponding value. PDF files, notes, and other non-web content remain in the
result with `url: null` so the output is an accurate inventory.

## Design

The adapter is a built-in command stored under `clis/ima/`. It reads the
signed-in ima account and Chromium Safe Storage items through the macOS
Keychain permission boundary, then calls the same read-only knowledge reader
API as the local ima application. It finds the requested knowledge base by
exact name or identifier, paginates every folder recursively, and uses ima's
`source_path` as the canonical article URL when the list response omits
`jump_url`.

The adapter emits only the visible metadata required for the inventory. It
normalizes web addresses by retaining identity-bearing query parameters and
removing volatile or secret-bearing parameters such as `sessionid` and
`pass_ticket`. It never exports article bodies, cookies, tokens, or credentials.

## Runtime flow

1. The user approves read access to `ima.copilot Safe Storage` and
   `com.tencent.ima.account` when macOS Keychain prompts.
2. The adapter decrypts ima's local extension cookies in memory and replaces
   stale token fields with the current native account tokens. Credentials are
   never printed or written to the workspace.
3. The command paginates all knowledge-base groups to resolve an exact name or
   ID, then paginates the root and every folder using ima's required page
   limits.
4. It records each item's folder path and normalizes `jump_url` or
   `source_path` into the public URL.
5. It emits deterministic JSON rows in discovery order.

## Failure handling

- macOS Keychain access is denied or times out: report that the two ima items
  must be allowed by the user.
- ima is not signed in or the local account tokens are absent: raise an
  actionable configuration error.
- the knowledge-base query matches no library: raise an empty-result
  error with the query.
- multiple library names match: raise an argument error that asks for the ID.
- a non-web item has no canonical address: retain it with `url: null`.
- no content is found after a successful traversal: raise an explicit
  empty-result error, not a fabricated row.

## Validation

- Unit tests cover URL normalization, row construction, missing URLs, and the
  required typed errors without driving the user's desktop.
- A live smoke check against `企业级AI应用落地实践` confirms 195 rows and
  195 URLs, split across root and folders as 8/37/26/22/102.
- A manual spot check compares sample rows against the visible ima library.

## Out of scope

- Exporting article text, attachments, account information, cookies, or API
  credentials. Credentials are used only in memory for ima's read-only API.
- Bypassing ima's disabled remote-debugging protection.
- Synchronizing results to a third-party service.
