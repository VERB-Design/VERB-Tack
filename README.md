# VERB-Tack

Figma-style comments on live prototypes. One script tag, one Netlify Function, comments stored in Netlify Blobs. No login.

Reviewers open a side drawer, click the element they mean, and type. Every comment gets a number that stays put, shows as a pin on the page and as a row in the drawer, and can be replied to and resolved. Closing the drawer hides the pins so the prototype reads clean.

## How it works

```
prototype site on Netlify
├── your pages            ← <script src=".../tack.js" defer>
├── netlify/functions/
│   └── tack.mjs         ← 3 lines, re-exports the handler from this package
└── Netlify Blobs store "tack"   ← one blob per comment, keyed by page
```

Each prototype keeps its own comments in its own site. Delete the site and the comments go with it. Nothing is shared between prototypes.

The embed script is served from the VERB-Tack site itself, so fixes to the UI reach every prototype on the next page load. The function is pinned per prototype through the package version.

## Add VERB-Tack to a prototype

The prototype must be hosted on Netlify. In the prototype repo:

```bash
npm init -y                                   # skip if package.json exists
npm install github:VERB-Design/VERB-Tack
npx verb-tack init
```

`init` writes `netlify/functions/tack.mjs` and, if there is no `netlify.toml`, a minimal one. If you already have a `netlify.toml`, make sure it has:

```toml
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
```

Add the script tag to your pages, usually in a shared header include:

```html
<script src="https://verb-tack.netlify.app/tack.js" defer></script>
```

In Netlify, under Site configuration → Environment variables, add:

```
TACK_ADMIN_KEY = <a long random string>
```

Deploy. Open the site and press **Shift+C**.

### Script tag options

| Attribute | Default | Purpose |
|---|---|---|
| `data-api` | `/api/tack` | Where the function lives. Change only if you deployed it elsewhere. |
| `data-page` | the pathname | Override the page identity. Useful for hash-routed prototypes where several states share one file. |
| `data-open` | `false` | Start with the drawer open. |

### Vendoring the script instead

If you would rather pin the UI with the prototype, copy it into your publish folder and point the tag at it:

```bash
npx verb-tack copy public      # or whatever your publish dir is
```

```html
<script src="/tack.js" defer></script>
```

Run the copy again after bumping the package.

## Using VERB-Tack

- **Pill** bottom-right shows the count of ongoing comments. Click it, or press Shift+C, to open the drawer.
- **New comment** turns the cursor into a crosshair. Click anywhere on the page. The composer appears in the drawer; the first time, it asks for a display name and remembers it.
- **Filter** the drawer and the pins by Ongoing, Resolved, or All. Ongoing is the default and the choice is remembered.
- **Click a row** to expand it: replies, a reply box, Resolve or Reopen, and Delete on comments you wrote.
- **Click a pin** to jump to its row. Click a row to scroll the page to its pin.
- **Copy summary** puts a plain-text list of every comment on the clipboard.
- **Esc** cancels placing. **Cmd/Ctrl+Enter** posts.

Comments anchor to the element under the click plus an offset inside it, so they follow the layout through responsive reflow. If the element is hidden at the current width, the row says so and the pin hides with it.

## Admin

Anyone can comment, reply, resolve, and reopen. Only the author of a comment, identified by a random token in their browser, can delete it. The admin key overrides that.

```bash
# export every comment on the site as JSON
curl -H "x-tack-admin: $TACK_ADMIN_KEY" https://your-site.netlify.app/api/tack/export

# delete a comment as admin
curl -X DELETE -H "x-tack-admin: $TACK_ADMIN_KEY" \
  "https://your-site.netlify.app/api/tack/comments/c_abc123?page=/rooms"
```

## API

All routes are under `/api/tack`. Bodies and responses are JSON.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/comments?page=/path` | | Sorted by number. |
| POST | `/comments` | `{ page, anchor, author, text }` | Returns the comment with its number. |
| PATCH | `/comments/:id` | `{ page, resolved?, reply?, text?, deleteReply? }` | `text` and `deleteReply` need the owner token or admin key. |
| DELETE | `/comments/:id?page=/path` | | Owner token or admin key. |
| GET | `/export` | | Admin key. Everything on the site, grouped by page. |
| GET | `/health` | | `{ ok, version }` |

Headers: `X-Tack-Token` (the browser's owner token, sent automatically by the embed) and `X-Tack-Admin`.

Limits: 2000 characters per comment or reply, 60 for a name, 30 writes per IP per 10 minutes.

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `TACK_ADMIN_KEY` | yes, for admin routes | Delete anything, export everything. |
| `TACK_ORIGINS` | no | Comma-separated extra origins allowed to call the API. Only needed if the embed runs on a different site than the function. |

## Local development

```bash
npm install
npx netlify-cli dev
```

Then open http://localhost:8888/demo.html. Netlify Dev provides a local Blobs store, so comments persist between reloads on your machine.

## Cost

Comments are about 1 KB each. Netlify does not meter Blobs storage separately; usage draws on the plan's monthly credits, and an internal review team uses single digits. The Free plan pauses a site when credits run out, so deploy client prototypes on a Personal or Pro account.

## Roadmap

- Approve stamp per page, carried over from the July prototype.
- Screenshot attachment on a comment.
- Email or Slack digest of new comments.

## License

MIT
